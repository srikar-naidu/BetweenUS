import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { FragmentAnalysis } from "@/lib/ai/fragment-analysis";
import { fragmentAnalysisSearchText } from "@/lib/ai/fragment-analysis";
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
    fragment.source !== "text" ||
    fragment.type !== "text" ||
    fragment.deletionState !== "active" ||
    !fragment.aiProcessingConsent ||
    !fragment.textContent
  ) {
    return false;
  }
  const sourceTextSha256 = createHash("sha256").update(fragment.textContent).digest("hex");
  if (sourceTextSha256 !== analysis.sourceTextSha256) {
    throw new Error("Fragment text changed after its analysis was generated");
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
    current?.source === "text" &&
    current.type === "text" &&
    current.deletionState === "active" &&
    current.aiProcessingConsent &&
    current.visibility === "group" &&
    current.textContent === fragment.textContent;
  if (!remainsEligible) {
    await retrieval.removeGroupVisibleFragment(analysis.groupId, analysis.fragmentId);
    return false;
  }
  return true;
}
