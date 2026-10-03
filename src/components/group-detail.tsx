"use client";

import Link from "next/link";
import { useState } from "react";
import type { Fragment, Moment } from "@/lib/domain/memory";
import { formatCaptureTime } from "@/lib/domain/format-time";
import { FragmentPrivacyControls } from "@/components/fragment-privacy-controls";

export type GroupFragmentView = Omit<Fragment, "storageUri">;

export function GroupDetail({
  groupId,
  groupName,
  initialFragments,
  initialMoments,
  currentUserId,
  memberRole,
}: {
  groupId: string;
  groupName: string;
  initialFragments: GroupFragmentView[];
  initialMoments: Moment[];
  currentUserId: string;
  memberRole: "owner" | "admin" | "member";
}) {
  const [fragments, setFragments] = useState(initialFragments);
  const [groupDeletionPending, setGroupDeletionPending] = useState(false);
  const captionsById = new Map(fragments.map((fragment) => [fragment.id, fragment.caption]));

  function requestGroupDeletion() {
    if (!window.confirm("Mark this group for deletion and block further access?")) return;
    void fetch(`/api/groups/${groupId}`, { method: "DELETE" }).then((response) => {
      if (response.status === 202) setGroupDeletionPending(true);
    });
  }

  return (
    <main className="shell trust-page">
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <Link className="group-label" href="/groups">ALL GROUPS</Link>
      </header>
      <section className="intro">
        <p className="eyebrow">PRIVATE GROUP</p>
        <h1>{groupName}</h1>
      </section>
      {groupDeletionPending ? (
        <p className="setup-message" role="status">Group deletion is pending cleanup. Members can no longer access this space.</p>
      ) : (
        <section className="group-detail-grid">
          <div>
            <div className="section-head"><h2>Fragments</h2><span>{fragments.length} visible to you</span></div>
            <div className="fragment-list">
              {fragments.map((fragment) => (
                <article className="group-fragment" key={fragment.id}>
                  <div className="fragment-row">
                    <time>{formatCaptureTime(fragment.capturedAt)}</time>
                    <span>{fragment.type}</span>
                    <span>{fragment.visibility}</span>
                  </div>
                  <p>{fragment.caption ?? "No caption"}</p>
                  <FragmentPrivacyControls
                    groupId={groupId}
                    fragmentId={fragment.id}
                    initialVisibility={fragment.visibility}
                    initialConsent={fragment.aiProcessingConsent}
                    canEditPrivacy={fragment.authorUserId === currentUserId}
                    canDelete={
                      fragment.authorUserId === currentUserId ||
                      ((memberRole === "owner" || memberRole === "admin") && fragment.visibility === "group")
                    }
                    onDeleted={(fragmentId) =>
                      setFragments((current) => current.filter((item) => item.id !== fragmentId))
                    }
                  />
                </article>
              ))}
              {!fragments.length && <p className="empty-moment">This group has no fragments yet.</p>}
            </div>
          </div>
          <div className="moment-panel">
            <div className="section-head"><h2>Moments</h2><span>{initialMoments.length} reconstructed</span></div>
            {initialMoments.map((moment) => (
              <article className="group-moment" key={moment.id}>
                <span className="moment-status">{moment.uncertaintyLabel}</span>
                <h3>{moment.title ?? "A possible moment"}</h3>
                <p>{moment.summary}</p>
                <ul className="evidence-list">
                  {moment.evidence.map((evidence) => (
                    <li key={evidence.fragmentId}>
                      {captionsById.get(evidence.fragmentId) ?? "Evidence is not visible to this member"}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
            {!initialMoments.length && <p className="empty-moment">No reconstructed moments are ready yet.</p>}
          </div>
        </section>
      )}
      {!groupDeletionPending && memberRole === "owner" && (
        <button className="text-button danger-button" onClick={requestGroupDeletion}>Request group deletion</button>
      )}
    </main>
  );
}