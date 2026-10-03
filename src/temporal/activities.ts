import { ApplicationFailure } from "@temporalio/activity";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { deletePrivateObject } from "@/lib/storage/r2-object-store";

export async function markProcessingJobStarted(input: {
  jobId: string;
  workflowId: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "processing";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobStarted({ id: input.jobId, workflowId: input.workflowId });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function verifyIngestedFragment(input: { groupId: string; fragmentId: string }): Promise<void> {
  const repository = new MongoMemoryRepository(await getMongoDatabase());
  const fragment = await repository.findFragmentById(input.groupId, input.fragmentId);
  if (!fragment || fragment.deletionState !== "active") {
    throw ApplicationFailure.nonRetryable("Fragment is unavailable for ingestion", "FragmentUnavailable");
  }
}

export async function markProcessingJobSucceeded(input: {
  jobId: string;
  outputRef: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "processed";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobSucceeded({ id: input.jobId, outputRef: input.outputRef });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function markProcessingJobFailed(input: {
  jobId: string;
  errorCategory: string;
  groupId?: string;
  fragmentId?: string;
  fragmentStatus?: "rejected";
}): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  await repository.markProcessingJobFailed({ id: input.jobId, errorMessage: input.errorCategory });
  if (input.fragmentStatus && input.groupId && input.fragmentId) {
    await new MongoMemoryRepository(database).updateFragmentStatus(
      input.groupId,
      input.fragmentId,
      input.fragmentStatus,
    );
  }
}

export async function deleteStoredFragment(input: { groupId: string; fragmentId: string }): Promise<void> {
  const database = await getMongoDatabase();
  const repository = new MongoIngestionRepository(database);
  const fragment = await repository.findFragmentForCleanup(input.groupId, input.fragmentId);
  if (!fragment) return;
  if (fragment.source === "upload" && fragment.storageUri) {
    await deletePrivateObject(fragment.storageUri);
  }
  await repository.markFragmentDeletionComplete(input.groupId, input.fragmentId);
}
