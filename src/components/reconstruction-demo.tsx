"use client";

import { useState, useTransition } from "react";
import type { Fragment, Moment, MomentEvidence } from "@/lib/domain/memory";
import { formatCaptureTime } from "@/lib/domain/format-time";
import type { DemoFragment, DemoReconstructionResult } from "@/lib/pipeline/demo-reconstruction";

interface Props {
  initialFragments: DemoFragment[];
  initialMoment: Moment | null;
}

const fragmentKinds: Record<Fragment["type"], string> = {
  image: "Photo",
  video: "Video",
  text: "Note",
  screenshot: "Screenshot",
  voice: "Voice",
  location: "Place",
  other: "Fragment",
};

const names: Record<string, string> = { maya: "Maya", arjun: "Arjun", leah: "Leah" };

const relationshipLabels: Record<MomentEvidence["relationship"], string> = {
  temporal: "Close in time",
  shared_people: "Shared people",
  shared_location: "Shared place",
  semantic_similarity: "Related content",
  entity_overlap: "Shared details",
};

export function ReconstructionDemo({ initialFragments, initialMoment }: Props) {
  const [fragments, setFragments] = useState(initialFragments);
  const [moment, setMoment] = useState(initialMoment);
  const [uncertaintyReason, setUncertaintyReason] = useState(
    initialMoment?.uncertaintyReason ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reconstruct() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/demo/reconstruct", { method: "POST" });
        const body = (await response.json()) as DemoReconstructionResult | { error: string };
        if (!response.ok || "error" in body) {
          throw new Error("error" in body ? body.error : "Moment reconstruction failed");
        }
        setFragments(body.candidateFragments);
        if (body.outcome === "insufficient_evidence") {
          setMoment(null);
          setUncertaintyReason(body.uncertaintyReason);
          return;
        }
        setMoment(body.moment);
        setUncertaintyReason(body.moment.uncertaintyReason);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Moment reconstruction failed");
      }
    });
  }

  return (
    <section className="workspace" aria-label="Moment reconstruction demo">
      <div>
        <div className="section-head">
          <h2>Fragments</h2>
          <span>{fragments.length} uploaded</span>
        </div>
        <div className="fragment-list">
          {fragments.map((fragment) => (
            <article className="fragment" key={fragment.id}>
              <time>{formatCaptureTime(fragment.capturedAt)}</time>
              <div>
                <div className="fragment-meta">
                  <span className="fragment-kind">{fragmentKinds[fragment.type]}</span>
                  <span>{names[fragment.authorUserId] ?? fragment.authorUserId}</span>
                </div>
                <p>{fragment.caption}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="moment-panel" aria-live="polite">
        <div className="section-head">
          <h2>Reconstructed moment</h2>
          {moment && <span className="moment-status">{moment.uncertaintyLabel}</span>}
        </div>
        {moment ? (
          <>
            <h3 className="moment-title">{moment.title ?? "A possible moment"}</h3>
            <p className="moment-summary">{moment.summary}</p>
            <p className="empty-moment">{uncertaintyReason}</p>
            <p className="evidence-title">Connected evidence</p>
            <ul className="evidence-list">
              {moment.evidence.map((item) => {
                const source = fragments.find((fragment) => fragment.id === item.fragmentId);
                return (
                  <li key={item.fragmentId}>
                    <strong>{relationshipLabels[item.relationship]}</strong>
                    {source?.caption ?? item.fragmentId}
                  </li>
                );
              })}
            </ul>
            <div className="confidence">
              <span>Model confidence, not factual probability</span>
              <span>{Math.round(moment.confidence * 100)}%</span>
            </div>
          </>
        ) : (
          <p className="empty-moment">{uncertaintyReason ?? "The candidate moment will appear here with its source evidence."}</p>
        )}
        <div className="action-row">
          <button className="primary-button" disabled={isPending} onClick={reconstruct}>
            {isPending ? "Reconstructing…" : "Reconstruct moment"}
          </button>
          {error && <span className="error-message" role="alert">{error}</span>}
        </div>
      </div>
    </section>
  );
}