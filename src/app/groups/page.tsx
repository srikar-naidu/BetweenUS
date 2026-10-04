import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GroupManager, type GroupSummary } from "@/components/group-manager";
import { MemoryNavigation } from "@/components/memory-navigation";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { listGroupsForUser } from "@/lib/auth/group-access";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const configuration = getAuthConfigurationStatus();
  if (!configuration.configured) {
    return (
      <main className="shell trust-page" id="main-content">
        <a className="skip-link" href="#groups-heading">Skip to group spaces</a>
        <header className="topbar"><Link className="wordmark" href="/">between us<span>.</span></Link></header>
        <section className="trust-panel" id="groups-heading" tabIndex={-1}>
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
    <main className="shell trust-page" id="main-content">
      <a className="skip-link" href="#groups-content">Skip to group spaces</a>
      <header className="topbar">
        <Link className="wordmark" href="/home">between us<span>.</span></Link>
        <MemoryNavigation active="albums" />
      </header>
      <section className="intro" id="groups-content" tabIndex={-1}>
        <p className="eyebrow">YOUR PEOPLE, YOUR PRIVATE SPACE</p>
        <h1>A little place for your people.</h1>
        <p className="lede">
          Share photos, short videos, text notes, and optional voice memories with the people who
          were there. Invite your circle and piece the day together.
        </p>
      </section>
      <GroupManager initialGroups={initialGroups} />
    </main>
  );
}