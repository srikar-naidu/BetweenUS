"use client";

import { useState } from "react";
import type { Fragment } from "@/lib/domain/memory";

export function FragmentMediaPreview({
  groupId,
  fragment,
}: {
  groupId: string;
  fragment: Pick<Fragment, "id" | "type" | "source" | "caption">;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (fragment.source !== "upload") return null;

  async function reveal() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/fragments/${fragment.id}/media`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setMessage("Source media is unavailable.");
        return;
      }
      const result = await response.json() as { url?: unknown };
      if (typeof result.url !== "string") {
        setMessage("Source media is unavailable.");
        return;
      }
      setUrl(result.url);
    } catch {
      setMessage("Source media is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fragment-media-preview">
      {!url && <button className="text-button" type="button" onClick={reveal} disabled={loading}>
        {loading ? "Loading source…" : "View source"}
      </button>}
      {url && fragment.type === "video" && <video controls preload="metadata" src={url} />}
      {url && fragment.type !== "video" && <img src={url} alt={fragment.caption ?? "Uploaded group fragment"} />}
      {message && <span className="privacy-status" role="status">{message}</span>}
    </div>
  );
}
