import { createHash } from "node:crypto";
import * as Sentry from "@sentry/node";
import type { Db } from "mongodb";
import {
  BackboardApiError,
  BackboardClient,
  BackboardConfigurationError,
  getBackboardSettings,
} from "@/lib/integrations/backboard-client";
import { MongoBackboardRepository } from "@/lib/repositories/mongodb-backboard-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { sentryIsEnabled } from "@/lib/observability/sentry-privacy";

export class GroupBackboardMemoryError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "GroupBackboardMemoryError";
  }
}

async function tracedBackboardOperation<T>(
  name: "backboard.retrieve" | "backboard.sync",
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await Sentry.startSpan({ name, op: "db" }, operation);
  } catch (error) {
    if (sentryIsEnabled()) {
      Sentry.withScope((scope) => {
        scope.setTag("category", "backboard_operation_failure");
        Sentry.captureException(new Error("Backboard operation failed"));
      });
    }
    throw error;
  }
}

function client(provider?: BackboardClient) {
  if (provider) return provider;
  const settings = getBackboardSettings();
  if (!settings) throw new BackboardConfigurationError();
  return new BackboardClient(settings);
}

function contentForCorrection(type: string, value: string): string {
  return `Group-confirmed ${type} reference: ${value.trim()}`;
}

function memorySourceKey(groupId: string, correctionId: string): string {
  return createHash("sha256").update(`${groupId}\0${correctionId}`).digest("hex");
}

async function awaitProviderOperation(
  provider: BackboardClient,
  repository: MongoBackboardRepository,
  input: { groupId: string; correctionId: string; operationId: string },
): Promise<Record<string, unknown>> {
  return tracedBackboardOperation("backboard.sync", () =>
    provider.waitForOperation(input.operationId, async (status) => {
      await repository.updateMemoryState({
        groupId: input.groupId,
        correctionId: input.correctionId,
        status: status === "pending" || status === "queued" ? "pending" : "running",
        operationId: input.operationId,
      });
    }),
  );
}

export async function enableGroupBackboard(input: {
  database: Db;
  groupId: string;
  userId: string;
  provider?: BackboardClient;
}): Promise<"enabled" | "already_enabled" | "provisioning"> {
  const repository = new MongoBackboardRepository(input.database);
  const claim = await repository.claimEnable(input.groupId, input.userId);
  if (claim === "enabled") return "already_enabled";
  if (claim === "busy") return "provisioning";
  let assistantId: string | null = null;
  try {
    const backboard = client(input.provider);
    const groupKey = createHash("sha256").update(input.groupId).digest("hex").slice(0, 10);
    assistantId = await tracedBackboardOperation(
      "backboard.sync",
      () => backboard.createGroupAssistant(groupKey),
    );
    await repository.completeEnable(input.groupId, input.userId, assistantId);
    return "enabled";
  } catch (error) {
    await repository.failEnable(input.groupId, assistantId);
    throw error;
  }
}

export async function disableGroupBackboard(input: {
  database: Db;
  groupId: string;
  provider?: BackboardClient;
}): Promise<void> {
  const repository = new MongoBackboardRepository(input.database);
  const current = await repository.findIntegration(input.groupId);
  if (!current || current.status === "disabled") return;
  if (current.status === "failed" && !current.assistantId) {
    await repository.deleteGroupData(input.groupId);
    return;
  }
  if (current.status === "creating") {
    throw new GroupBackboardMemoryError(409, "Backboard setup is still in progress");
  }
  const integration = current.status === "disabling"
    ? current
    : await repository.beginDisable(input.groupId);
  if (!integration) {
    throw new GroupBackboardMemoryError(409, "Backboard settings changed; reload and retry");
  }
  if (integration.assistantId) {
    const provider = client(input.provider);
    const assistantId = integration.assistantId;
    await tracedBackboardOperation(
      "backboard.sync",
      () => provider.deleteAssistant(assistantId),
    );
  }
  await repository.completeDisable(input.groupId);
}

