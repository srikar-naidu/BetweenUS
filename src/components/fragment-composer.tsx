"use client";

import { useRef, useState } from "react";
import type { FragmentVisibility } from "@/lib/domain/memory";
import type { GroupFragmentView } from "@/components/group-detail";

type CaptureMode = "media" | "text";

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
  const [mode, setMode] = useState<CaptureMode>("media");
  const [mediaType, setMediaType] = useState<"image" | "screenshot">("image");
  const [file, setFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState("");
  const [caption, setCaption] = useState("");
  const [capturedAt, setCapturedAt] = useState(localDateTimeValue);
  const [visibility, setVisibility] = useState<FragmentVisibility>("private");
  const [aiProcessingConsent, setAiProcessingConsent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  async function submitMedia(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setMessage("Choose an image or short video first.");
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const fileType = file.type === "video/mp4" ? "video" : mediaType;
      const common = {
        type: fileType,
        contentType: file.type,
        size: file.size,
        capturedAt: new Date(capturedAt).toISOString(),
        capturedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        visibility,
        aiProcessingConsent,
        caption,
      };
      const reservation = await fetch(`/api/groups/${groupId}/fragments/uploads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify(common),
      });
      if (!reservation.ok) throw new Error(await readError(reservation));
      const upload = await reservation.json() as {
        uploadId: string;
        uploadUrl: string;
        contentType: string;
        alreadyCompleted?: boolean;
        fragment?: GroupFragmentView;
      };
      if (upload.alreadyCompleted) {
        if (upload.fragment) onCreated(upload.fragment);
      } else {
        const stored = await fetch(upload.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": upload.contentType },
          body: file,
        });
        if (!stored.ok) throw new Error("Private media upload failed. Retry the upload.");
        const completed = await fetch(
          `/api/groups/${groupId}/fragments/uploads/${upload.uploadId}/complete`,
          { method: "POST" },
        );
        if (!completed.ok) throw new Error(await readError(completed));
        const result = await completed.json() as {
          fragment?: Omit<GroupFragmentView, "processingJobStatus">;
          processingStatus?: GroupFragmentView["processingJobStatus"];
        };
        if (result.fragment) {
          onCreated({ ...result.fragment, processingJobStatus: result.processingStatus ?? null });
        }
      }
      setFile(null);
      setCaption("");
      idempotencyKey.current = null;
      setMessage("Fragment uploaded. Processing status is saved with the group.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload could not be completed.");
    } finally {
      setIsSubmitting(false);
    }
  }

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
      <div className="capture-tabs" role="tablist" aria-label="Fragment type">
        <button type="button" role="tab" aria-selected={mode === "media"} onClick={() => setMode("media")}>Photo or video</button>
        <button type="button" role="tab" aria-selected={mode === "text"} onClick={() => setMode("text")}>Text note</button>
      </div>
      <form className="fragment-composer-form" onSubmit={mode === "media" ? submitMedia : submitText}>
        {mode === "media" ? (
          <>
            <label>
              Media file
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4"
                required
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  idempotencyKey.current = null;
                }}
              />
            </label>
            {file?.type.startsWith("image/") && (
              <label>
                Image kind
                <select value={mediaType} onChange={(event) => setMediaType(event.target.value as "image" | "screenshot")}>
                  <option value="image">Photo</option>
                  <option value="screenshot">Screenshot</option>
                </select>
              </label>
            )}
            <label>
              Caption <span>Optional</span>
              <input value={caption} maxLength={1000} onChange={(event) => setCaption(event.target.value)} />
            </label>
          </>
        ) : (
          <label>
            Text
            <textarea value={textContent} maxLength={10_000} required onChange={(event) => setTextContent(event.target.value)} />
          </label>
        )}
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
          {isSubmitting ? "Saving…" : mode === "media" ? "Upload fragment" : "Save text fragment"}
        </button>
        {message && <p className="privacy-status" role="status">{message}</p>}
      </form>
    </section>
  );
}
