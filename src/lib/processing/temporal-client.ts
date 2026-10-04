import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { StoryReconstructionJob } from "@/lib/domain/memory";
import type { ProcessingJob } from "@/lib/repositories/mongodb-ingestion-repository";

export interface TemporalSettings {
  address: string;
  namespace: string;
  taskQueue: string;
  apiKey?: string;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export class TemporalConfigurationError extends Error {
  constructor() {
    super("Temporal processing is not configured");
    this.name = "TemporalConfigurationError";
  }
}

export function getTemporalSettings(environment: RuntimeEnvironment = process.env): TemporalSettings | null {
  const address = environment.TEMPORAL_ADDRESS?.trim();
  const namespace = environment.TEMPORAL_NAMESPACE?.trim();
  if (!address || !namespace) return null;
  return {
    address,
    namespace,
    taskQueue: environment.TEMPORAL_TASK_QUEUE?.trim() || "between-us-processing",
    ...(environment.TEMPORAL_API_KEY ? { apiKey: environment.TEMPORAL_API_KEY } : {}),
  };
}

interface TemporalClientCache {
  client?: Client;
  connection?: Connection;
  pending?: Promise<Client>;
}

const globalForTemporal = globalThis as typeof globalThis & {
  betweenUsTemporal?: TemporalClientCache;
};
const cache = (globalForTemporal.betweenUsTemporal ??= {});

export async function getTemporalClient(): Promise<{ client: Client; settings: TemporalSettings }> {
  const settings = getTemporalSettings();
  if (!settings) throw new TemporalConfigurationError();
  if (cache.client) return { client: cache.client, settings };

  cache.pending ??= (async () => {
    const connection = await Connection.connect({
      address: settings.address,
      ...(settings.apiKey
        ? { tls: true, apiKey: settings.apiKey }
        : process.env.TEMPORAL_TLS === "true"
          ? { tls: true }
          : {}),
    });
    cache.connection = connection;
    return new Client({ connection, namespace: settings.namespace });
  })();
  const pending = cache.pending;
  try {
    cache.client = await pending;
    return { client: cache.client, settings };
  } catch (error) {
    if (cache.pending === pending) cache.pending = undefined;
    throw error;
  }
}

export async function startFragmentWorkflow(
  job: ProcessingJob,
  workflowType: "processFragmentWorkflow" | "deleteFragmentWorkflow" | "transcribeVoiceWorkflow",
): Promise<string> {
  return startWorkflow(job, workflowType);
}

export async function startMomentReconstructionWorkflow(
  job: ProcessingJob,
  requesterUserId: string,
): Promise<string> {
  if (job.jobType !== "reconstruct_moment") {
    throw new TypeError("Moment reconstruction workflows require a reconstruction job");
  }
  return startWorkflow(job, "reconstructMomentWorkflow", requesterUserId);
}

export async function startStoryReconstructionWorkflow(
  job: StoryReconstructionJob,
): Promise<string> {
  const { client, settings } = await getTemporalClient();
  const workflowId = `between-us-story-${job.id}`;
  try {
    await client.workflow.start("reconstructStoryWorkflow", {
      workflowId,
      taskQueue: settings.taskQueue,
      args: [{
        jobId: job.id,
        groupId: job.groupId,
        requesterUserId: job.requesterUserId,
      }],
      workflowExecutionTimeout: "30 minutes",
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  return workflowId;
}

async function startWorkflow(
  job: ProcessingJob,
  workflowType: "processFragmentWorkflow" | "deleteFragmentWorkflow" | "reconstructMomentWorkflow" | "transcribeVoiceWorkflow",
  requesterUserId?: string,
): Promise<string> {
  const { client, settings } = await getTemporalClient();
  const workflowId = `between-us-${job.id}-attempt-${job.attemptCount + 1}`;
  try {
    await client.workflow.start(workflowType, {
      workflowId,
      taskQueue: settings.taskQueue,
      args: [{
        jobId: job.id,
        groupId: job.groupId,
        fragmentId: job.fragmentId,
        ...(workflowType === "reconstructMomentWorkflow" && requesterUserId
          ? { requesterUserId }
          : {}),
      }],
      workflowExecutionTimeout: "30 minutes",
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  return workflowId;
}
