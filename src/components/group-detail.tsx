"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Fragment, MemberMoment, MemberStory, MomentCorrection } from "@/lib/domain/memory";
import type { MemberFragmentAnalysis } from "@/lib/ai/fragment-analysis";
import { hasApprovedTextSource } from "@/lib/domain/memory";
import { formatCaptureTime } from "@/lib/domain/format-time";
import { FragmentPrivacyControls } from "@/components/fragment-privacy-controls";
import { FragmentComposer } from "@/components/fragment-composer";
import { GroupInvitePanel } from "@/components/group-invite-panel";
import { VoiceTranscriptReview } from "@/components/voice-transcript-review";
import { AudioWaveform } from "@/components/audio-waveform";
import Image from "next/image";

export type GroupFragmentView = Omit<Fragment, "storageUri"> & {
  processingJobStatus: "queued" | "running" | "succeeded" | "failed" | "retrying" | null;
  mediaStorageAvailable?: boolean;
  analysis?: MemberFragmentAnalysis;
  processingError?: string;
};

const relationshipLabels: Record<MemberMoment["evidence"][number]["relationship"], string> = {
  temporal: "Close in time",
  shared_people: "Shared people",
  shared_location: "Shared place",
  semantic_similarity: "Related content",
  entity_overlap: "Shared details",
};

