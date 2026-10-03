import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GroupManager, type GroupSummary } from "@/components/group-manager";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { listGroupsForUser } from "@/lib/auth/group-access";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const configuration = getAuthConfigurationStatus();
  if (!configuration.configured) {
    return (
      <main className="shell trust-page">
        <header className="topbar"><Link className="wordmark" href="/">between us<span>.</span></Link></header>
        <section className="trust-panel">
          <h1>Group spaces</h1>
          <p className="setup-message">Authentication setup is incomplete: {configuration.missing.join(", ")}.</p>
          <Link className="secondary-button link-button" href="/sign-in">Sign in setup</Link>
        </section>
      </main>
    );
  }

  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");

  const initialGroups: GroupSummary[] = await listGroupsForUser(requestHeaders);

  return (
    <main className="shell trust-page">
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <span className="group-label">SIGNED IN / {session.user.email}</span>
      </header>
      <section className="intro">
        <p className="eyebrow">YOUR PRIVATE SPACES</p>
        <h1>Groups, not a feed.</h1>
        <p className="lede">Create a space for the people who shared the moment.</p>
      </section>
      <GroupManager initialGroups={initialGroups} />
    </main>
  );
}