import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { GroupDetail, type GroupFragmentView } from "@/components/group-detail";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { GroupAccessError, requireGroupMembership } from "@/lib/auth/group-access";
import {
  momentForGroupMember,
  storyForGroupMember,
  visibleMomentsForMember,
  visibleStoriesForMember,
} from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";
import { FRAGMENT_ANALYSIS_VERSION, fragmentAnalysisForMember, fragmentSourceDigest } from "@/lib/ai/fragment-analysis";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { isManagedGroupMediaStorageUri } from "@/lib/repositories/mongodb-group-media-storage";
import { safeProcessingFailureCategory } from "@/lib/processing/failure-category";

export const dynamic = "force-dynamic";

export default async function GroupPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const configuration = getAuthConfigurationStatus();
  if (!configuration.configured) {
    return (
      <main className="shell trust-page">
        <p className="setup-message">Authentication is not configured on this server.</p>
      </main>
    );
  }

  const { groupId } = await params;
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");

  let access;
  try {
    access = await requireGroupMembership(requestHeaders, groupId);
  } catch (error) {
    if (error instanceof GroupAccessError && error.status === 404) notFound();
    if (error instanceof GroupAccessError && error.status === 401) redirect("/sign-in");
    throw error;
  }

  const database = await getMongoDatabase();
  const repository = new MongoMemoryRepository(database);
  const storyRepository = new MongoStoryRepository(database);
  const ingestionRepository = new MongoIngestionRepository(database);
  const [memberFragments, groupMoments, groupStories, pendingStoryJobs] = await Promise.all([
    repository.findMemberVisibleFragments(groupId, session.user.id),
    repository.listMoments(groupId),
    storyRepository.listStories(groupId),
    storyRepository.listPendingStoryJobs(groupId, session.user.id),
  ]);
  const analysisRecords = await new MongoFragmentAnalysisRepository(database).findMany(
    groupId,
    memberFragments
      .filter((fragment) => fragment.aiProcessingConsent)
      .map((fragment) => fragment.id),
    FRAGMENT_ANALYSIS_VERSION,
  );
  const analysesByFragment = new Map(
    analysisRecords.map((analysis) => [analysis.fragmentId, analysis]),
  );
  const processingJobs = await ingestionRepository.latestProcessingJobsByFragmentIds(
    groupId,
    memberFragments.map((fragment) => fragment.id),
  );
  const moments = visibleMomentsForMember(groupMoments, memberFragments).map(momentForGroupMember);
  const storyFragmentIds = [...new Set([
    ...groupMoments.flatMap((moment) => moment.evidence.map(({ fragmentId }) => fragmentId)),
    ...groupStories.flatMap((story) => story.evidence.flatMap((item) => item.fragmentIds)),
  ])];
  const storyFragments = await repository.findEligibleGroupVisibleFragmentsByIds(groupId, storyFragmentIds);
  const stories = visibleStoriesForMember(groupStories, groupMoments, storyFragments)
    .map(storyForGroupMember);
  const fragments: GroupFragmentView[] = memberFragments.map((fragment) => {
    const { storageUri, ...visibleFragment } = fragment;
    const analysis = analysesByFragment.get(fragment.id);
    return {
      ...visibleFragment,
      processingJobStatus: fragment.aiProcessingConsent ? processingJobs.get(fragment.id)?.status ?? null : null,
      ...(fragment.aiProcessingConsent && processingJobs.get(fragment.id)?.status === "failed"
        ? { processingError: safeProcessingFailureCategory(processingJobs.get(fragment.id)?.errorMessage) }
        : {}),
      mediaStorageAvailable:
        (fragment.type === "image" || fragment.type === "video") &&
        typeof storageUri === "string" &&
        isManagedGroupMediaStorageUri(storageUri),
      ...(fragment.aiProcessingConsent &&
        analysis &&
        analysis.sourceContentSha256 === fragmentSourceDigest(fragment)
        ? { analysis: fragmentAnalysisForMember(analysis) }
        : {}),
    };
  });

  return (
    <GroupDetail
      groupId={groupId}
      groupName={typeof access.group.name === "string" ? access.group.name : "Private group"}
      initialFragments={fragments}
      initialMoments={moments}
      initialStories={stories}
      initialStoryJobIds={pendingStoryJobs.map((job) => job.id)}
      currentUserId={session.user.id}
      memberRole={access.membership.role as "owner" | "admin" | "member"}
    />
  );
}