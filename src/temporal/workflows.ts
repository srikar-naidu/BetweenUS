import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities";

export interface FragmentWorkflowInput {
  jobId: string;
  groupId: string;
  fragmentId: string;
}

const runActivity = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

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