export async function publishConfirmedCorrection(input: {
  database: Db;
  groupId: string;
  momentId: string;
  correctionId: string;
  provider?: BackboardClient;
}): Promise<"synced" | "already_synced"> {
  const memoryRepository = new MongoMemoryRepository(input.database);
  const backboardRepository = new MongoBackboardRepository(input.database);
  const integration = await backboardRepository.findIntegration(input.groupId);
  if (integration?.status !== "enabled" || !integration.assistantId) {
    throw new GroupBackboardMemoryError(409, "Group Backboard memory is not enabled");
  }
  const assistantId = integration.assistantId;
  const moment = await memoryRepository.findMoment(input.groupId, input.momentId);
  const correction = moment?.corrections?.find((item) => item.id === input.correctionId);
  if (!moment || moment.status !== "confirmed" || !correction) {
    throw new GroupBackboardMemoryError(409, "Only a correction on a confirmed Moment can be shared");
  }
  const eligible = await memoryRepository.findEligibleGroupVisibleFragmentsByIds(
    input.groupId,
    [correction.fragmentId],
  );
  if (eligible.length !== 1) {
    throw new GroupBackboardMemoryError(409, "Correction source is no longer eligible for sharing");
  }

  const existing = await backboardRepository.findMemoryLink(input.groupId, correction.id);
  if (existing?.status === "synced" && existing.memoryId) {
    if (existing.momentId !== moment.id) {
      await backboardRepository.upsertMemoryLink({
        ...existing,
        momentId: moment.id,
        fragmentId: correction.fragmentId,
        correctionType: correction.type,
        content: contentForCorrection(correction.type, correction.value),
      });
    }
    return "already_synced";
  }
  if (
    existing?.status === "failed" &&
    !existing.operationId &&
    !existing.memoryId
  ) {
    throw new GroupBackboardMemoryError(
      409,
      "The previous Backboard request has an unknown outcome; do not retry until it is reconciled",
    );
  }
  if (existing?.operationKind === "delete" || existing?.status === "deleting") {
    await deleteCorrectionMemory({
      database: input.database,
      groupId: input.groupId,
      correctionId: correction.id,
      provider: input.provider,
    });
  }
  const current = await backboardRepository.findMemoryLink(input.groupId, correction.id);
  const provider = client(input.provider);
  if (
    current &&
    ((current.status === "running" && !current.operationId) || current.status === "deleting")
  ) {
    throw new GroupBackboardMemoryError(409, "The Backboard correction update is already in progress");
  }
  if (current?.operationId && current.operationKind === "add" && current.status !== "synced") {
    const claimed = await backboardRepository.claimPendingMemoryOperation({
      groupId: input.groupId,
      correctionId: correction.id,
      operationId: current.operationId,
      operationKind: "add",
    });
    if (!claimed) {
      throw new GroupBackboardMemoryError(409, "The Backboard correction update is already in progress");
    }
    try {
      const operation = await awaitProviderOperation(provider, backboardRepository, {
        groupId: input.groupId,
        correctionId: correction.id,
        operationId: current.operationId,
      });
      const memoryId = typeof operation.memory_id === "string"
        ? operation.memory_id
        : typeof operation.id === "string"
          ? operation.id
          : current.memoryId;
      if (!memoryId) throw new BackboardApiError(null);
      await backboardRepository.upsertMemoryLink({
        ...current,
        memoryId,
        operationId: null,
        operationKind: null,
        status: "synced",
      });
      return "synced";
    } catch (error) {
      await backboardRepository.updateMemoryState({
        groupId: input.groupId,
        correctionId: correction.id,
        status: "failed",
      });
      throw error;
    }
  }
  if (current?.status === "failed" && current.memoryId && current.operationKind === "add") {
    await backboardRepository.updateMemoryState({
      groupId: input.groupId,
      correctionId: correction.id,
      status: "synced",
      operationId: null,
      operationKind: null,
    });
    return "synced";
  }
  if (current) {
    throw new GroupBackboardMemoryError(409, "The Backboard correction status cannot be safely retried");
  }

  const link = {
    groupId: input.groupId,
    momentId: moment.id,
    correctionId: correction.id,
    fragmentId: correction.fragmentId,
    correctionType: correction.type,
    content: contentForCorrection(correction.type, correction.value),
    memoryId: null,
    operationId: null,
    operationKind: null,
    status: "running" as const,
  };
  const claimed = await backboardRepository.claimNewMemoryLink(link);
  if (!claimed) {
    throw new GroupBackboardMemoryError(409, "The Backboard correction update is already in progress");
  }
  try {
    const latestIntegration = await backboardRepository.findIntegration(input.groupId);
    if (
      latestIntegration?.status !== "enabled" ||
      latestIntegration.assistantId !== integration.assistantId
    ) {
      await backboardRepository.deleteMemoryLink(input.groupId, correction.id);
      throw new GroupBackboardMemoryError(409, "Backboard group memory was disabled before the correction could be shared");
    }
    const result = await tracedBackboardOperation("backboard.sync", () =>
      provider.addMemory({
        assistantId,
        content: link.content,
        sourceKey: memorySourceKey(input.groupId, correction.id),
        correctionType: correction.type,
      }),
    );
    let memoryId = result.memoryId || null;
    if (result.operationId) {
      await backboardRepository.updateMemoryState({
        groupId: input.groupId,
        correctionId: correction.id,
        status: "pending",
        memoryId,
        operationId: result.operationId,
        operationKind: "add",
      });
      const operation = await awaitProviderOperation(provider, backboardRepository, {
        groupId: input.groupId,
        correctionId: correction.id,
        operationId: result.operationId,
      });
      memoryId ??= typeof operation.memory_id === "string"
        ? operation.memory_id
        : typeof operation.id === "string"
          ? operation.id
          : null;
    }
    if (!memoryId) throw new BackboardApiError(null);
    const finalIntegration = await backboardRepository.findIntegration(input.groupId);
    if (
      finalIntegration?.status !== "enabled" ||
      finalIntegration.assistantId !== assistantId
    ) {
      const deleteOperationId = await tracedBackboardOperation(
        "backboard.sync",
        () => provider.deleteMemory({
          assistantId,
          memoryId,
        }),
      );
      if (deleteOperationId) {
        await tracedBackboardOperation(
          "backboard.sync",
          () => provider.waitForOperation(deleteOperationId, async () => undefined),
        );
      }
      await backboardRepository.deleteMemoryLink(input.groupId, correction.id);
      throw new GroupBackboardMemoryError(409, "Backboard group memory was disabled while the correction was being shared");
    }
    await backboardRepository.updateMemoryState({
      groupId: input.groupId,
      correctionId: correction.id,
      memoryId,
      operationId: null,
      operationKind: null,
      status: "synced",
    });
    return "synced";
  } catch (error) {
    await backboardRepository.updateMemoryState({
      groupId: input.groupId,
      correctionId: correction.id,
      status: "failed",
    });
    throw error;
  }
}

