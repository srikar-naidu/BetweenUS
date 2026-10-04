"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface AudioJobView {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCategory: string | null;
  audioUrl?: string;
}

function audioStatusMessage(job: AudioJobView | null): string {
  if (!job) return "Create a narrated version with an original instrumental score.";
  if (job.status === "queued") return "Your narration and score are in the studio queue.";
  if (job.status === "running") return "Composing the voice and original background score…";
  if (job.status === "succeeded") return "Your story soundtrack is ready.";
  if (job.errorCategory === "story_audio_monthly_limit") return "This month’s story-audio generation limit has been reached.";
  if (job.errorCategory === "story_audio_story_too_long") return "Shorten this story to 3,500 characters and try again.";
  if (job.errorCategory === "story_audio_story_changed") return "The story changed during generation. Reload and try again.";
  if (job.errorCategory === "story_audio_provider_unavailable") return "Story-audio generation is temporarily unavailable. Please try again later.";
  return "Audio generation failed. Please try again; contact an administrator if the problem continues.";
}

export function StoryAudioControls() {
  const pathname = usePathname();
  const match = pathname.match(/^\/groups\/([^/]+)\/story\/?$/);
  const groupId = match?.[1] ?? null;
  const [job, setJob] = useState<AudioJobView | null>(null);
  const [configured, setConfigured] = useState(false);
  const [externalProcessingConsent, setExternalProcessingConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobIsActive = job?.status === "queued" || job?.status === "running";

  useEffect(() => {
    setJob(null);
    setError(null);
    setExternalProcessingConsent(false);
    if (!groupId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/event-story/audio`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("status_unavailable");
        const result = await response.json() as { configured?: boolean; job?: AudioJobView | null };
        if (cancelled) return;
        setConfigured(result.configured === true);
        setJob(result.job ?? null);
      } catch {
        if (!cancelled) setError("Could not load story-audio status.");
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [groupId]);

  useEffect(() => {
    if (!groupId || !jobIsActive) return;
    const timer = setInterval(() => {
      void fetch(`/api/groups/${encodeURIComponent(groupId)}/event-story/audio`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("status_unavailable");
          return await response.json() as { job?: AudioJobView | null };
        })
        .then((result) => setJob(result.job ?? null))
        .catch(() => setError("Could not refresh story-audio status."));
    }, 2_000);
    return () => clearInterval(timer);
  }, [groupId, jobIsActive]);

  if (!groupId) return null;

  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/event-story/audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ externalProcessingConsent }),
      });
      const result = await response.json() as { jobId?: string; status?: AudioJobView["status"]; error?: string; audioUrl?: string };
      if (!response.ok) throw new Error(result.error ?? "Audio generation could not be queued.");
      if (result.jobId && result.status) {
        setJob({
          id: result.jobId,
          status: result.status,
          errorCategory: null,
          ...(result.audioUrl ? { audioUrl: result.audioUrl } : {}),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audio generation could not be queued.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="story-audio-controls" aria-label="Narrated story soundtrack">
      <div className="story-audio-copy">
        <p className="eyebrow">STORY SOUNDTRACK</p>
        <p>{audioStatusMessage(job)}</p>
      </div>
      {job?.status === "succeeded" && job.audioUrl ? (
        <audio controls preload="none" src={job.audioUrl}>
          Your browser does not support audio playback.
        </audio>
      ) : (
        <div className="story-audio-actions">
          <label>
            <input
              type="checkbox"
              checked={externalProcessingConsent}
              onChange={(event) => setExternalProcessingConsent(event.target.checked)}
            />
            Send this story text to ElevenLabs for narration under the account’s data-retention terms. The instrumental-score prompt contains no story details.
          </label>
          <button
            type="button"
            className="button button-primary"
            disabled={!configured || !externalProcessingConsent || pending || jobIsActive}
            onClick={() => void generate()}
          >
            {pending || jobIsActive ? "Creating audio…" : "Create narrated story + music"}
          </button>
        </div>
      )}
      {!configured && <p role="status">Story-audio generation is not configured on this server.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
