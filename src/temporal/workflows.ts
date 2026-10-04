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
      errorCategory: "fragment_ingestion_failed",
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
