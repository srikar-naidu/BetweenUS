import { createHash } from "node:crypto";
import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { FragmentInputError, validateTextFragment } from "@/lib/ingestion/fragment-validation";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const repository = new MongoMemoryRepository(database);
    const fragments = await repository.findMemberVisibleFragments(groupId, session.user.id);
    const statuses = await new MongoIngestionRepository(database).latestProcessingStatusByFragmentIds(
      groupId,
      fragments.map((fragment) => fragment.id),
    );

    return Response.json(
      {
        fragments: fragments.map(({ storageUri: _storageUri, ...fragment }) => ({
          ...fragment,
          processingJobStatus: fragment.aiProcessingConsent ? statuses.get(fragment.id) ?? null : null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    const input = validateTextFragment(body);
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const fragmentId = createHash("sha256")
      .update(`${groupId}\0${session.user.id}\0${requestId}`)
      .digest("hex");

    const database = await getMongoDatabase();
    const memoryRepository = new MongoMemoryRepository(database);
    const ingestionRepository = new MongoIngestionRepository(database);
    const existingFragment = await memoryRepository.findFragmentById(groupId, fragmentId);
    if (
      existingFragment &&
      (existingFragment.authorUserId !== session.user.id ||
        existingFragment.type !== "text" ||
        existingFragment.textContent !== input.textContent ||
        existingFragment.capturedAt.getTime() !== input.capturedAt.getTime() ||
        existingFragment.capturedTimeZone !== input.capturedTimeZone ||
        existingFragment.visibility !== input.visibility ||
        existingFragment.aiProcessingConsent !== input.aiProcessingConsent)
    ) {
      return Response.json({ error: "Idempotency key was already used for different text" }, { status: 409 });
    }
    if (existingFragment) {
      const existingJob = await ingestionRepository.findProcessingJob(
        groupId,
        `ingest:${groupId}:${fragmentId}:${existingFragment.processingVersion}`,
      );
      const { storageUri: _storageUri, ...visibleFragment } = existingFragment;
      return Response.json({
        fragment: {
          ...visibleFragment,
          processingJobStatus: existingFragment.aiProcessingConsent ? existingJob?.status ?? null : null,
        },
        jobId: existingFragment.aiProcessingConsent ? existingJob?.id ?? null : null,
        workflowId: existingFragment.aiProcessingConsent ? existingJob?.id ?? null : null,
        processingStatus: existingFragment.aiProcessingConsent ? existingJob?.status ?? null : null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const processingVersion = input.aiProcessingConsent
      ? `${FRAGMENT_ANALYSIS_VERSION}-${Date.now()}`
      : FRAGMENT_ANALYSIS_VERSION;
    const fragment = await memoryRepository.createFragment({
      id: fragmentId,
      groupId,
      authorUserId: session.user.id,
      type: "text",
      storageUri: null,
      caption: null,
      textContent: input.textContent,
      source: "text",
      capturedAt: input.capturedAt,
      capturedTimeZone: input.capturedTimeZone,
      visibility: input.visibility,
      aiProcessingConsent: input.aiProcessingConsent,
      processingVersion,
    });
    if (!input.aiProcessingConsent) {
      const { storageUri: _storageUri, ...visibleFragment } = fragment;
      return Response.json(
        {
          fragment: { ...visibleFragment, processingJobStatus: null },
          jobId: null,
          workflowId: null,
          processingStatus: null,
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }
    const job = await ingestionRepository.upsertProcessingJob({
      groupId,
      fragmentId: fragment.id,
      jobType: "ingest",
      processingVersion: fragment.processingVersion,
    });
    const workflowId = job.id;
    const { storageUri: _storageUri, ...visibleFragment } = fragment;
    return Response.json(
      {
        fragment: { ...visibleFragment, processingJobStatus: job.status },
        jobId: job.id,
        workflowId,
        processingStatus: job.status,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof FragmentInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}