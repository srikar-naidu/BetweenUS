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
      <AcceptGroupInvite invitationId={invitationId} configured={configuration.configured} />
    </main>
  );
}