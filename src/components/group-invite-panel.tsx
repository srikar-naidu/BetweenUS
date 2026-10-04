"use client";

import { useState, type FormEvent } from "react";

export function GroupInvitePanel({
  groupId,
  groupName,
}: {
  groupId: string;
  groupName: string;
}) {
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    setInviteUrl(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json() as { inviteUrl?: string | null; error?: string };
      if (!response.ok || !result.inviteUrl) {
        throw new Error(result.error ?? "Could not create the invitation link.");
      }
      setInviteUrl(result.inviteUrl);
      setEmail("");
      setMessage("Invite link ready. It can only be accepted by the email address entered above.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the invitation link.");
    } finally {
      setPending(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    setCopying(true);
    setError(null);
    setMessage(null);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setMessage("Invite link copied.");
    } catch {
      setError("Could not copy the link. Select and copy it from the field.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <section className="group-invite-panel" aria-labelledby={`invite-heading-${groupId}`}>
      <div>
        <span className="group-guide-kicker">BRING YOUR PEOPLE IN</span>
        <h2 id={`invite-heading-${groupId}`}>Invite a friend</h2>
        <p>We&apos;ll make a private link for their email. Send it to them to join your space.</p>
      </div>
      <form className="group-invite-form" onSubmit={(event) => void createInvite(event)}>
        <label className="sr-only" htmlFor={`invite-email-${groupId}`}>Friend&apos;s email address</label>
        <input
          id={`invite-email-${groupId}`}
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          placeholder="friend@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="secondary-button" type="submit" disabled={pending}>
          {pending ? "Making link…" : "Generate invite link"}
        </button>
      </form>
      {inviteUrl && (
        <div className="group-invite-result">
          <label htmlFor={`invite-link-${groupId}`}>Invite link for {groupName}</label>
          <div className="group-invite-link-row">
            <input
              id={`invite-link-${groupId}`}
              readOnly
              value={inviteUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button className="primary-button" type="button" disabled={copying} onClick={() => void copyInvite()}>
              {copying ? "Copying…" : "Copy link"}
            </button>
          </div>
        </div>
      )}
      {message && <p className="privacy-status" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </section>
  );
}
