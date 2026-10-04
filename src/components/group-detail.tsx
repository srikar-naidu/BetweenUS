"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Fragment, Moment } from "@/lib/domain/memory";
import { formatCaptureTime } from "@/lib/domain/format-time";
import { FragmentPrivacyControls } from "@/components/fragment-privacy-controls";
import { FragmentComposer } from "@/components/fragment-composer";

export type GroupFragmentView = Omit<Fragment, "storageUri"> & {
  processingJobStatus: "queued" | "running" | "succeeded" | "failed" | "retrying" | null;
};

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
  const [groupDeletionMessage, setGroupDeletionMessage] = useState<string | null>(null);
  const [legacyMediaCleanupRequired, setLegacyMediaCleanupRequired] = useState(
    initialFragments.some((fragment) => fragment.source === "upload"),
  );
  const captionsById = new Map(fragments.map((fragment) => [fragment.id, fragment.caption]));

  useEffect(() => {
    const activeFragments = fragments.filter((fragment) =>
      fragment.source !== "upload" && (
        fragment.processingJobStatus === "queued" ||
        fragment.processingJobStatus === "running" ||
        fragment.processingJobStatus === "retrying"
      ),
    );
    if (!activeFragments.length) return;
    let cancelled = false;
    let requestInFlight = false;
    const interval = window.setInterval(async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        await Promise.all(activeFragments.map(async (fragment) => {
          const jobId = `ingest:${groupId}:${fragment.id}:${fragment.processingVersion}`;
          const response = await fetch(
            `/api/groups/${groupId}/processing-jobs/${encodeURIComponent(jobId)}`,
            { cache: "no-store" },
          );
          if (!response.ok) return;
          const result = await response.json() as { status?: GroupFragmentView["processingJobStatus"] };
          if (!cancelled && "status" in result) {
            setFragments((current) => current.map((item) =>
              item.id === fragment.id ? { ...item, processingJobStatus: result.status ?? null } : item,
            ));
          }
        }));
      } finally {
        requestInFlight = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fragments, groupId]);

  function requestGroupDeletion() {
    if (!window.confirm("Mark this group for deletion and block further access?")) return;
    void fetch(`/api/groups/${groupId}`, { method: "DELETE" }).then(async (response) => {
      if (response.status === 202) {
        const result = await response.json() as { legacyMediaCleanupRequired?: boolean };
        setGroupDeletionMessage(
          result.legacyMediaCleanupRequired
            ? "Group access is disabled. Original media files from previous uploads still need manual cleanup from the former storage bucket."
            : "Group deletion is pending cleanup. Members can no longer access this space.",
        );
        setGroupDeletionPending(true);
      }
    });
  }

  async function retryProcessing(fragment: GroupFragmentView) {
    const jobId = `ingest:${groupId}:${fragment.id}:${fragment.processingVersion}`;
    const response = await fetch(
      `/api/groups/${groupId}/processing-jobs/${encodeURIComponent(jobId)}`,
      { method: "POST" },
    );
    if (response.status === 202) {
      setFragments((current) => current.map((item) =>
        item.id === fragment.id
          ? { ...item, status: "uploaded", processingJobStatus: "queued" }
          : item,
      ));
    }
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
        <p className="setup-message" role="status">{groupDeletionMessage}</p>
      ) : (
        <section className="group-detail-grid">
          <div>
            <FragmentComposer
              groupId={groupId}
              onCreated={(fragment) =>
                setFragments((current) => [fragment, ...current.filter((item) => item.id !== fragment.id)])
              }
            />
            {legacyMediaCleanupRequired && (
              <p className="setup-message" role="note">
                Media uploads are disabled. Previously uploaded media is unavailable here and any remaining bucket objects need manual cleanup.
              </p>
            )}
            <div className="section-head"><h2>Fragments</h2><span>{fragments.length} visible to you</span></div>
            <div className="fragment-list">
              {fragments.map((fragment) => (
                <article className="group-fragment" key={fragment.id}>
                  <div className="fragment-row">
                    <time>{formatCaptureTime(fragment.capturedAt)}</time>
                    <span>{fragment.type}</span>
                    <span>{fragment.visibility}</span>
                  </div>
                  <p>{fragment.textContent ?? fragment.caption ?? "Media source is unavailable."}</p>
                  {fragment.processingJobStatus && (
                    <p className="fragment-processing-status" role="status">Processing: {fragment.processingJobStatus}</p>
                  )}
                  {fragment.processingJobStatus === "failed" && fragment.source !== "upload" && (
                    <button className="text-button" type="button" onClick={() => void retryProcessing(fragment)}>
                      Retry processing
                    </button>
                  )}
                  <FragmentPrivacyControls
                    groupId={groupId}
                    fragmentId={fragment.id}
                    hasLegacyMedia={fragment.source === "upload"}
                    initialVisibility={fragment.visibility}
                    initialConsent={fragment.aiProcessingConsent}
                    canEditPrivacy={fragment.authorUserId === currentUserId}
                    canDelete={
                      fragment.authorUserId === currentUserId ||
                      ((memberRole === "owner" || memberRole === "admin") && fragment.visibility === "group")
                    }
                    onUpdated={(update) => setFragments((current) => current.map((item) =>
                      item.id === update.fragmentId
                        ? {
                            ...item,
                            visibility: update.visibility,
                            aiProcessingConsent: update.aiProcessingConsent,
                            processingVersion: update.processingVersion,
                            processingJobStatus: update.processingJobStatus,
                          }
                        : item,
                    ))}
                    onDeleted={(fragmentId) => {
                      if (fragments.some((item) => item.id === fragmentId && item.source === "upload")) {
                        setLegacyMediaCleanupRequired(true);
                      }
                      setFragments((current) => current.filter((item) => item.id !== fragmentId));
                    }}
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