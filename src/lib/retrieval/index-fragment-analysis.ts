import type { Db } from "mongodb";
import { hasAnalyzableFragmentSource } from "@/lib/domain/memory";
import {
  fragmentAnalysisSearchText,
  fragmentSourceDigest,
  type FragmentAnalysis,
} from "@/lib/ai/fragment-analysis";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";

export async function indexEligibleFragmentAnalysis(
  database: Db,
  analysis: FragmentAnalysis,
): Promise<boolean> {
  const repository = new MongoMemoryRepository(database);
  const fragment = await repository.findFragmentById(analysis.groupId, analysis.fragmentId);
  if (
    !fragment ||
    !hasAnalyzableFragmentSource(fragment) ||
    fragment.deletionState !== "active" ||
    !fragment.aiProcessingConsent
  ) {
    return false;
  }
  if (fragmentSourceDigest(fragment) !== analysis.sourceContentSha256) {
    throw new Error("Fragment source changed after its analysis was generated");
  }
  if (fragment.visibility !== "group") return false;

  const retrieval = new TigerDataFragmentSearch();
  const momentIds = await repository.findLinkedMomentIds(fragment.groupId, fragment.id);
  await retrieval.indexGroupVisibleFragment({
    groupId: fragment.groupId,
    fragmentId: fragment.id,
    capturedAt: fragment.capturedAt,
    semanticSummary: fragmentAnalysisSearchText(analysis),
    entityKeys: analysis.entities,
    momentIds,
    analysisVersion: analysis.analysisVersion,
    modelVersion: analysis.modelVersion,
  });

  const current = await repository.findFragmentById(analysis.groupId, analysis.fragmentId);
  const remainsEligible =
    current !== null &&
    hasAnalyzableFragmentSource(current) &&
    current.deletionState === "active" &&
    current.aiProcessingConsent &&
    current.visibility === "group" &&
    fragmentSourceDigest(current) === analysis.sourceContentSha256;
  if (!remainsEligible) {
    await retrieval.removeGroupVisibleFragment(analysis.groupId, analysis.fragmentId);
    return false;
  }
  return true;
}
