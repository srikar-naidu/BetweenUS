"use client";

import { useRef, useState } from "react";
import type { FragmentVisibility } from "@/lib/domain/memory";
import type { GroupFragmentView } from "@/components/group-detail";

function localDateTimeValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    return "Request could not be completed.";
  }
  return "Request could not be completed.";
}

export function FragmentComposer({
  groupId,
  onCreated,
}: {
  groupId: string;
  onCreated: (fragment: GroupFragmentView) => void;
}) {
  const [textContent, setTextContent] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [transcriptionConsent, setTranscriptionConsent] = useState(false);
  const [voiceSubmitting, setVoiceSubmitting] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState(localDateTimeValue);
  const [visibility, setVisibility] = useState<FragmentVisibility>("private");
  const [aiProcessingConsent, setAiProcessingConsent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const voiceIdempotencyKey = useRef<string | null>(null);

  async function submitText(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!textContent.trim()) {
      setMessage("Enter a text fragment first.");
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/groups/${groupId}/fragments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          textContent,
          capturedAt: new Date(capturedAt).toISOString(),
          capturedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          visibility,
          aiProcessingConsent,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as {
        fragment: GroupFragmentView;
        processingStatus: GroupFragmentView["processingJobStatus"];
      };
      onCreated(result.fragment);
      setTextContent("");
      idempotencyKey.current = null;
      setMessage(
        result.processingStatus === "queued"
          ? "Text fragment saved and queued."
          : result.processingStatus === null
            ? "Text fragment saved. AI processing is off."
            : "Text fragment saved; processing could not start.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Text fragment could not be saved.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitVoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!voiceFile) {
      setVoiceMessage("Choose a WAV voice note first.");
      return;
    }
    setVoiceSubmitting(true);
    setVoiceMessage(null);
    voiceIdempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/groups/${groupId}/voice`, {
        method: "POST",
        headers: {
          "Content-Type": voiceFile.type || "audio/wav",
          "Idempotency-Key": voiceIdempotencyKey.current,
          "X-Captured-At": new Date(capturedAt).toISOString(),
          "X-Captured-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone,
          "X-Transcription-Consent": String(transcriptionConsent),
        },
        body: voiceFile,
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as {
        fragment: GroupFragmentView;
        transcriptionStatus: string;
        manualReason?: string | null;
      };
      onCreated(result.fragment);
      voiceIdempotencyKey.current = null;
      setVoiceFile(null);
      setTranscriptionConsent(false);
      setVoiceMessage(result.transcriptionStatus === "transcribing"
        ? "Voice note uploaded privately. Transcription is queued; review it before sharing."
        : result.manualReason === "monthly_limit"
          ? "Monthly transcription limit reached. The note is private; enter the transcript manually to continue."
          : result.manualReason === "provider_disabled"
            ? "ElevenLabs is not enabled. The note is private; enter the transcript manually to continue."
            : "Voice note uploaded privately. Enter or review the transcript before sharing.");
    } catch (error) {
      setVoiceMessage(error instanceof Error ? error.message : "Voice note could not be saved.");
    } finally {
      setVoiceSubmitting(false);
    }
  }

  return (
    <section className="fragment-composer" aria-labelledby="fragment-composer-title">
      <div className="section-head">
        <h2 id="fragment-composer-title">Add a fragment</h2>
        <span>Private by default</span>
      </div>
      <form className="fragment-composer-form" onSubmit={submitText}>
        <label>
          Text
          <textarea value={textContent} maxLength={10_000} required onChange={(event) => setTextContent(event.target.value)} />
        </label>
        <label>
          Captured at
          <input type="datetime-local" value={capturedAt} required onChange={(event) => {
            setCapturedAt(event.target.value);
            idempotencyKey.current = null;
            voiceIdempotencyKey.current = null;
          }} />
        </label>
        <label>
          Visibility
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as FragmentVisibility)}>
            <option value="private">Only me</option>
            <option value="group">Group</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <label className="consent-control">
          <input type="checkbox" checked={aiProcessingConsent} onChange={(event) => setAiProcessingConsent(event.target.checked)} />
          Allow AI processing
        </label>
        <button className="primary-button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save text fragment"}
        </button>
        {message && <p className="privacy-status" role="status">{message}</p>}
      </form>
      <form className="fragment-composer-form voice-composer-form" onSubmit={submitVoice}>
        <label>
          Voice note (WAV, mono 16-bit PCM at 16 kHz, up to 60 seconds / 2 MB)
          <input
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            onChange={(event) => {
              setVoiceFile(event.target.files?.[0] ?? null);
              setTranscriptionConsent(false);
              voiceIdempotencyKey.current = null;
            }}
          />
        </label>
        <label className="consent-control">
          <input
            type="checkbox"
            checked={transcriptionConsent}
            onChange={(event) => setTranscriptionConsent(event.target.checked)}
          />
          I explicitly consent to sending this audio to ElevenLabs for transcription.
        </label>
        <p className="privacy-status">
          Audio is stored privately by Between Us. Transcription is optional and may be unavailable
          when disabled or at its monthly usage limit; in that case, you can enter a transcript manually.
          The transcript stays private until you review and approve it.
        </p>
        <button className="secondary-button" type="submit" disabled={voiceSubmitting || !voiceFile}>
          {voiceSubmitting ? "Uploading…" : "Save private voice note"}
        </button>
        {voiceMessage && <p className="privacy-status" role="status">{voiceMessage}</p>}
      </form>
    </section>
  );
}
