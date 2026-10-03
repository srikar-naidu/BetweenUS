import Link from "next/link";
import { AcceptGroupInvite } from "@/components/accept-group-invite";
import { getAuthConfigurationStatus } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  const configuration = getAuthConfigurationStatus();

  return (
    <main className="shell trust-page">
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <span className="group-label">PRIVATE GROUP MEMORY</span>
      </header>
      <AcceptGroupInvite invitationId={invitationId} configured={configuration.configured} />
    </main>
  );
}