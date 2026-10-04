"use client";

import { useEffect, useState } from "react";
import type { GroupFragmentView } from "@/components/group-detail";

interface TranscriptResponse {
  status: "manual_review" | "transcribing" | "pending_review" | "failed" | "reviewed";
  transcript: string;
  words: Array<{ text: string; start: number; end: number; speakerId: string | null }>;
  languageCode: string | null;
  manualReason: string | null;
}

export function VoiceTranscriptReview({
  groupId,
  fragmentId,
  initialAiConsent,
  onApproved,
}: {
  groupId: string;
  fragmentId: string;
  initialAiConsent: boolean;
  onApproved: (fragment: GroupFragmentView) => void;
}) {
  const [transcript, setTranscript] = useState("");
  const [status, setStatus] = useState<TranscriptResponse["status"] | null>(null);
  const [aiConsent, setAiConsent] = useState(initialAiConsent);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(
          `/api/groups/${groupId}/fragments/${fragmentId}/transcript`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Could not load the voice transcript.");
        const result = await response.json() as TranscriptResponse;
        if (cancelled) return;
        setStatus(result.status);
        if (result.transcript && !transcript) setTranscript(result.transcript);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load the voice transcript.");
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => {
      if (status === "transcribing") void refresh();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fragmentId, groupId, status, transcript]);

  async function approve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/fragments/${fragmentId}/transcript`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          visibility: "group",
          aiProcessingConsent: aiConsent,
        }),
      });
      const result = await response.json() as {
        fragment?: GroupFragmentView;
        processingStatus?: string | null;
        error?: string;
      };
      if (!response.ok || !result.fragment) {
        setMessage(result.error ?? "Could not save the reviewed transcript.");
        return;
      }
      onApproved(result.fragment);
      setStatus("reviewed");
      setMessage(result.processingStatus === "queued"
        ? "Transcript approved, shared with the group, and Gemma analysis queued."
        : "Transcript approved and shared with the group.");
    } catch {
      setMessage("Could not reach the transcript review service.");
    } finally {
      setPending(false);
    }
  }

  if (status === "reviewed") {
    return message ? <p className="privacy-status" role="status">{message}</p> : null;
  }
  return (
    <section className="voice-transcript-review" aria-label="Review voice transcript">
      <h3>Voice note transcript</h3>
      {status === null ? (
        <p className="privacy-status" role="status">Loading transcript status…</p>
      ) : status === "transcribing" ? (
        <p className="privacy-status" role="status">
          Audio is visible to the group. The transcript remains private until you approve it.
        </p>
      ) : (
        <form className="fragment-composer-form" onSubmit={(event) => void approve(event)}>
          {status === "failed" && <p className="privacy-status">Transcription did not complete. You can enter or edit the transcript manually.</p>}
          <label>
            Review and edit transcript before sharing it with the group
            <textarea
              value={transcript}
              maxLength={10_000}
              required
              onChange={(event) => setTranscript(event.target.value)}
            />
          </label>
          <label className="consent-control">
            <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />
            Allow Gemma to classify this approved transcript
          </label>
          <button className="secondary-button" type="submit" disabled={pending || !transcript.trim()}>
            {pending ? "Saving…" : "Approve transcript"}
          </button>
        </form>
      )}
      {message && <p className="privacy-status" role="status">{message}</p>}
    </section>
  );
}
