"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { GoogleSignInButton } from "@/components/google-sign-in-button";

export function AcceptGroupInvite({
  invitationId,
  configured,
}: {
  invitationId: string;
  configured: boolean;
}) {
  const router = useRouter();
  const { data: session, isPending: checkingSession } = authClient.useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function acceptInvitation() {
    setMessage(null);
    startTransition(async () => {
      const result = await authClient.organization.acceptInvitation({ invitationId });
      if (result.error) {
        setMessage("This invitation is invalid, expired, or belongs to a different email address.");
        return;
      }
      router.push("/groups");
    });
  }

  return (
    <section className="trust-panel">
      <p className="eyebrow">GROUP INVITATION</p>
      <h1>Join a shared memory.</h1>
      <p className="lede">Sign in with the email address this invitation was sent to. The link expires after seven days.</p>
      {!configured ? (
        <p className="setup-message">Authentication is not configured on this server.</p>
      ) : checkingSession ? (
        <p>Checking your session…</p>
      ) : session ? (
        <button className="primary-button" onClick={acceptInvitation} disabled={isPending}>
          {isPending ? "Accepting…" : "Accept group invitation"}
        </button>
      ) : (
        <GoogleSignInButton enabled callbackURL={`/invite/${encodeURIComponent(invitationId)}`} />
      )}
      {message && <p className="error-message" role="alert">{message}</p>}
      <Link className="text-button" href="/groups">Back to groups</Link>
    </section>
  );
}