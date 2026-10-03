import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { GroupDetail, type GroupFragmentView } from "@/components/group-detail";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { GroupAccessError, requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import type { Moment } from "@/lib/domain/memory";

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
        <header className="topbar"><Link className="wordmark" href="/">between us<span>.</span></Link></header>
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

  const repository = new MongoMemoryRepository(await getMongoDatabase());
  const [memberFragments, groupMoments] = await Promise.all([
    repository.findMemberVisibleFragments(groupId, session.user.id),
    repository.listMoments(groupId),
  ]);
  const eligibleFragmentIds = new Set(
    memberFragments
      .filter((fragment) => fragment.visibility === "group" && fragment.aiProcessingConsent)
      .map((fragment) => fragment.id),
  );
  const moments: Moment[] = groupMoments.filter(
    (moment) =>
      (moment.status === "candidate" || moment.status === "confirmed") &&
      moment.evidence.length > 0 &&
      moment.evidence.every((evidence) => eligibleFragmentIds.has(evidence.fragmentId)),
  );
  const fragments: GroupFragmentView[] = memberFragments.map(({ storageUri: _storageUri, ...fragment }) => fragment);

  return (
    <GroupDetail
      groupId={groupId}
      groupName={typeof access.group.name === "string" ? access.group.name : "Private group"}
      initialFragments={fragments}
      initialMoments={moments}
      currentUserId={session.user.id}
      memberRole={access.membership.role as "owner" | "admin" | "member"}
    />
  );
}