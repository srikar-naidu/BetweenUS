"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Fragment, MemberMoment } from "@/lib/domain/memory";
import { formatCaptureTime } from "@/lib/domain/format-time";
import { FragmentPrivacyControls } from "@/components/fragment-privacy-controls";
import { FragmentComposer } from "@/components/fragment-composer";

export type GroupFragmentView = Omit<Fragment, "storageUri"> & {
  processingJobStatus: "queued" | "running" | "succeeded" | "failed" | "retrying" | null;
};

function MomentReviewControls({
  groupId,
  moment,
  otherMoments,
  onReview,
}: {
  groupId: string;
  moment: MemberMoment;
  otherMoments: MemberMoment[];
  onReview: (sourceMomentId: string, updatedMoment: MemberMoment) => void;
}) {
  const [correctionType, setCorrectionType] = useState<"person" | "place" | "reference">("reference");
  const [correctionValue, setCorrectionValue] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isCandidate = moment.status === "candidate";
  const canReview = isCandidate || moment.status === "confirmed";

  async function sendReview(body: Record<string, string>) {
    setMessage(null);
    setPending(true);
    try {
      const response = await fetch(`/api/groups/${groupId}/moments/${moment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { moment?: MemberMoment; error?: string };
      if (!response.ok || !result.moment) {
        setMessage(result.error ?? "Could not save the moment review.");
        return;
      }
      onReview(moment.id, result.moment);
      setMessage("Moment review saved.");
    } catch {
      setMessage("Could not reach the moment review service.");
    } finally {
      setPending(false);
    }
  }

  if (!canReview) return null;
  return (
    <div className="moment-review">
      <div className="action-row">
        {moment.canUndoCorrection && (
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={() => void sendReview({ action: "undo_correction" })}
          >
            Undo last correction
          </button>
        )}
        {isCandidate && (
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Confirm this moment based on its current evidence?")) {
                void sendReview({ action: "confirm" });
              }
            }}
          >
            Confirm moment
          </button>
        )}
        {isCandidate && (
          <button
            className="text-button danger-button"
            type="button"
            disabled={pending}
            onClick={() => void sendReview({ action: "reject" })}
          >
            Reject
          </button>
        )}
      </div>
      {moment.evidence.map((item) => (
        <div className="moment-evidence-review" key={item.fragmentId}>
          <label>
            Correct a person, place, or reference
            <select
              aria-label={`Correction type for ${item.fragmentId}`}
              value={correctionType}
              onChange={(event) => setCorrectionType(event.target.value as typeof correctionType)}
            >
              <option value="person">Person</option>
              <option value="place">Place</option>
              <option value="reference">Reference</option>
            </select>
          </label>
          <input
            aria-label={`Correction value for ${item.fragmentId}`}
            maxLength={240}
            value={correctionValue}
            onChange={(event) => setCorrectionValue(event.target.value)}
            placeholder="Enter the correction"
          />
          <button
            className="text-button"
            type="button"
            disabled={pending || !correctionValue.trim()}
            onClick={() => void sendReview({
              action: "correct",
              correctionType,
              fragmentId: item.fragmentId,
              value: correctionValue,
            })}
          >
            Save correction
          </button>
          <button
            className="text-button danger-button"
            type="button"
            disabled={pending}
            onClick={() => void sendReview({ action: "remove_evidence", fragmentId: item.fragmentId })}
          >
            Remove evidence
          </button>
        </div>
      ))}
      {isCandidate && otherMoments.length > 0 && (
        <div className="moment-merge">
          <label>
            Merge into another moment
            <select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
              <option value="">Choose a moment</option>
              {otherMoments.map((other) => (
                <option value={other.id} key={other.id}>
                  {other.title ?? other.summary.slice(0, 80)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="text-button"
            type="button"
            disabled={pending || !mergeTargetId}
            onClick={() => {
              if (window.confirm("Merge this candidate into the selected moment?")) {
                void sendReview({ action: "merge", targetMomentId: mergeTargetId });
              }
            }}
          >
            Merge candidate
          </button>
        </div>
      )}
      {message && <p className="privacy-status" role="status">{message}</p>}
    </div>
  );
}

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
  initialMoments: MemberMoment[];
  currentUserId: string;
  memberRole: "owner" | "admin" | "member";
}) {
  const [fragments, setFragments] = useState(initialFragments);
  const [moments, setMoments] = useState(initialMoments);
  const [groupDeletionPending, setGroupDeletionPending] = useState(false);
  const [groupDeletionMessage, setGroupDeletionMessage] = useState<string | null>(null);
  const [reconstructingFragmentId, setReconstructingFragmentId] = useState<string | null>(null);
  const [momentJobs, setMomentJobs] = useState<Array<{ jobId: string; fragmentId: string }>>([]);
  const [reconstructionMessage, setReconstructionMessage] = useState<string | null>(null);
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

  useEffect(() => {
    if (!momentJobs.length) return;
    let cancelled = false;
    let requestInFlight = false;
    const interval = window.setInterval(async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        await Promise.all(momentJobs.map(async (job) => {
          const response = await fetch(
            `/api/groups/${groupId}/processing-jobs/${encodeURIComponent(job.jobId)}`,
            { cache: "no-store" },
          );
          if (!response.ok) {
            const result = await response.json() as { error?: string };
            if (!cancelled) {
              setReconstructionMessage(result.error ?? "Could not check the reconstruction job.");
              setMomentJobs((current) => current.filter((item) => item.jobId !== job.jobId));
            }
            return;
          }
          const result = await response.json() as {
            status?: string;
            outcome?: "candidate" | "insufficient_evidence";
            moment?: MemberMoment;
            reason?: string;
          };
          if (cancelled || result.status === "queued" || result.status === "running" || result.status === "retrying") {
            return;
          }
          if (result.status === "failed") {
            setReconstructionMessage("Moment reconstruction failed. You can start a new request to retry.");
          } else if (result.outcome === "candidate" && result.moment) {
            const moment = result.moment;
            setMoments((current) => [moment, ...current.filter((item) => item.id !== moment.id)]);
            setReconstructionMessage("A possible moment is ready for review.");
          } else if (result.outcome === "insufficient_evidence") {
            setReconstructionMessage(result.reason ?? "There is not enough evidence to suggest a shared moment.");
          } else {
            setReconstructionMessage("The reconstruction job completed without a reviewable result.");
          }
          setMomentJobs((current) => current.filter((item) => item.jobId !== job.jobId));
        }));
      } catch {
        if (!cancelled) setReconstructionMessage("Could not reach the reconstruction job service.");
      } finally {
        requestInFlight = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [groupId, momentJobs]);

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

  async function reconstructFrom(fragment: GroupFragmentView) {
    setReconstructingFragmentId(fragment.id);
    setReconstructionMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/moments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": window.crypto.randomUUID(),
        },
        body: JSON.stringify({ anchorFragmentId: fragment.id }),
      });
      const result = await response.json() as {
        jobId?: string;
        status?: string;
        error?: string;
      };
      if (!response.ok || !result.jobId || !result.status) {
        setReconstructionMessage(result.error ?? "Could not reconstruct a moment.");
        return;
      }
      const jobId = result.jobId;
      setMomentJobs((current) => [
        ...current.filter((item) => item.fragmentId !== fragment.id),
        { jobId, fragmentId: fragment.id },
      ]);
      setReconstructionMessage("Moment reconstruction queued.");
    } catch {
      setReconstructionMessage("Could not reach the moment reconstruction service.");
    } finally {
      setReconstructingFragmentId(null);
    }
  }

  function reviewMoment(sourceMomentId: string, updatedMoment: MemberMoment) {
    setMoments((current) => {
      const remaining = current.filter((item) => item.id !== sourceMomentId && item.id !== updatedMoment.id);
      return updatedMoment.status === "candidate" || updatedMoment.status === "confirmed"
        ? [updatedMoment, ...remaining]
        : remaining;
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
                  {fragment.type === "text" &&
                    fragment.source === "text" &&
                    fragment.visibility === "group" &&
                    fragment.aiProcessingConsent &&
                    fragment.status === "processed" && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={
                          reconstructingFragmentId !== null ||
                          momentJobs.some((job) => job.fragmentId === fragment.id)
                        }
                        onClick={() => void reconstructFrom(fragment)}
                      >
                        {reconstructingFragmentId === fragment.id
                          ? "Queuing…"
                          : momentJobs.some((job) => job.fragmentId === fragment.id)
                            ? "Reconstruction queued…"
                            : "Reconstruct a moment"}
                      </button>
                    )}
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
                    onUpdated={(update) => {
                      setFragments((current) => current.map((item) =>
                        item.id === update.fragmentId
                          ? {
                              ...item,
                              visibility: update.visibility,
                              aiProcessingConsent: update.aiProcessingConsent,
                              processingVersion: update.processingVersion,
                              processingJobStatus: update.processingJobStatus,
                            }
                          : item,
                      ));
                      if (update.visibility !== "group" || !update.aiProcessingConsent) {
                        setMoments((current) => current.filter((moment) =>
                          !moment.evidence.some((item) => item.fragmentId === update.fragmentId),
                        ));
                      }
                    }}
                    onDeleted={(fragmentId) => {
                      if (fragments.some((item) => item.id === fragmentId && item.source === "upload")) {
                        setLegacyMediaCleanupRequired(true);
                      }
                      setFragments((current) => current.filter((item) => item.id !== fragmentId));
                      setMoments((current) => current.filter((moment) =>
                        !moment.evidence.some((item) => item.fragmentId === fragmentId),
                      ));
                    }}
                  />
                </article>
              ))}
              {!fragments.length && <p className="empty-moment">This group has no fragments yet.</p>}
            </div>
          </div>
          <div className="moment-panel">
            <div className="section-head"><h2>Moments</h2><span>{moments.length} reconstructed</span></div>
            {reconstructionMessage && <p className="privacy-status" role="status">{reconstructionMessage}</p>}
            {moments.map((moment) => (
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
                {moment.reconstruction && (
                  <div className="moment-analysis-notes">
                    {moment.reconstruction.contradictions.map((item, index) => (
                      <div key={`contradiction-${index}`}>
                        <p><strong>Possible contradiction:</strong> {item.summary}</p>
                        {item.evidence.map((source) => (
                          <p key={source.fragmentId}>
                            {captionsById.get(source.fragmentId) ?? "Evidence is not visible to this member"}: “{source.quote}”
                          </p>
                        ))}
                      </div>
                    ))}
                    {moment.reconstruction.missingEvidence.map((item, index) => (
                      <p key={`missing-${index}`}><strong>Missing evidence:</strong> {item}</p>
                    ))}
                    {moment.reconstruction.uncertaintyNotes.map((item, index) => (
                      <p key={`uncertainty-${index}`}><strong>Uncertainty:</strong> {item}</p>
                    ))}
                    {moment.reconstruction.inferenceNotes.map((item, index) => (
                      <p key={`inference-${index}`}><strong>Inference:</strong> {item}</p>
                    ))}
                  </div>
                )}
                {moment.corrections?.map((correction, index) => (
                  <p key={`correction-${index}`} className="moment-correction">
                    Member correction ({correction.type}): {correction.value}
                  </p>
                ))}
                <MomentReviewControls
                  groupId={groupId}
                  moment={moment}
                  otherMoments={moments.filter((other) =>
                    other.id !== moment.id &&
                    (other.status === "candidate" || other.status === "confirmed"),
                  )}
                  onReview={(sourceId, updated) => void reviewMoment(sourceId, updated)}
                />
              </article>
            ))}
            {!moments.length && <p className="empty-moment">No reconstructed moments are ready yet.</p>}
          </div>
        </section>
      )}
      {!groupDeletionPending && memberRole === "owner" && (
        <button className="text-button danger-button" onClick={requestGroupDeletion}>Request group deletion</button>
      )}
    </main>
  );
}