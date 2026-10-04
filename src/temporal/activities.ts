import { ApplicationFailure } from "@temporalio/activity";
import { createHash } from "node:crypto";
import { FRAGMENT_ANALYSIS_VERSION, generateFragmentAnalysis } from "@/lib/ai/fragment-analysis";
import { OllamaGemmaProvider } from "@/lib/ai/gemma-provider";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { indexEligibleFragmentAnalysis } from "@/lib/retrieval/index-fragment-analysis";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";

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
  if (fragment.source !== "text" || fragment.type !== "text") {
    throw ApplicationFailure.nonRetryable("Only text fragments are currently supported", "UnsupportedFragmentType");
  }
}

export async function analyzeTextFragment(input: {
  groupId: string;
  fragmentId: string;
}): Promise<string | null> {
  const database = await getMongoDatabase();
  const memory = new MongoMemoryRepository(database);
  const fragment = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (!fragment || fragment.deletionState !== "active") {
    throw ApplicationFailure.nonRetryable("Fragment is unavailable for analysis", "FragmentUnavailable");
  }
  if (fragment.source !== "text" || fragment.type !== "text") {
    throw ApplicationFailure.nonRetryable("Only text fragments are currently supported", "UnsupportedFragmentType");
  }
  if (!fragment.aiProcessingConsent || !fragment.textContent) return null;

  const analysisRepository = new MongoFragmentAnalysisRepository(database);
  const provider = new OllamaGemmaProvider();
  const sourceTextSha256 = createHash("sha256").update(fragment.textContent).digest("hex");
  const existingAnalysis = await analysisRepository.find(
    input.groupId,
    input.fragmentId,
    FRAGMENT_ANALYSIS_VERSION,
  );
  const analysis = existingAnalysis &&
      existingAnalysis.modelVersion === provider.modelVersion &&
      existingAnalysis.sourceTextSha256 === sourceTextSha256
    ? existingAnalysis
    : await generateFragmentAnalysis(fragment, provider);
  const latest = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (
    !latest ||
    latest.deletionState !== "active" ||
    !latest.aiProcessingConsent ||
    latest.textContent !== fragment.textContent ||
    latest.visibility !== fragment.visibility
  ) {
    throw ApplicationFailure.nonRetryable("Fragment eligibility changed during analysis", "FragmentEligibilityChanged");
  }

  await analysisRepository.save(analysis);
  try {
    await indexEligibleFragmentAnalysis(database, analysis);
  } catch (error) {
    await analysisRepository.delete(input.groupId, input.fragmentId);
    throw error;
  }
  const current = await memory.findFragmentById(input.groupId, input.fragmentId);
  if (!current || current.deletionState !== "active" || !current.aiProcessingConsent) {
    await analysisRepository.delete(input.groupId, input.fragmentId);
    return null;
  }
  return analysis.id;
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
    throw ApplicationFailure.nonRetryable(
      "Legacy media storage is unavailable; remove the object manually",
      "LegacyMediaCleanupRequired",
    );
  }
  await new MongoFragmentAnalysisRepository(database).delete(input.groupId, input.fragmentId);
  if (process.env.TIGER_DATABASE_URL) {
    await new TigerDataFragmentSearch().removeGroupVisibleFragment(input.groupId, input.fragmentId);
  }
  await repository.markFragmentDeletionComplete(input.groupId, input.fragmentId);
}
