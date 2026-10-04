import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { EventStoryEditor, type EventStoryDraft } from "@/components/event-story-editor";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { GroupAccessError, requireGroupMembership } from "@/lib/auth/group-access";
import { confirmedMomentsForEventStory, momentForGroupMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoEventStoryRepository } from "@/lib/repositories/mongodb-event-story-repository";
import { MongoEventStoryGenerationJobRepository } from "@/lib/repositories/mongodb-event-story-generation-job-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MAX_EVENT_STORY_MOMENTS } from "@/lib/pipeline/event-story-generation";
import type { Fragment } from "@/lib/domain/memory";

export const dynamic = "force-dynamic";

export default async function EventStoryPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  if (!getAuthConfigurationStatus().configured) redirect("/sign-in");
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
  const memory = new MongoMemoryRepository(database);
  const [allMoments, document, generationJob] = await Promise.all([
    memory.listMoments(groupId, 100),
    new MongoEventStoryRepository(database).find(groupId),
    new MongoEventStoryGenerationJobRepository(database).findLatest(groupId, session.user.id),
  ]);
  const evidenceFragmentIds = [...new Set(allMoments.flatMap((moment) =>
    moment.evidence.map((evidence) => evidence.fragmentId),
  ))];
  const groupFragments = await memory.findEligibleGroupVisibleFragmentsByIds(groupId, evidenceFragmentIds);
  const confirmedMoments = confirmedMomentsForEventStory(allMoments, groupFragments)
    .map(momentForGroupMember);
  const momentIds = new Set(confirmedMoments.map((moment) => moment.id));
  const initialStory: EventStoryDraft | null = document ? {
    title: document.title,
    narrative: document.narrative,
    momentIds: document.momentIds.filter((id) => momentIds.has(id)),
    evidenceReferences: document.evidenceReferences ?? [],
    generatedByGemma: document.generatedByGemma ?? false,
    revision: document.revision,
    updatedAt: document.updatedAt,
  } : null;
  const initialJob = generationJob ? {
    id: generationJob.id,
    status: generationJob.status,
    errorCategory: generationJob.errorCategory,
  } : null;
  const sources: Array<Pick<Fragment, "id" | "type" | "source" | "caption" | "textContent" | "capturedAt" | "authorUserId">> =
    groupFragments.filter((fragment) => confirmedMoments.some((moment) =>
      moment.evidence.some((evidence) => evidence.fragmentId === fragment.id),
    ));

  return (
    <EventStoryEditor
      groupId={groupId}
      groupName={typeof access.group.name === "string" ? access.group.name : "Private album"}
      initialStory={initialStory}
      initialJob={initialJob}
      maxMoments={MAX_EVENT_STORY_MOMENTS}
      moments={confirmedMoments}
      sources={sources}
    />
  );
}
