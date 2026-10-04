import type { Db } from "mongodb";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { hasAnalyzableFragmentSource, type Fragment } from "@/lib/domain/memory";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { isManagedGroupMediaStorageUri } from "@/lib/repositories/mongodb-group-media-storage";

export function shouldAutomaticallyAnalyzeGroupPost(visibility: Fragment["visibility"]): boolean {
  return visibility === "group";
}

export async function enqueueExistingGroupPostsForAnalysis(
  database: Db,
  fragments: Fragment[],
): Promise<Fragment[]> {
  const memory = new MongoMemoryRepository(database);
  const ingestion = new MongoIngestionRepository(database);
  const automaticallyEnabled = new Map<string, Fragment>();
  const candidates = fragments.filter((fragment) =>
    fragment.visibility === "group" &&
    !fragment.aiProcessingConsent &&
    !fragment.aiProcessingConsentRevokedAt &&
    hasAnalyzableFragmentSource(fragment) &&
    ((fragment.type !== "image" && fragment.type !== "video") ||
      (fragment.storageUri !== null && isManagedGroupMediaStorageUri(fragment.storageUri))),
  );

  await Promise.all(candidates.map(async (fragment) => {
    const processingVersion = `${FRAGMENT_ANALYSIS_VERSION}-${Date.now()}`;
    const enabled = await memory.enableAutomaticGroupFragmentAnalysis({
      groupId: fragment.groupId,
      fragmentId: fragment.id,
      processingVersion,
    });
    if (!enabled) return;
    await ingestion.upsertProcessingJob({
      groupId: fragment.groupId,
      fragmentId: fragment.id,
      jobType: "ingest",
      processingVersion,
    });
    automaticallyEnabled.set(fragment.id, enabled);
  }));

  return fragments.map((fragment) => automaticallyEnabled.get(fragment.id) ?? fragment);
}