export async function deleteCorrectionMemory(input: {
  database: Db;
  groupId: string;
  correctionId: string;
  provider?: BackboardClient;
}): Promise<void> {
  const repository = new MongoBackboardRepository(input.database);
  const link = await repository.findMemoryLink(input.groupId, input.correctionId);
  if (!link) return;
  const integration = await repository.findIntegration(input.groupId);
  const assistantId = integration?.assistantId;
  if (!assistantId) {
    throw new GroupBackboardMemoryError(503, "Backboard correction cleanup cannot be verified");
  }
  const provider = client(input.provider);
  if (link.operationId && link.operationKind === "delete") {
    const claimed = await repository.claimMemoryDeletion({
      groupId: input.groupId,
      correctionId: link.correctionId,
      operationId: link.operationId,
    });
    if (!claimed) {
      throw new GroupBackboardMemoryError(409, "The Backboard memory deletion is already in progress");
    }
    await awaitProviderOperation(provider, repository, {
      groupId: input.groupId,
      correctionId: link.correctionId,
      operationId: link.operationId,
    });
    await repository.deleteMemoryLink(input.groupId, input.correctionId);
    return;
  }
  const claimed = await repository.claimMemoryDeletion({
    groupId: input.groupId,
    correctionId: link.correctionId,
  });
  if (!claimed) {
    throw new GroupBackboardMemoryError(409, "The Backboard memory deletion is already in progress");
  }
  let memoryId = link.memoryId;
  try {
    if (!memoryId && link.operationId && link.operationKind === "add") {
      const operation = await awaitProviderOperation(provider, repository, {
        groupId: input.groupId,
        correctionId: link.correctionId,
        operationId: link.operationId,
      });
      memoryId = typeof operation.memory_id === "string"
        ? operation.memory_id
        : typeof operation.id === "string"
          ? operation.id
          : null;
    }
  } catch (error) {
    await repository.updateMemoryState({
      groupId: input.groupId,
      correctionId: input.correctionId,
      status: "failed",
    });
    throw error;
  }
  if (!memoryId) {
    await repository.updateMemoryState({
      groupId: input.groupId,
      correctionId: input.correctionId,
      status: "failed",
    });
    throw new GroupBackboardMemoryError(409, "Backboard memory status is unresolved; retry after provider recovery");
  }
  await repository.updateMemoryState({
    groupId: input.groupId,
    correctionId: link.correctionId,
    status: "deleting",
    memoryId,
    operationId: null,
    operationKind: "delete",
  });
  try {
    const operationId = await tracedBackboardOperation(
      "backboard.sync",
      () => provider.deleteMemory({ assistantId, memoryId }),
    );
    if (operationId) {
      await repository.updateMemoryState({
        groupId: input.groupId,
        correctionId: input.correctionId,
        status: "pending",
        operationId,
        operationKind: "delete",
      });
      await awaitProviderOperation(provider, repository, {
        groupId: input.groupId,
        correctionId: input.correctionId,
        operationId,
      });
    }
    await repository.deleteMemoryLink(input.groupId, input.correctionId);
  } catch (error) {
    await repository.updateMemoryState({
      groupId: input.groupId,
      correctionId: input.correctionId,
      status: "failed",
      operationKind: "delete",
    });
    throw error;
  }
}

