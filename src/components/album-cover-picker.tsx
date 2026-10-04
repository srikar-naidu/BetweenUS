"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function AlbumCoverPicker({
  groupId,
  hasCover,
  canEdit,
}: {
  groupId: string;
  hasCover: boolean;
  canEdit: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    setIsUploading(true);
    try {
      const response = await fetch(`/api/groups/${groupId}/album-cover`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save the album cover");
      setMessage("Cover updated.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the album cover");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  if (!canEdit) return null;
  return (
    <div className="album-cover-control">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label={`Choose ${hasCover ? "a new" : "an"} album cover for this album`}
        onChange={(event) => void upload(event.currentTarget.files?.[0])}
        disabled={isUploading}
      />
      <button
        type="button"
        className="secondary-button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? "Uploading…" : hasCover ? "Change cover image" : "Add cover image"}
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
