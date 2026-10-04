"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AudioWaveform } from "@/components/audio-waveform";
import type { GroupFragmentView } from "@/components/group-detail";
import { MAX_IMAGE_FILE_BYTES, MAX_VIDEO_FILE_BYTES } from "@/lib/ingestion/media-validation";
import { MAX_VOICE_FILE_BYTES } from "@/lib/ingestion/voice-validation";

type PostType = "text" | "image" | "audio" | "video";

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

const postTypes: Array<{ id: PostType; label: string }> = [
  { id: "text", label: "Text" },
  { id: "image", label: "Photo" },
  { id: "audio", label: "Audio" },
  { id: "video", label: "Video" },
];

export function FragmentComposer({
  groupId,
  onCreated,
}: {
  groupId: string;
  onCreated: (fragment: GroupFragmentView) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [postType, setPostType] = useState<PostType | null>(null);
  const [capturedAt, setCapturedAt] = useState(localDateTimeValue);
  const [textContent, setTextContent] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [aiProcessingConsent, setAiProcessingConsent] = useState(false);
  const [transcriptionConsent, setTranscriptionConsent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(mediaFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  function openComposer() {
    setIsOpen(true);
    setMessage(null);
  }

  function selectPostType(type: PostType) {
    setPostType(type);
    setMediaFile(null);
    setCaption("");
    setTextContent("");
    setAiProcessingConsent(false);
    setTranscriptionConsent(false);
    idempotencyKey.current = null;
    if (fileInput.current) fileInput.current.value = "";
    setMessage(null);
  }

  async function submitPost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!postType) return;
    if (postType === "text" && !textContent.trim()) {
      setMessage("Write something before posting.");
      return;
    }
    if (postType !== "text" && !mediaFile) {
      setMessage(`Choose a ${postType === "image" ? "photo" : postType} first.`);
      return;
    }
    if (postType === "image" && mediaFile && mediaFile.size > MAX_IMAGE_FILE_BYTES) {
      setMessage("Photos must be smaller than 12 MB.");
      return;
    }
    if (postType === "video" && mediaFile && mediaFile.size > MAX_VIDEO_FILE_BYTES) {
      setMessage("Videos must be smaller than 25 MB.");
      return;
    }
    if (postType === "audio" && mediaFile && mediaFile.size > MAX_VOICE_FILE_BYTES) {
      setMessage("Audio notes must be smaller than 2 MB.");
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    idempotencyKey.current ??= crypto.randomUUID();
    const capturedAtIso = new Date(capturedAt).toISOString();
    const capturedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      let response: Response;
      if (postType === "text") {
        response = await fetch(`/api/groups/${groupId}/fragments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey.current,
          },
          body: JSON.stringify({
            textContent,
            capturedAt: capturedAtIso,
            capturedTimeZone,
            visibility: "group",
            aiProcessingConsent,
          }),
        });
      } else if (postType === "audio" && mediaFile) {
        response = await fetch(`/api/groups/${groupId}/voice`, {
          method: "POST",
          headers: {
            "Content-Type": mediaFile.type || "audio/wav",
            "Idempotency-Key": idempotencyKey.current,
            "X-Captured-At": capturedAtIso,
            "X-Captured-Time-Zone": capturedTimeZone,
            "X-Transcription-Consent": String(transcriptionConsent),
            "X-AI-Processing-Consent": "false",
            "X-Fragment-Caption": encodeURIComponent(caption),
          },
          body: mediaFile,
        });
      } else if (mediaFile) {
        response = await fetch(`/api/groups/${groupId}/media`, {
          method: "POST",
          headers: {
            "Content-Type": mediaFile.type,
            "Idempotency-Key": idempotencyKey.current,
            "X-Captured-At": capturedAtIso,
            "X-Captured-Time-Zone": capturedTimeZone,
            "X-Fragment-Caption": encodeURIComponent(caption),
            "X-AI-Processing-Consent": String(aiProcessingConsent),
          },
          body: mediaFile,
        });
      } else {
        throw new Error("Select a file to continue.");
      }

      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as {
        fragment: GroupFragmentView;
        processingStatus?: string | null;
        transcriptionStatus?: string;
        manualReason?: string | null;
      };
      onCreated(result.fragment);
      setMessage(
        postType === "audio"
          ? result.transcriptionStatus === "transcribing"
            ? "Audio posted to the group. Transcription is processing; review it before Gemma can analyze the transcript."
            : "Audio posted to the group. Review or enter a transcript before choosing Gemma analysis."
          : aiProcessingConsent
            ? `${postType === "text" ? "Text" : postType === "image" ? "Photo" : "Video"} posted. Gemma processing is ${result.processingStatus === "queued" ? "queued" : "not available yet"}.`
            : "Posted to the group. AI classification is off.",
      );
      setTextContent("");
      setMediaFile(null);
      setCaption("");
      setAiProcessingConsent(false);
      setTranscriptionConsent(false);
      idempotencyKey.current = null;
      if (fileInput.current) fileInput.current.value = "";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Post could not be saved.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="fragment-composer" id="add-fragment" aria-labelledby="fragment-composer-title">
      <div className="post-entry">
        <div>
          <p className="eyebrow">A SHARED SPACE</p>
          <h2 id="fragment-composer-title">Add to your memories</h2>
          <p>Little things from your time together belong here.</p>
        </div>
        {!isOpen && (
          <button className="primary-button post-open-button" type="button" onClick={openComposer}>
            Post <span aria-hidden="true">+</span>
          </button>
        )}
      </div>

      {isOpen && (
        <div className="post-composer">
          <div className="post-type-picker" role="group" aria-label="Choose post type">
            {postTypes.map((type) => (
              <button
                key={type.id}
                className="post-type-button"
                type="button"
                aria-pressed={postType === type.id}
                onClick={() => selectPostType(type.id)}
              >
                {type.label}
              </button>
            ))}
          </div>

          {postType && (
            <form className="post-form" onSubmit={(event) => void submitPost(event)}>
              {postType === "text" ? (
                <label>
                  What do you want to remember?
                  <textarea
                    value={textContent}
                    maxLength={10_000}
                    required
                    autoFocus
                    placeholder="Write a note for your group…"
                    onChange={(event) => {
                      setTextContent(event.target.value);
                      idempotencyKey.current = null;
                    }}
                  />
                </label>
              ) : (
                <>
                  <label className="post-file-picker">
                    <input
                      className="post-file-input"
                      ref={fileInput}
                      type="file"
                      accept={
                        postType === "image"
                          ? "image/jpeg,image/png,image/webp"
                          : postType === "video"
                            ? "video/mp4,video/webm"
                            : ".wav,audio/wav,audio/x-wav"
                      }
                      required
                      onChange={(event) => {
                        setMediaFile(event.target.files?.[0] ?? null);
                        setAiProcessingConsent(false);
                        idempotencyKey.current = null;
                        setMessage(null);
                      }}
                    />
                    <span className="post-file-button">
                      {mediaFile
                        ? postType === "image" ? "Change photo" : postType === "video" ? "Change video" : "Change audio"
                        : postType === "image" ? "Choose a photo" : postType === "video" ? "Choose a video" : "Choose an audio note"}
                    </span>
                  </label>
                  {previewUrl && postType === "image" && (
                    <Image
                      className="post-image-preview"
                      src={previewUrl}
                      alt="Selected photo preview"
                      width={900}
                      height={600}
                      unoptimized
                    />
                  )}
                  {previewUrl && postType === "video" && (
                    <video className="post-video-preview" src={previewUrl} controls playsInline preload="metadata">
                      Your browser does not support video playback.
                    </video>
                  )}
                  {previewUrl && postType === "audio" && (
                    <AudioWaveform src={previewUrl} label="Audio preview" />
                  )}
                  {postType !== "audio" && (
                    <label>
                      Caption <span>(optional)</span>
                      <textarea
                        value={caption}
                        maxLength={1_000}
                        placeholder="Add a little context for your group…"
                        onChange={(event) => {
                          setCaption(event.target.value);
                          idempotencyKey.current = null;
                        }}
                      />
                    </label>
                  )}
                  {postType === "audio" && (
                    <>
                      <label>
                        Caption <span>(optional)</span>
                        <textarea
                          value={caption}
                          maxLength={1_000}
                          placeholder="What should your group know about this audio?"
                          onChange={(event) => {
                            setCaption(event.target.value);
                            idempotencyKey.current = null;
                          }}
                        />
                      </label>
                      <label className="consent-control">
                        <input
                          type="checkbox"
                          checked={transcriptionConsent}
                          onChange={(event) => {
                            setTranscriptionConsent(event.target.checked);
                            idempotencyKey.current = null;
                          }}
                        />
                        Send audio to ElevenLabs for transcription (optional)
                      </label>
                      <p className="privacy-status">
                        Audio itself is never sent to Gemma. Review the transcript first; you can opt in
                        to Gemma analysis when you approve that text.
                      </p>
                    </>
                  )}
                </>
              )}

              <label className="post-date">
                When was it?
                <input
                  type="datetime-local"
                  value={capturedAt}
                  required
                  onChange={(event) => {
                    setCapturedAt(event.target.value);
                    idempotencyKey.current = null;
                  }}
                />
              </label>
              {postType !== "audio" && (
                <label className="consent-control">
                  <input
                    type="checkbox"
                    checked={aiProcessingConsent}
                    onChange={(event) => {
                      setAiProcessingConsent(event.target.checked);
                      idempotencyKey.current = null;
                    }}
                  />
                  Allow Gemma to classify this post
                </label>
              )}
              <p className="post-audience-note">This will be visible to everyone in this group.</p>
              <div className="post-actions">
                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Posting…" : "Post to group"}
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setPostType(null);
                    setMessage(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              {message && <p className="privacy-status" role="status">{message}</p>}
            </form>
          )}
        </div>
      )}
    </section>
  );
}