export async function deleteFragmentBackboardMemories(input: {
  database: Db;
  groupId: string;
  fragmentId: string;
}): Promise<void> {
  const repository = new MongoBackboardRepository(input.database);
  const links = await repository.findMemoryLinksForFragment(input.groupId, input.fragmentId);
  const memoryRepository = new MongoMemoryRepository(input.database);
  const momentIds = await memoryRepository.findMomentIdsContainingEvidence(input.groupId, input.fragmentId);
  const linksByCorrectionId = new Map(links.map((link) => [link.correctionId, link]));
  for (const momentId of momentIds) {
    for (const link of await repository.findMemoryLinksForMoment(input.groupId, momentId)) {
      linksByCorrectionId.set(link.correctionId, link);
    }
  }
  for (const link of linksByCorrectionId.values()) {
    await deleteCorrectionMemory({
      database: input.database,
      groupId: input.groupId,
      correctionId: link.correctionId,
    });
  }
}

export async function searchConfirmedGroupMemories(input: {
  database: Db;
  groupId: string;
  query: string;
  limit?: number;
  provider?: BackboardClient;
}): Promise<Array<{
  memoryId: string;
  momentId: string;
  correctionType: string;
  content: string;
}>> {
  const repository = new MongoBackboardRepository(input.database);
  const integration = await repository.findIntegration(input.groupId);
  if (integration?.status !== "enabled" || !integration.assistantId || !input.query.trim()) return [];
  const assistantId = integration.assistantId;
  const provider = client(input.provider);
  let searchResults;
  try {
    searchResults = await tracedBackboardOperation("backboard.retrieve", () =>
      provider.searchMemories({
        assistantId,
        query: input.query.slice(0, 500),
        limit: Math.min(Math.max(input.limit ?? 3, 1), 3),
      }),
    );
  } catch (error) {
    if (!(error instanceof BackboardApiError) && !(error instanceof BackboardConfigurationError)) {
      throw error;
    }
    console.error(
      "Backboard memory retrieval failed",
      error instanceof BackboardApiError ? error.statusCode ?? "network_error" : "configuration_error",
    );
    return [];
  }
  const links = await repository.findSyncedMemoryIds(
    input.groupId,
    searchResults.map((memory) => memory.id),
  );
  const linkByMemoryId = new Map(links.map((link) => [link.memoryId, link]));
  const memoryRepository = new MongoMemoryRepository(input.database);
  const verified = [];
  for (const memory of searchResults) {
    const link = linkByMemoryId.get(memory.id);
    if (!link || link.content !== memory.content) continue;
    const moment = await memoryRepository.findMoment(input.groupId, link.momentId);
    if (
      !moment ||
      moment.status !== "confirmed" ||
      !moment.corrections?.some((item) =>
        item.id === link.correctionId && item.fragmentId === link.fragmentId,
      )
    ) continue;
    const eligible = await memoryRepository.findEligibleGroupVisibleFragmentsByIds(
      input.groupId,
      [link.fragmentId],
    );
    if (eligible.length !== 1) continue;
    verified.push({
      memoryId: memory.id,
      momentId: moment.id,
      correctionType: link.correctionType,
      content: link.content,
    });
    if (verified.length >= Math.min(input.limit ?? 3, 3)) break;
  }
  return verified;
}
