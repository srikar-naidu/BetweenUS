import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities";

export interface FragmentWorkflowInput {
  jobId: string;
  groupId: string;
  fragmentId: string;
}

export interface MomentReconstructionWorkflowInput extends FragmentWorkflowInput {
  requesterUserId: string;
}

export interface StoryReconstructionWorkflowInput {
  jobId: string;
  groupId: string;
  requesterUserId: string;
}

const runActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

const inferenceActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "6 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
  },
});

const reconstructionActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
    maximumAttempts: 2,
  },
});

const transcriptionActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

const storyActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumInterval: "30 seconds",
    maximumAttempts: 2,
  },
});

function fragmentFailureCategory(error: unknown): string {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let depth = 0; pending.length && depth < 12; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const record = current as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const type = typeof record.type === "string" ? record.type : "";
    const message = typeof record.message === "string" ? record.message : "";
    const descriptor = `${name} ${type} ${message}`.toLowerCase();
    if (descriptor.includes("could not reach the configured gemma runtime") ||
        (descriptor.includes("gemmaprovidererror") && descriptor.includes("ollama returned http"))) {
      return "gemma_runtime_unavailable";
    }
    if (descriptor.includes("fragmentanalysisvalidationerror") ||
        descriptor.includes("ollama response has no message content") ||
        descriptor.includes("ollama message content is not valid json")) {
      return "gemma_output_invalid";
    }
    if (
      descriptor.includes("fragmentunavailable") ||
      descriptor.includes("unsupportedfragmenttype") ||
      descriptor.includes("fragmentconsentrevoked") ||
      descriptor.includes("mediasourceunavailable") ||
      descriptor.includes("mediasourcechanged") ||
      descriptor.includes("fragmentelegibilitychanged")
    ) {
      return "fragment_source_unavailable";
    }
    if ("cause" in record) pending.push(record.cause);
  }
  return "fragment_ingestion_failed";
}

export async function transcribeVoiceWorkflow(input: FragmentWorkflowInput): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  try {
    await runActivity.markProcessingJobStarted({
      jobId: input.jobId,
      workflowId,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: "processing",
    });
    await transcriptionActivity.transcribeVoiceNote({
      groupId: input.groupId,
      fragmentId: input.fragmentId,
    });
    await runActivity.markProcessingJobSucceeded({
      jobId: input.jobId,
      outputRef: input.fragmentId,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: "processed",
    });
  } catch (error) {
    await runActivity.markProcessingJobFailed({
      jobId: input.jobId,
      errorCategory: "voice_transcription_failed",
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: "rejected",
    });
    throw error;
  }
}

export async function processFragmentWorkflow(input: FragmentWorkflowInput): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  try {
    await runActivity.markProcessingJobStarted({
      jobId: input.jobId,
      workflowId,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: "processing",
    });
    await runActivity.verifyIngestedFragment({ groupId: input.groupId, fragmentId: input.fragmentId });
    const analysis = await inferenceActivity.analyzeFragment({
      groupId: input.groupId,
      fragmentId: input.fragmentId,
    });
    await runActivity.markProcessingJobSucceeded({
      jobId: input.jobId,
      outputRef: analysis?.analysisId ?? input.fragmentId,
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: analysis?.requiresReview ? "needs_review" : "processed",
    });
  } catch (error) {
    await runActivity.markProcessingJobFailed({
      jobId: input.jobId,
      errorCategory: fragmentFailureCategory(error),
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      fragmentStatus: "rejected",
    });
    throw error;
  }
}

export async function deleteFragmentWorkflow(input: FragmentWorkflowInput): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  try {
    await runActivity.markProcessingJobStarted({ jobId: input.jobId, workflowId });
    await runActivity.deleteStoredFragment({ groupId: input.groupId, fragmentId: input.fragmentId });
    await runActivity.markProcessingJobSucceeded({ jobId: input.jobId, outputRef: input.fragmentId });
  } catch (error) {
    await runActivity.markProcessingJobFailed({ jobId: input.jobId, errorCategory: "fragment_deletion_failed" });
    throw error;
  }
}

export async function reconstructMomentWorkflow(
  input: MomentReconstructionWorkflowInput,
): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  try {
    await runActivity.markProcessingJobStarted({ jobId: input.jobId, workflowId });
    const momentId = await reconstructionActivity.reconstructMomentForFragment({
      groupId: input.groupId,
      fragmentId: input.fragmentId,
      requesterUserId: input.requesterUserId,
      momentId: input.jobId,
    });
    await runActivity.markProcessingJobSucceeded({
      jobId: input.jobId,
      outputRef: momentId,
    });
  } catch (error) {
    await runActivity.markProcessingJobFailed({
      jobId: input.jobId,
      errorCategory: "moment_reconstruction_failed",
    });
    throw error;
  }
}

export async function reconstructStoryWorkflow(
  input: StoryReconstructionWorkflowInput,
): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  try {
    await storyActivity.markStoryJobStarted({
      jobId: input.jobId,
      groupId: input.groupId,
      workflowId,
    });
    const result = await storyActivity.reconstructStoryForGroup({
      groupId: input.groupId,
      requesterUserId: input.requesterUserId,
      storyId: `story-${input.jobId}`,
    });
    await storyActivity.markStoryJobSucceeded({
      jobId: input.jobId,
      groupId: input.groupId,
      storyId: result.storyId,
      outcome: result.outcome,
    });
  } catch (error) {
    await storyActivity.markStoryJobFailed({
      jobId: input.jobId,
      groupId: input.groupId,
      errorCategory: "story_reconstruction_failed",
    });
    throw error;
  }
}
