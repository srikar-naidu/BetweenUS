"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { extractInvitationId } from "@/lib/auth/invitation-link";

export interface GroupSummary {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  lifecycleStatus?: string;
  memberRole: "owner" | "admin" | "member";
}

interface Props {
  initialGroups: GroupSummary[];
}

export function GroupManager({ initialGroups }: Props) {
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});
  const [inviteMessages, setInviteMessages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [invitationInput, setInvitationInput] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description }),
        });
        const result = (await response.json()) as { group?: GroupSummary; error?: string };
        if (!response.ok || !result.group) throw new Error(result.error ?? "Could not create group");
        setGroups((current) => [result.group!, ...current]);
        setName("");
        setDescription("");
        router.push(`/groups/${result.group.id}`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not create group");
      }
    });
  }

  function inviteMember(event: FormEvent<HTMLFormElement>, groupId: string) {
    event.preventDefault();
    setInviteErrors((current) => ({ ...current, [groupId]: "" }));
    setInviteMessages((current) => ({ ...current, [groupId]: "" }));
    startTransition(async () => {
      try {
        const response = await fetch(`/api/groups/${groupId}/invites`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: inviteEmails[groupId] ?? "" }),
        });
        const result = (await response.json()) as { inviteUrl?: string; error?: string };
        if (!response.ok || !result.inviteUrl) throw new Error(result.error ?? "Could not create invitation");
        setInviteLinks((current) => ({ ...current, [groupId]: result.inviteUrl! }));
        setInviteEmails((current) => ({ ...current, [groupId]: "" }));
        setInviteMessages((current) => ({
          ...current,
          [groupId]: "Invite link created. Share it with that email address.",
        }));
      } catch (caught) {
        setInviteErrors((current) => ({
          ...current,
          [groupId]: caught instanceof Error ? caught.message : "Could not create invitation",
        }));
      }
    });
  }

  function joinWithInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invitationId = extractInvitationId(invitationInput);
    if (!invitationId) {
      setJoinError("Paste a valid private-space invite link or invitation code.");
      return;
    }
    setJoinError(null);
    router.push(`/invite/${encodeURIComponent(invitationId)}`);
  }

  return (
    <div className="groups-layout">
      <section className="groups-column" aria-labelledby="groups-heading">
        <div className="section-head">
          <h2 id="groups-heading">Your groups</h2>
          <span>{groups.length} {groups.length === 1 ? "space" : "spaces"}</span>
        </div>
        <section className="join-space-panel" aria-labelledby="join-space-heading">
          <div>
            <span className="group-guide-kicker">INVITED TO A PRIVATE SPACE?</span>
            <h3 id="join-space-heading">Join your people.</h3>
            <p>Paste the private invite link or code you received. Only invited email addresses can join.</p>
          </div>
          <form className="join-space-form" onSubmit={joinWithInvitation}>
            <label className="sr-only" htmlFor="space-invitation">Invite link or code</label>
            <input
              id="space-invitation"
              autoComplete="off"
              value={invitationInput}
              placeholder="Paste invite link or code"
              onChange={(event) => {
                setInvitationInput(event.target.value);
                setJoinError(null);
              }}
            />
            <button className="secondary-button" type="submit">
              Join with invite
            </button>
            {joinError && <p className="error-message" role="alert">{joinError}</p>}
          </form>
        </section>
        {groups.length ? (
          <ul className="group-list">
            {groups.map((group) => (
              <li className="group-row" key={group.id}>
                <div>
                  <Link href={`/groups/${group.id}`} className="group-name">{group.name}</Link>
                  <p>{group.description || "Private memory space"}</p>
                  <Link href={`/groups/${group.id}`} className="group-open-space">
                    Open space <span aria-hidden="true">→</span>
                  </Link>
                </div>
                {(group.memberRole === "owner" || group.memberRole === "admin") && (
                <form onSubmit={(event) => inviteMember(event, group.id)} className="invite-form">
                  <label className="sr-only" htmlFor={`invite-${group.id}`}>Invite member by email</label>
                  <input
                    id={`invite-${group.id}`}
                    type="email"
                    required
                    autoComplete="off"
                    placeholder="friend@email.com"
                    value={inviteEmails[group.id] ?? ""}
                    aria-describedby={`invite-help-${group.id}`}
                    onChange={(event) => {
                      setInviteEmails((current) => ({ ...current, [group.id]: event.target.value }));
                      setInviteLinks((current) => ({ ...current, [group.id]: "" }));
                      setInviteErrors((current) => ({ ...current, [group.id]: "" }));
                      setInviteMessages((current) => ({ ...current, [group.id]: "" }));
                    }}
                  />
                  <span className="invite-help" id={`invite-help-${group.id}`}>
                    Use an email address that isn&apos;t already in this space.
                  </span>
                  <button className="secondary-button" disabled={isPending}>Create invite link</button>
                  {inviteLinks[group.id] && (
                    <input
                      aria-label={`Invitation link for ${group.name}`}
                      readOnly
                      value={inviteLinks[group.id]}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                  {inviteErrors[group.id] && (
                    <p className="error-message invite-feedback" role="alert">{inviteErrors[group.id]}</p>
                  )}
                  {inviteMessages[group.id] && (
                    <p className="success-message invite-feedback" role="status">{inviteMessages[group.id]}</p>
                  )}
                </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <section className="group-empty-guide" aria-label="What you can share with your group">
            <div className="group-empty-copy">
              <span className="group-guide-kicker">A SHARED SPACE, NOT A PUBLIC FEED</span>
              <h3>Post the little things that make it your story.</h3>
              <p>
                Add a photo, a short video, a quick text, or a voice note. Your group can bring their
                own little pieces, then see what the memories have in common.
              </p>
              <span className="group-format-label">PHOTOS <span aria-hidden="true">+</span> SHORT VIDEOS <span aria-hidden="true">+</span> TEXT <span aria-hidden="true">+</span> VOICE</span>
            </div>
            <div className="group-example-posts" aria-label="Example group posts">
              <article className="group-example-post group-example-post--text">
                <div className="group-example-byline">
                  <span className="group-example-avatar">M</span>
                  <span>MAYA <small>· TODAY, 12:04</small></span>
                </div>
                <p>Got there early and saved everyone the sunny table.</p>
                <span className="group-example-type">A LITTLE TEXT MEMORY</span>
              </article>
              <article className="group-example-post group-example-post--voice">
                <div className="group-example-byline">
                  <span className="group-example-avatar">A</span>
                  <span>ARJUN <small>· TODAY, 12:09</small></span>
                </div>
                <div className="group-example-wave" aria-hidden="true">
                  {[12, 21, 16, 29, 18, 25, 12, 31, 19, 27, 14, 22, 11, 28, 17, 24, 12].map((height, index) => (
                    <span key={index} style={{ height }} />
                  ))}
                </div>
                <span className="group-example-type">A 14-SECOND VOICE NOTE</span>
              </article>
              <article className="group-example-post group-example-post--media">
                <Image
                  src="/fragment-food.svg"
                  alt="Example photo of fries and coffee on a cafeteria table"
                  width={180}
                  height={132}
                />
                <span className="group-example-type">A PHOTO FROM LUNCH</span>
              </article>
              <article className="group-example-post group-example-post--media group-example-post--video">
                <div className="group-example-video">
                  <Image
                    src="/fragment-video.svg"
                    alt="Example video still of friends celebrating"
                    width={180}
                    height={132}
                  />
                  <span aria-hidden="true">▶</span>
                </div>
                <span className="group-example-type">A SHORT VIDEO CLIP</span>
              </article>
            </div>
            <div className="group-first-steps" aria-label="Getting started">
              <span><strong>01</strong> Name your space</span>
              <span><strong>02</strong> Invite your people</span>
              <span><strong>03</strong> Add a memory</span>
            </div>
          </section>
        )}
      </section>

      <section className="create-group-panel" aria-labelledby="create-group-heading">
        <span className="group-guide-kicker">START YOUR CIRCLE</span>
        <h2 id="create-group-heading">Make it yours.</h2>
        <p className="create-group-intro">Give your space a name. You can invite friends and post your first memory right after.</p>
        <form onSubmit={createGroup} className="create-group-form">
          <label>
            Group name
            <input
              required
              minLength={2}
              maxLength={80}
              placeholder="The Sunday crew"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Description <span>(optional)</span>
            <textarea
              maxLength={500}
              placeholder="Trips, traditions, or the people you want to remember it with."
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={isPending}>
            {isPending ? "Making your space…" : "Create your private space"}
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => void authClient.signOut().then(() => router.replace("/sign-in"))}
        >
          Sign out
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </section>
    </div>
  );
}