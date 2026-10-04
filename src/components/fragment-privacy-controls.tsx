"use client";

import { useState, useTransition } from "react";
import type { FragmentVisibility } from "@/lib/domain/memory";

interface Props {
  groupId: string;
  fragmentId: string;
  initialVisibility: FragmentVisibility;
  initialConsent: boolean;
  hasLegacyMedia: boolean;
  canEditPrivacy: boolean;
  canDelete: boolean;
  onDeleted: (fragmentId: string) => void;
}

export function FragmentPrivacyControls({
  groupId,
  fragmentId,
  initialVisibility,
  initialConsent,
  hasLegacyMedia,
  canEditPrivacy,
  canDelete,
  onDeleted,
}: Props) {
  const [visibility, setVisibility] = useState(initialVisibility);
  const [consent, setConsent] = useState(initialConsent);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setMessage(null);
    startTransition(async () => {
      const response = await fetch(`/api/groups/${groupId}/fragments/${fragmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility, aiProcessingConsent: consent }),
      });
      if (response.ok) {
        setMessage("Privacy settings saved.");
        return;
      }
      setMessage("Could not save privacy settings.");
    });
  }

  function requestDeletion() {
    if (!window.confirm("Request deletion of this fragment and its derived data?")) return;
    setMessage(null);
    startTransition(async () => {
      const response = await fetch(`/api/groups/${groupId}/fragments/${fragmentId}`, {
        method: "DELETE",
      });
      if (response.status === 202) {
        const result = await response.json() as { legacyMediaCleanupRequired?: boolean };
        onDeleted(fragmentId);
        setMessage(
          result.legacyMediaCleanupRequired || hasLegacyMedia
            ? "Fragment details were deleted, but its original media file needs manual cleanup from the former storage bucket."
            : "Fragment deleted.",
        );
        return;
      }
      setMessage("Could not request deletion.");
    });
  }

  return (
    <div className="fragment-privacy-controls">
      {canEditPrivacy && (
        <>
          <label>
            Visibility
            <select value={visibility} onChange={(event) => setVisibility(event.target.value as FragmentVisibility)}>
              <option value="private">Only me</option>
              <option value="group">Group</option>
              <option value="restricted">Restricted</option>
            </select>
          </label>
          <label className="consent-control">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            Allow AI processing
          </label>
        </>
      )}
      <div className="privacy-actions">
        {canEditPrivacy && <button className="secondary-button" onClick={save} disabled={isPending}>Save</button>}
        {canDelete && <button className="text-button danger-button" onClick={requestDeletion} disabled={isPending}>Request deletion</button>}
      </div>
      {!canEditPrivacy && !canDelete && <span className="privacy-status">Privacy is controlled by the contributor.</span>}
      {message && <p className="privacy-status" role="status">{message}</p>}
    </div>
  );
}