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
  const [capturedAt, setCapturedAt] = useState(localDateTimeValue);
  const [visibility, setVisibility] = useState<FragmentVisibility>("private");
  const [aiProcessingConsent, setAiProcessingConsent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

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
      const result = await response.json() as { fragment: GroupFragmentView; processingStatus: string };
      onCreated(result.fragment);
      setTextContent("");
      idempotencyKey.current = null;
      setMessage(result.processingStatus === "queued" ? "Text fragment saved and queued." : "Text fragment saved; processing could not start.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Text fragment could not be saved.");
    } finally {
      setIsSubmitting(false);
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
          <input type="datetime-local" value={capturedAt} required onChange={(event) => setCapturedAt(event.target.value)} />
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
    </section>
  );
}