function contributorTone(authorUserId: string): string {
  let hash = 0;
  for (const character of authorUserId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `tone-${hash % 5 + 1}`;
}

function GroupPhoto({
  groupId,
  fragmentId,
  alt,
  className,
}: {
  groupId: string;
  fragmentId: string;
  alt: string;
  className?: string;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const src = `/api/groups/${encodeURIComponent(groupId)}/fragments/${encodeURIComponent(fragmentId)}/media`;
  if (unavailable) {
    return (
      <div className={`group-photo-fallback ${className ?? ""}`} role="status">
        <strong>Photo preview unavailable</strong>
        <span>Reload the page to try loading this private photo again.</span>
      </div>
    );
  }
  return (
    <Image
      className={className}
      src={src}
      alt={alt}
      width={960}
      height={720}
      unoptimized
      loading="lazy"
      decoding="async"
      onError={() => setUnavailable(true)}
    />
  );
}

function fragmentFailureMessage(errorCategory?: string): string {
  if (errorCategory === "gemma_runtime_unavailable") {
    return "Gemma could not be reached. Check that Ollama is running, the configured model is installed, and the background worker can reach Ollama.";
  }
  if (errorCategory === "gemma_output_invalid") {
    return "Gemma responded, but its output failed validation. Check the worker terminal for details.";
  }
  if (errorCategory === "fragment_source_unavailable") {
    return "The fragment source is unavailable or no longer eligible for analysis.";
  }
  if (errorCategory === "temporal_unavailable") {
    return "The processing worker could not be reached. Check that the MongoDB queue worker is running.";
  }
  if (errorCategory === "fragment_ingestion_failed" || !errorCategory) {
    return "Processing failed. Check the background worker logs, then retry.";
  }
  return `Processing could not be retried: ${errorCategory}`;
}

function MomentReviewControls({
  groupId,
  moment,
  otherMoments,
  groupMemoryEnabled,
  sharedCorrectionIds,
  onReview,
  onMemoryChanged,
}: {
  groupId: string;
  moment: MemberMoment;
  otherMoments: MemberMoment[];
  groupMemoryEnabled: boolean;
  sharedCorrectionIds: ReadonlySet<string>;
  onReview: (sourceMomentId: string, updatedMoment: MemberMoment, cleanupPending: boolean) => void;
  onMemoryChanged: (momentId: string, correctionId: string, shared: boolean) => void;
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
      const result = await response.json() as {
        moment?: MemberMoment;
        error?: string;
        memoryCleanupPending?: boolean;
      };
      if (!response.ok || !result.moment) {
        setMessage(result.error ?? "Could not save the moment review.");
        return;
      }

      onReview(moment.id, result.moment, result.memoryCleanupPending === true);
      setMessage(result.memoryCleanupPending
        ? "Moment review saved, but Backboard memory cleanup is still pending."
        : "Moment review saved.");
    } catch {
      setMessage("Could not reach the moment review service.");
    } finally {
      setPending(false);
    }
  }

  async function changeSharedMemory(correction: MomentCorrection, shared: boolean) {
    if (!window.confirm(
      shared
        ? "Remove this correction from Backboard group memory? This also removes it from Backboard."
        : "Share this correction with Backboard? Only this correction will be sent for group memory.",
    )) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/memory/corrections`, {
        method: shared ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentId: moment.id, correctionId: correction.id }),
      });
      const result = await response.json() as { status?: string; error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "Could not update Backboard group memory.");
        return;
      }
      onMemoryChanged(moment.id, correction.id, !shared);
      setMessage(shared ? "Correction removed from Backboard group memory." : "Correction shared to Backboard group memory.");
    } catch {
      setMessage("Could not reach the Backboard group memory service.");
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
      {moment.corrections?.map((correction) => (
        <div key={correction.id} className="moment-correction-row">
          <p className="moment-correction">Member correction ({correction.type}): {correction.value}</p>
          {groupMemoryEnabled && moment.status === "confirmed" && (
            <button
              className="text-button"
              type="button"
              disabled={pending}
              onClick={() => void changeSharedMemory(
                correction,
                sharedCorrectionIds.has(correction.id),
              )}
            >
              {sharedCorrectionIds.has(correction.id)
                ? "Remove from group memory"
                : "Share to group memory"}
            </button>
          )}
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

function StoryReviewControls({
  groupId,
  story,
  onReview,
}: {
  groupId: string;
  story: MemberStory;
  onReview: (story: MemberStory) => void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (story.status !== "candidate") return null;

  async function review(action: "confirm" | "reject") {
    if (!window.confirm(
      action === "confirm"
        ? "Confirm this recurring Story connection based on its cited Moments?"
        : "Reject this Story connection?",
    )) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/stories/${story.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedRevision: story.revision }),
      });
      const result = await response.json() as { story?: MemberStory; error?: string };
      if (!response.ok || !result.story) {
        setMessage(result.error ?? "Could not save the Story review.");
        return;
      }
      onReview(result.story);
      setMessage("Story review saved.");
    } catch {
      setMessage("Could not reach the Story review service.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="moment-review">
      <div className="action-row">
        <button
          className="primary-button"
          type="button"
          disabled={pending}
          onClick={() => void review("confirm")}
        >
          Confirm story
        </button>
        <button
          className="text-button danger-button"
          type="button"
          disabled={pending}
          onClick={() => void review("reject")}
        >
          Reject
        </button>
      </div>
      {message && <p className="privacy-status" role="status">{message}</p>}
    </div>
  );
}

export function GroupDetail({
  groupId,
  groupName,
  initialFragments,
  initialMoments,
  initialStories,
  initialStoryJobIds,
  currentUserId,
  memberRole,
}: {
  groupId: string;
  groupName: string;
  initialFragments: GroupFragmentView[];
  initialMoments: MemberMoment[];
  initialStories: MemberStory[];
  initialStoryJobIds: string[];
  currentUserId: string;
  memberRole: "owner" | "admin" | "member";
}) {
  const [fragments, setFragments] = useState(initialFragments);
  const [moments, setMoments] = useState(initialMoments);
  const [stories, setStories] = useState(initialStories);
  const [groupDeletionPending, setGroupDeletionPending] = useState(false);
  const [groupDeletionRequesting, setGroupDeletionRequesting] = useState(false);
  const [groupDeletionMessage, setGroupDeletionMessage] = useState<string | null>(null);
  const [reconstructingFragmentId, setReconstructingFragmentId] = useState<string | null>(null);
  const [momentJobs, setMomentJobs] = useState<Array<{ jobId: string; fragmentId: string }>>([]);
  const [reconstructionMessage, setReconstructionMessage] = useState<string | null>(null);
  const [storyJobs, setStoryJobs] = useState(initialStoryJobIds);
  const [storyMessage, setStoryMessage] = useState<string | null>(null);
  const [requestingStories, setRequestingStories] = useState(false);
  const [legacyMediaCleanupRequired, setLegacyMediaCleanupRequired] = useState(
    initialFragments.some((fragment) =>
      fragment.source === "upload" &&
      fragment.type !== "voice" &&
      ((fragment.type === "image" || fragment.type === "video")
        ? fragment.mediaStorageAvailable !== true
        : true),
    ),
  );
  const [groupMemoryConfigured, setGroupMemoryConfigured] = useState(false);
  const [groupMemoryEnabled, setGroupMemoryEnabled] = useState(false);
  const [groupMemoryStatus, setGroupMemoryStatus] = useState("disabled");
  const [groupMemoryLoading, setGroupMemoryLoading] = useState(true);
  const [groupMemoryPending, setGroupMemoryPending] = useState(false);
  const [groupMemoryMessage, setGroupMemoryMessage] = useState<string | null>(null);
  const [sharedCorrections, setSharedCorrections] = useState<Array<{
    momentId: string;
    correctionId: string;
    status: string;
  }>>([]);
  const fragmentsById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const reconstructableFragments = fragments.filter((fragment) =>
    fragment.visibility === "group" &&
    fragment.aiProcessingConsent &&
    (fragment.status === "processed" || fragment.status === "needs_review") &&
    ((fragment.type === "image" || fragment.type === "video")
      ? fragment.mediaStorageAvailable === true
      : hasApprovedTextSource(fragment)),
  );
  const contributorLabels = new Map(
    [...new Set(fragments.map((fragment) => fragment.authorUserId))]
      .map((authorUserId, index) => [authorUserId, `Contributor ${index + 1}`]),
  );

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/groups/${groupId}/memory`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("memory_status_unavailable");
        return await response.json() as {
          configured?: boolean;
          enabled?: boolean;
          status?: string;
          sharedCorrections?: typeof sharedCorrections;
        };
      })
      .then((result) => {
        if (cancelled) return;
        setGroupMemoryConfigured(result.configured === true);
        setGroupMemoryEnabled(result.enabled === true);
        setGroupMemoryStatus(result.status ?? "disabled");
        setSharedCorrections(result.sharedCorrections ?? []);
      })
      .catch(() => {
        if (!cancelled) setGroupMemoryMessage("Could not load the group memory settings.");
      })
      .finally(() => {
        if (!cancelled) setGroupMemoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  useEffect(() => {
    const activeFragments = fragments.filter((fragment) =>
      fragment.aiProcessingConsent && (
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
          const result = await response.json() as {
            status?: GroupFragmentView["processingJobStatus"];
            fragmentStatus?: GroupFragmentView["status"];
            analysis?: MemberFragmentAnalysis;
            errorCategory?: string;
          };
          if (!cancelled && "status" in result) {
            setFragments((current) => current.map((item) =>
              item.id === fragment.id
                ? {
                    ...item,
                    processingJobStatus: result.status ?? null,
                    ...(result.fragmentStatus ? { status: result.fragmentStatus } : {}),
                    ...(result.analysis ? { analysis: result.analysis } : {}),
                    ...(result.errorCategory ? { processingError: result.errorCategory } : {}),
                  }
                : item,
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

  useEffect(() => {
    if (!storyJobs.length) return;
    let cancelled = false;
    let requestInFlight = false;
    const interval = window.setInterval(async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        await Promise.all(storyJobs.map(async (jobId) => {
          const response = await fetch(
            `/api/groups/${groupId}/stories/jobs/${encodeURIComponent(jobId)}`,
            { cache: "no-store" },
          );
          const result = await response.json() as {
            status?: string;
            outcome?: "candidate" | "insufficient_evidence";
            story?: MemberStory;
            error?: string;
          };
          if (cancelled) return;
          if (!response.ok) {
            setStoryMessage(result.error ?? "Could not check the Story reconstruction job.");
            setStoryJobs((current) => current.filter((item) => item !== jobId));
          } else if (result.status === "failed") {
            setStoryMessage("Story reconstruction failed. You can request another attempt.");
            setStoryJobs((current) => current.filter((item) => item !== jobId));
          } else if (result.status === "succeeded") {
            if (result.outcome === "candidate" && result.story) {
              const story = result.story;
              setStories((current) => [
                story,
                ...current.filter((item) => item.id !== story.id),
              ]);
              setStoryMessage("A recurring Story connection is ready.");
            } else {
              setStoryMessage("There is not enough supported evidence to suggest a Story connection.");
            }
            setStoryJobs((current) => current.filter((item) => item !== jobId));
          }
        }));
      } catch {
        if (!cancelled) setStoryMessage("Could not reach the Story reconstruction service.");
      } finally {
        requestInFlight = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [groupId, storyJobs]);

  async function requestGroupDeletion() {
    if (!window.confirm("Mark this group for deletion and block further access?")) return;
    setGroupDeletionRequesting(true);
    setGroupDeletionMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}`, { method: "DELETE" });
      const result = await response.json() as {
        legacyMediaCleanupRequired?: boolean;
        error?: string;
      };
      if (response.status === 202) {
        setGroupDeletionMessage(
          result.legacyMediaCleanupRequired
            ? "Group access is disabled. Original media files from previous uploads still need manual cleanup from the former storage bucket."
            : "Group deletion is pending cleanup. Members can no longer access this space.",
        );
        setGroupDeletionPending(true);
      } else {
        setGroupDeletionMessage(result.error ?? "Could not prepare group deletion.");
      }
    } catch {
      setGroupDeletionMessage("Could not reach the group deletion service.");
    } finally {
      setGroupDeletionRequesting(false);
    }
  }

  async function retryProcessing(fragment: GroupFragmentView) {
    const jobId = `ingest:${groupId}:${fragment.id}:${fragment.processingVersion}`;
    try {
      const response = await fetch(
        `/api/groups/${groupId}/processing-jobs/${encodeURIComponent(jobId)}`,
        { method: "POST" },
      );
      const result = await response.json() as { error?: string };
      if (response.status === 202) {
        setFragments((current) => current.map((item) =>
          item.id === fragment.id
            ? { ...item, status: "uploaded", processingJobStatus: "queued", processingError: undefined }
            : item,
        ));
      } else {
        setFragments((current) => current.map((item) =>
          item.id === fragment.id
            ? { ...item, processingError: result.error ?? "Retry could not be queued." }
            : item,
        ));
      }
    } catch {
      setFragments((current) => current.map((item) =>
        item.id === fragment.id
          ? { ...item, processingError: "Could not reach the processing service. Check that the app and MongoDB queue worker are running." }
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

  async function findStoryConnections() {
    setRequestingStories(true);
    setStoryMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/stories`, {
        method: "POST",
        headers: { "Idempotency-Key": window.crypto.randomUUID() },
      });
      const result = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !result.jobId) {
        setStoryMessage(result.error ?? "Could not request Story reconstruction.");
        return;
      }
      setStoryJobs((current) => [...new Set([...current, result.jobId!])]);
      setStoryMessage("Story reconstruction queued in the background.");
    } catch {
      setStoryMessage("Could not reach the Story reconstruction service.");
    } finally {
      setRequestingStories(false);
    }
  }

  function reviewMoment(sourceMomentId: string, updatedMoment: MemberMoment) {
    setMoments((current) => {
      const remaining = current.filter((item) => item.id !== sourceMomentId && item.id !== updatedMoment.id);
      return updatedMoment.status === "candidate" || updatedMoment.status === "confirmed"
        ? [updatedMoment, ...remaining]
        : remaining;
    });
    setStories((current) => current.filter((story) =>
      !story.momentIds.includes(sourceMomentId) &&
      !story.momentIds.includes(updatedMoment.id),
    ));
  }

  async function setGroupMemoryEnabledByAdmin(enabled: boolean) {
    const confirmed = enabled
      ? window.confirm(
          "Enable Backboard group memory? Read-only searches send brief summaries and entities from group-visible, AI-consented fragments to Backboard. Only corrections a member explicitly shares are stored as memories.",
        )
      : window.confirm(
          "Disable Backboard group memory and delete this group's Backboard assistant and stored memories?",
        );
    if (!confirmed) return;
    setGroupMemoryPending(true);
    setGroupMemoryMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/memory`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const result = await response.json() as { status?: string; error?: string };
      if (!response.ok) {
        setGroupMemoryMessage(result.error ?? "Could not update group memory settings.");
        try {
          const statusResponse = await fetch(`/api/groups/${groupId}/memory`, { cache: "no-store" });
          if (!statusResponse.ok) throw new Error("status_refresh_failed");
          const latest = await statusResponse.json() as {
            configured?: boolean;
            enabled?: boolean;
            status?: string;
            sharedCorrections?: typeof sharedCorrections;
          };
          setGroupMemoryConfigured(latest.configured === true);
          setGroupMemoryEnabled(latest.enabled === true);
          setGroupMemoryStatus(latest.status ?? "disabled");
          setSharedCorrections(latest.sharedCorrections ?? []);
        } catch {
          setGroupMemoryMessage((message) =>
            `${message ?? "Could not update group memory settings."} Current status could not be refreshed.`,
          );
        }
        return;
      }
      setGroupMemoryStatus(result.status ?? (enabled ? "enabled" : "disabled"));
      setGroupMemoryEnabled(enabled && result.status !== "provisioning");
      setGroupMemoryMessage(enabled
        ? result.status === "already_enabled"
          ? "Backboard group memory is already enabled."
          : result.status === "provisioning"
            ? "Backboard group memory setup is already in progress."
            : "Backboard group memory enabled. Corrections are shared only when a member explicitly chooses to share them."
        : "Backboard group memory disabled and provider data removed.");
      if (!enabled) setSharedCorrections([]);
    } catch {
      setGroupMemoryMessage("Could not reach the Backboard group memory service.");
    } finally {
      setGroupMemoryPending(false);
    }
  }

  function updateSharedCorrection(momentId: string, correctionId: string, shared: boolean) {
    setSharedCorrections((current) => shared
      ? [...current.filter((item) => item.correctionId !== correctionId), {
          momentId,
          correctionId,
          status: "synced",
        }]
      : current.filter((item) => item.correctionId !== correctionId));
  }

  return (
    <main className="shell trust-page group-page" id="main-content">
      <a className="skip-link" href="#group-content">Skip to group timeline</a>
      <div className="group-local-actions">
        <span className="eyebrow">A SHARED SPACE</span>
        <Link className="primary-button" href="#add-fragment">Post a memory <span aria-hidden="true">+</span></Link>
      </div>
      <section className="intro">
        <p className="eyebrow"><span className="eyebrow-mark" />PRIVATE GROUP / MEMORY ATLAS</p>
        <h1>{groupName}</h1>
        <p className="lede">Fragments from your group, gathered in one place. What becomes a shared memory is always up to you.</p>
        <div className="group-overview">
          <span><strong>{fragments.length.toString().padStart(2, "0")}</strong> fragments</span>
          <span><strong>{moments.length.toString().padStart(2, "0")}</strong> moments</span>
          <span className="overview-private"><span aria-hidden="true">●</span> Private space</span>
        </div>
      </section>
      {!groupDeletionPending && (
        <nav className="atlas-nav" aria-label="Sections in this group">
          <a href="#add-fragment">Add a fragment <span aria-hidden="true">+</span></a>
          <a href="#fragments">Fragments <span>{fragments.length.toString().padStart(2, "0")}</span></a>
          <a href="#moments">Moments <span>{moments.length.toString().padStart(2, "0")}</span></a>
          <a href="#stories">Stories <span>{stories.length.toString().padStart(2, "0")}</span></a>
          <Link href={`/groups/${groupId}/story`}>Event story</Link>
          <a href="#group-memory">Group memory</a>
          {(memberRole === "owner" || memberRole === "admin") && (
            <a href="#invite-people">Invite people</a>
          )}
        </nav>
      )}
      {!groupDeletionPending && (memberRole === "owner" || memberRole === "admin") && (
        <div id="invite-people" className="group-invite-anchor">
          <GroupInvitePanel groupId={groupId} groupName={groupName} />
        </div>
      )}
      {groupDeletionPending ? (
        <p className="setup-message" role="status">{groupDeletionMessage}</p>
      ) : (
        <section className="group-detail-grid" id="group-content" tabIndex={-1} aria-label="Group memory workspace">
          <div>
            <FragmentComposer
              groupId={groupId}
              onCreated={(fragment) =>
                setFragments((current) => [fragment, ...current.filter((item) => item.id !== fragment.id)])
              }
            />
            {legacyMediaCleanupRequired && (
              <p className="setup-message" role="note">
                Some older uploaded media is stored in an unsupported legacy location and may need manual cleanup.
              </p>
            )}
            <div className="section-head" id="fragments">
              <div><p className="eyebrow">THE SOURCE MATERIAL</p><h2>Fragments</h2></div>
              <span>{fragments.length} visible to you</span>
            </div>
            <div className="fragment-list fragment-timeline">
              {fragments.map((fragment) => (
                <article className="group-fragment" key={fragment.id}>
                  <div className="fragment-row">
                    <time className="fragment-time">{formatCaptureTime(fragment.capturedAt)}</time>
                    <span className={`fragment-kind-chip ${contributorTone(fragment.authorUserId)}`}>
                      {fragment.type === "voice"
                        ? "Voice note"
                        : fragment.type === "image"
                          ? "Photo"
                          : fragment.type === "video"
                            ? "Video"
                            : "Text note"}
                    </span>
                    <span className={`visibility-chip visibility-${fragment.visibility}`}>{fragment.visibility === "private" ? "Only me" : fragment.visibility}</span>
                  </div>
                  <p className="fragment-copy">{fragment.textContent ?? fragment.caption ?? (
                    fragment.type === "voice"
                      ? "Voice note — transcript is private until you approve it."
                      : fragment.type === "image"
                        ? "A photo shared with this space."
                        : fragment.type === "video"
                          ? "A video shared with this space."
                          : "Media source is unavailable."
                  )}</p>
                  {fragment.source === "upload" &&
                    fragment.mediaStorageAvailable &&
                    fragment.type === "image" && (
                    <div className="group-media-preview">
                      <GroupPhoto
                        groupId={groupId}
                        fragmentId={fragment.id}
                        alt={fragment.caption || "Photo shared to this group"}
                      />
                    </div>
                  )}
                  {fragment.source === "upload" &&
                    fragment.mediaStorageAvailable &&
                    fragment.type === "video" && (
                    <video
                      className="group-media-preview group-media-video"
                      controls
                      preload="metadata"
                      playsInline
                      src={`/api/groups/${groupId}/fragments/${fragment.id}/media`}
                    >
                      Your browser does not support video playback.
                    </video>
                  )}
                  <p className={`contributor-label ${contributorTone(fragment.authorUserId)}`}>
                    <span aria-hidden="true" />{contributorLabels.get(fragment.authorUserId) ?? "Group member"}
                  </p>
                  {fragment.type === "voice" && fragment.source === "upload" && (
                    <AudioWaveform
                      src={`/api/groups/${groupId}/fragments/${fragment.id}/audio`}
                      label={fragment.caption ? `Audio: ${fragment.caption}` : "Group audio post"}
                    />
                  )}
                  {((fragment.type === "image" || fragment.type === "video")
                    ? fragment.mediaStorageAvailable === true
                    : hasApprovedTextSource(fragment)) &&
                    fragment.visibility === "group" &&
                    fragment.aiProcessingConsent &&
                    (fragment.status === "processed" || fragment.status === "needs_review") && (
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
                  {fragment.aiProcessingConsent && (
                    <p className="fragment-processing-status" role="status">
                      {fragment.type === "voice" && !fragment.transcriptReviewedAt
                        ? "Gemma waits until you review the transcript; the audio itself is not sent."
                        : fragment.status === "needs_review"
                        ? "Gemma observations are ready for review; they are not verified facts."
                        : fragment.processingJobStatus === "queued" ||
                            fragment.processingJobStatus === "running" ||
                            fragment.processingJobStatus === "retrying"
                          ? `Private Gemma processing: ${fragment.processingJobStatus}.`
                          : fragment.processingJobStatus === "failed" || fragment.status === "rejected"
                            ? "Private Gemma processing failed. The original fragment is still saved."
                            : fragment.status === "processed"
                              ? "Private Gemma analysis is ready for reconstruction."
                              : "Private Gemma processing is waiting to start."}
                    </p>
                  )}
                  {fragment.aiProcessingConsent && fragment.processingJobStatus === "failed" && (
                    <p className="fragment-processing-status" role="status">
                      {fragmentFailureMessage(fragment.processingError)}
                    </p>
                  )}
                  {fragment.analysis && fragment.aiProcessingConsent && (
                    <section className="fragment-analysis" aria-label="Gemma observations">
                      <h3>Gemma&apos;s tentative observations</h3>
                      <p>{fragment.analysis.summary || "No summary was returned."}</p>
                      {fragment.analysis.observedFacts.length ? (
                            <ul>
                              {fragment.analysis.observedFacts.map((fact, index) => (
                                <li key={`${fact.type}-${fact.value}-${index}`}>
                                  <strong>{fact.type.replace("_", " ")}:</strong> {fact.value}
                                  <span> — evidence: “{fact.evidence.evidence}”</span>
                                </li>
                              ))}
                            </ul>
                      ) : (
                            <p>No directly supported observations were found in this fragment.</p>
                      )}
                      <p>
                            Tentative; not verified facts. Confidence: {Math.round(fragment.analysis.confidence * 100)}%.
                            {" "}{fragment.analysis.uncertainty.reason}
                      </p>
                    </section>
                  )}
                  {fragment.processingError && fragment.processingJobStatus !== "failed" && (
                    <p className="fragment-processing-status" role="status">{fragment.processingError}</p>
                  )}
                  {fragment.processingJobStatus === "failed" &&
                    (fragment.source !== "upload" ||
                      fragment.type === "voice" ||
                      fragment.type === "image" ||
                      fragment.type === "video") && (
                    <button className="text-button" type="button" onClick={() => void retryProcessing(fragment)}>
                      Retry processing
                    </button>
                  )}
                  {fragment.type === "voice" &&
                    fragment.authorUserId === currentUserId &&
                    !fragment.transcriptReviewedAt && (
                    <VoiceTranscriptReview
                      groupId={groupId}
                      fragmentId={fragment.id}
                      initialAiConsent={fragment.aiProcessingConsent}
                      onApproved={(updated) => {
                        setFragments((current) => current.map((item) =>
                          item.id === updated.id ? updated : item,
                        ));
                      }}
                    />
                  )}
                  <FragmentPrivacyControls
                    groupId={groupId}
                    fragmentId={fragment.id}
                    hasLegacyMedia={
                      fragment.source === "upload" &&
                      fragment.type !== "voice" &&
                      ((fragment.type !== "image" && fragment.type !== "video") ||
                        fragment.mediaStorageAvailable !== true)
                    }
                    allowAiProcessing={
                      (fragment.type !== "image" && fragment.type !== "video") ||
                      fragment.mediaStorageAvailable === true
                    }
                    initialVisibility={fragment.visibility}
                    initialConsent={fragment.aiProcessingConsent}
                    canEditPrivacy={
                      fragment.authorUserId === currentUserId &&
                      (fragment.type !== "voice" || Boolean(fragment.transcriptReviewedAt))
                    }
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
                        setStories((current) => current.filter((story) =>
                          !story.evidence.some((item) => item.fragmentIds.includes(update.fragmentId)),
                        ));
                      }
                    }}
                    onDeleted={(fragmentId) => {
                      if (fragments.some((item) =>
                        item.id === fragmentId &&
                        item.source === "upload" &&
                        item.type !== "voice" &&
                        ((item.type !== "image" && item.type !== "video") || !item.mediaStorageAvailable),
                      )) {
                        setLegacyMediaCleanupRequired(true);
                      }
                      setFragments((current) => current.filter((item) => item.id !== fragmentId));
                      setMoments((current) => current.filter((moment) =>
                        !moment.evidence.some((item) => item.fragmentId === fragmentId),
                      ));
                      setStories((current) => current.filter((story) =>
                        !story.evidence.some((item) => item.fragmentIds.includes(fragmentId)),
                      ));
                    }}
                  />
                </article>
              ))}
              {!fragments.length && <p className="empty-moment">This group has no fragments yet.</p>}
            </div>
          </div>
          <div className="moment-panel" id="moments">
            <div className="section-head">
              <div><p className="eyebrow">MEMORIES TAKING SHAPE</p><h2>Moments</h2></div>
              <span>{moments.length} reconstructed</span>
            </div>
            <section className="group-memory-settings" id="group-memory" aria-label="Group memory settings">
              <div>
                <strong>Backboard group memory</strong>
                <p>
                  When enabled, brief summaries and entities from group-visible, AI-consented fragments may be used as read-only search queries.
                  Only a correction on a confirmed Moment is stored, and only after a member explicitly shares it.
                  Disabling removes this group&apos;s Backboard assistant and its memories.
                </p>
                {groupMemoryMessage && <p className="privacy-status" role="status">{groupMemoryMessage}</p>}
              </div>
              {!groupMemoryLoading && (memberRole === "owner" || memberRole === "admin") && (
                groupMemoryConfigured ? (
                  <button
                    className={groupMemoryEnabled || groupMemoryStatus === "disabling"
                      ? "text-button danger-button"
                      : "text-button"}
                    type="button"
                    disabled={groupMemoryPending || groupMemoryStatus === "creating"}
                    onClick={() => void setGroupMemoryEnabledByAdmin(
                      !groupMemoryEnabled && groupMemoryStatus !== "disabling",
                    )}
                  >
                    {groupMemoryPending
                      ? "Updating…"
                      : groupMemoryStatus === "disabling"
                        ? "Retry provider cleanup"
                        : groupMemoryEnabled
                        ? "Disable group memory"
                        : "Enable group memory"}
                  </button>
                ) : (
                  <p className="privacy-status">Backboard is unavailable until the server is configured.</p>
                )
              )}
            </section>
            {reconstructionMessage && <p className="privacy-status" role="status">{reconstructionMessage}</p>}
            {moments.map((moment) => (
              <article className="group-moment" key={moment.id}>
                <div className="moment-card-head">
                  <span className={`moment-status uncertainty-${moment.uncertaintyLabel}`}>{moment.uncertaintyLabel}</span>
                  <span className="moment-state">{moment.status === "candidate" ? "Awaiting your review" : moment.status}</span>
                </div>
                <h3>{moment.title ?? "A possible moment"}</h3>
                <p className="moment-card-summary">{moment.summary}</p>
                <ol className="moment-atlas" aria-label={`Evidence timeline for ${moment.title ?? "possible moment"}`}>
                  {moment.evidence.map((evidence, index) => {
                    const source = fragmentsById.get(evidence.fragmentId);
                    return (
                      <li className="atlas-stop" key={evidence.fragmentId}>
                        <div className="atlas-stop-marker">
                          <span className={`atlas-contributor ${source ? contributorTone(source.authorUserId) : "tone-1"}`}>
                            {index + 1}
                          </span>
                        </div>
                        <div className="atlas-stop-copy">
                          <span className="atlas-stop-time">
                            {source ? formatCaptureTime(source.capturedAt) : "Source unavailable"}
                          </span>
                          <p>{source?.textContent ?? source?.caption ?? "Evidence is not visible to this member"}</p>
                          {source?.type === "image" && source.mediaStorageAvailable && (
                            <GroupPhoto
                              className="moment-evidence-photo"
                              groupId={groupId}
                              fragmentId={source.id}
                              alt={source.caption || `Photo evidence ${index + 1} for this moment`}
                            />
                          )}
                          {source && (
                            <span className={`contributor-label ${contributorTone(source.authorUserId)}`}>
                              <span aria-hidden="true" />{contributorLabels.get(source.authorUserId) ?? "Group member"}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <details className="moment-why">
                  <summary>Why these fragments connect <span aria-hidden="true">+</span></summary>
                  <ul className="evidence-list">
                    {moment.evidence.map((evidence) => (
                      <li key={evidence.fragmentId}>
                        <strong>{relationshipLabels[evidence.relationship]}</strong>
                        {fragmentsById.get(evidence.fragmentId)?.textContent ??
                          fragmentsById.get(evidence.fragmentId)?.caption ??
                          "Evidence is not visible to this member"}
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
                            {fragmentsById.get(source.fragmentId)?.textContent ??
                              fragmentsById.get(source.fragmentId)?.caption ??
                              "Evidence is not visible to this member"}: “{source.quote}”
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
                </details>
                <MomentReviewControls
                  groupId={groupId}
                  moment={moment}
                  groupMemoryEnabled={groupMemoryEnabled}
                  sharedCorrectionIds={new Set(sharedCorrections
                    .filter((item) => item.momentId === moment.id && item.status === "synced")
                    .map((item) => item.correctionId))}
                  otherMoments={moments.filter((other) =>
                    other.id !== moment.id &&
                    (other.status === "candidate" || other.status === "confirmed"),
                  )}
                  onReview={(sourceId, updated, cleanupPending) => {
                    reviewMoment(sourceId, updated);
                    if (!cleanupPending) {
                      const keptCorrectionIds = new Set(
                        updated.status === "confirmed"
                          ? updated.corrections?.map((item) => item.id) ?? []
                          : [],
                      );
                      setSharedCorrections((current) => current.filter((item) =>
                        item.momentId !== sourceId &&
                        item.momentId !== updated.id ||
                        keptCorrectionIds.has(item.correctionId),
                      ));
                    }
                  }}
                  onMemoryChanged={updateSharedCorrection}
                />
              </article>
            ))}
            {!moments.length && (
              <div className="moment-start-card">
                <span className="moment-start-number">01</span>
                <div>
                  <h3>No moments yet</h3>
                  <p>
                    {reconstructableFragments.length
                      ? `${reconstructableFragments.length} fragment${reconstructableFragments.length === 1 ? " is" : "s are"} ready. Ask Gemma to connect the clues, then review the suggestion before it becomes a shared Moment.`
                      : "Share a fragment with the group and allow Gemma to analyze it. Once processing is ready, request a reconstruction from that fragment."}
                  </p>
                  <a className="secondary-button" href="#fragments">Review fragments <span aria-hidden="true">↗</span></a>
                </div>
              </div>
            )}
          </div>
          <div className="moment-panel" id="stories">
            <div className="section-head">
              <div><p className="eyebrow">PATTERNS ACROSS CONFIRMED MOMENTS</p><h2>Stories</h2></div>
              <button
                className="text-button"
                type="button"
                disabled={
                  requestingStories ||
                  storyJobs.length > 0 ||
                  moments.filter((moment) => moment.status === "confirmed").length < 2
                }
                onClick={() => void findStoryConnections()}
              >
                {requestingStories || storyJobs.length > 0
                  ? "Finding connections…"
                  : moments.filter((moment) => moment.status === "confirmed").length < 2
                    ? "Confirm two Moments first"
                    : "Find story connections"}
              </button>
            </div>
            <p className="privacy-status">
              Gemma compares only confirmed Moments and their eligible, group-visible source observations.
              Each connection stays a hypothesis until a member confirms it.
            </p>
            {storyMessage && <p className="privacy-status" role="status">{storyMessage}</p>}
            {stories.map((story) => (
              <article className="group-moment" key={story.id}>
                <div className="moment-card-head">
                  <span className={`moment-status uncertainty-${story.uncertaintyLabel}`}>
                    {story.uncertaintyLabel}
                  </span>
                  <span className="moment-state">
                    {story.status === "candidate" ? "Awaiting your review" : story.status}
                  </span>
                </div>
                <h3>{story.title}</h3>
                <p className="moment-card-summary">{story.summary}</p>
                <ol className="evidence-list" aria-label={`Evidence for Story ${story.title}`}>
                  {story.evidence.map((item) => {
                    const sourceMoment = moments.find((moment) => moment.id === item.momentId);
                    return (
                      <li key={item.momentId}>
                        <strong>{sourceMoment?.title ?? "Confirmed moment"}</strong>
                        <p>{sourceMoment?.summary ?? "This moment is no longer visible."}</p>
                        <span>Connection: {item.relationship.replaceAll("_", " ")}</span>
                      </li>
                    );
                  })}
                </ol>
                <StoryReviewControls
                  groupId={groupId}
                  story={story}
                  onReview={(updated) => setStories((current) =>
                    updated.status === "rejected"
                      ? current.filter((item) => item.id !== updated.id)
                      : current.map((item) => item.id === updated.id ? updated : item),
                  )}
                />
              </article>
            ))}
            {!stories.length && <p className="empty-moment">No recurring Story connections are ready yet.</p>}
          </div>
        </section>
      )}
      {!groupDeletionPending && memberRole === "owner" && (
        <>
          {groupDeletionMessage && <p className="privacy-status" role="status">{groupDeletionMessage}</p>}
          <button
            className="text-button danger-button"
            disabled={groupDeletionRequesting}
            onClick={() => void requestGroupDeletion()}
          >
            {groupDeletionRequesting ? "Preparing deletion…" : "Request group deletion"}
          </button>
        </>
      )}
    </main>
  );
}