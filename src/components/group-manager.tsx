"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
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
        setNotice("Private group created.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not create group");
      }
    });
  }

  function inviteMember(event: FormEvent<HTMLFormElement>, groupId: string) {
    event.preventDefault();
    setError(null);
    setNotice(null);
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
        setNotice("Invitation created. Share the link with the invited email address.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not create invitation");
      }
    });
  }

  return (
    <div className="groups-layout">
      <section className="groups-column" aria-labelledby="groups-heading">
        <div className="section-head">
          <h2 id="groups-heading">Your groups</h2>
          <span>{groups.length} active</span>
        </div>
        {groups.length ? (
          <ul className="group-list">
            {groups.map((group) => (
              <li className="group-row" key={group.id}>
                <div>
                  <Link href={`/groups/${group.id}`} className="group-name">{group.name}</Link>
                  <p>{group.description || "Private memory space"}</p>
                </div>
                {(group.memberRole === "owner" || group.memberRole === "admin") && (
                <form onSubmit={(event) => inviteMember(event, group.id)} className="invite-form">
                  <label className="sr-only" htmlFor={`invite-${group.id}`}>Invite member by email</label>
                  <input
                    id={`invite-${group.id}`}
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="friend@email.com"
                    value={inviteEmails[group.id] ?? ""}
                    onChange={(event) =>
                      setInviteEmails((current) => ({ ...current, [group.id]: event.target.value }))
                    }
                  />
                  <button className="secondary-button" disabled={isPending}>Create invite link</button>
                  {inviteLinks[group.id] && (
                    <input
                      aria-label={`Invitation link for ${group.name}`}
                      readOnly
                      value={inviteLinks[group.id]}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-moment">No groups yet. Create one to start a private shared memory.</p>
        )}
      </section>

      <section className="create-group-panel" aria-labelledby="create-group-heading">
        <h2 id="create-group-heading">Create a group</h2>
        <form onSubmit={createGroup} className="create-group-form">
          <label>
            Group name
            <input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description <span>(optional)</span>
            <textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <button className="primary-button" disabled={isPending}>
            {isPending ? "Working…" : "Create private group"}
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => void authClient.signOut().then(() => router.replace("/sign-in"))}
        >
          Sign out
        </button>
        {notice && <p className="success-message" role="status">{notice}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </section>
    </div>
  );
}