"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AudioWaveform } from "@/components/audio-waveform";
import { MemoryNavigation } from "@/components/memory-navigation";
import { formatCaptureTime } from "@/lib/domain/format-time";
import type { Fragment, MemberMoment } from "@/lib/domain/memory";

export interface EventStoryDraft {
  title: string;
  narrative: string;
  momentIds: string[];
  evidenceReferences: Array<{
    claim: string;
    fragmentIds: string[];
    uncertainty: "grounded" | "uncertain";
  }>;
  generatedByGemma: boolean;
  revision: number;
  updatedAt: Date;
}

interface EventStoryJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCategory: string | null;
}

type StorySource = Pick<
  Fragment,
  "id" | "type" | "source" | "caption" | "textContent" | "capturedAt" | "authorUserId"
>;

export function EventStoryEditor({
  groupId,
  groupName,
  initialStory,
  initialJob,
  maxMoments,
  moments,
  sources,
}: {
  groupId: string;
  groupName: string;
  initialStory: EventStoryDraft | null;
  initialJob: EventStoryJob | null;
  maxMoments: number;
  moments: MemberMoment[];
  sources: StorySource[];
}) {
  const [title, setTitle] = useState(initialStory?.title ?? `${groupName}: the story`);
  const [narrative, setNarrative] = useState(initialStory?.narrative ?? "");
  const [selectedMomentIds, setSelectedMomentIds] = useState<string[]>(
    initialStory?.momentIds.filter((id) => moments.some((moment) => moment.id === id)) ??
      moments.map((moment) => moment.id),
  );
  const [revision, setRevision] = useState(initialStory?.revision ?? 0);
  const [evidenceReferences, setEvidenceReferences] = useState(initialStory?.evidenceReferences ?? []);
  const [generatedByGemma, setGeneratedByGemma] = useState(initialStory?.generatedByGemma ?? false);
  const [activeJobId, setActiveJobId] = useState(
    initialJob && (initialJob.status === "queued" || initialJob.status === "running")
      ? initialJob.id
      : null,
  );
  const [jobStatus, setJobStatus] = useState<EventStoryJob["status"] | null>(initialJob?.status ?? null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const includedMoments = moments.filter((moment) => selectedMomentIds.includes(moment.id));

  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/groups/${groupId}/event-story`, { cache: "no-store" });
        const result = await response.json() as {
          story?: EventStoryDraft | null;
          job?: EventStoryJob | null;
          error?: string;
        };
        if (!response.ok) throw new Error(result.error ?? "Could not check story generation.");
        if (cancelled) return;
        if (!result.job || result.job.id !== activeJobId) {
          throw new Error("Story generation status is unavailable. Refresh the page to check again.");
        }
        setJobStatus(result.job.status);
        if (result.job.status === "succeeded" && result.story) {
          setTitle(result.story.title);
          setNarrative(result.story.narrative);
          setRevision(result.story.revision);
          setEvidenceReferences(result.story.evidenceReferences ?? []);
          setGeneratedByGemma(result.story.generatedByGemma);
          setSelectedMomentIds(result.story.momentIds);
          setMessage("Gemma created an evidence-linked draft. Review and edit it before sharing.");
          setActiveJobId(null);
          return;
        }
        if (result.job.status === "failed") {
          setError(result.job.errorCategory === "temporal_unavailable"
            ? "The processing worker could not be reached. Check Temporal and retry."
            : "Gemma could not create the story. Check the worker, then retry.");
          setActiveJobId(null);
          return;
        }
        timer = window.setTimeout(() => void poll(), 2200);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not check story generation.");
          setActiveJobId(null);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeJobId, groupId]);

  function toggleMoment(momentId: string) {
    if (selectedMomentIds.includes(momentId)) {
      setSelectedMomentIds(selectedMomentIds.filter((id) => id !== momentId));
      setError(null);
      return;
    }
    if (selectedMomentIds.length >= maxMoments) {
      setError(`Select no more than ${maxMoments} Moments for one Gemma story.`);
      return;
    }
    setSelectedMomentIds([...selectedMomentIds, momentId]);
    setError(null);
  }

  async function generateStory() {
    setError(null);
    setMessage(null);
    setJobStatus("queued");
    try {
      const response = await fetch(`/api/groups/${groupId}/event-story`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ momentIds: selectedMomentIds, expectedRevision: revision }),
      });
      const result = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !result.jobId) throw new Error(result.error ?? "Could not queue Gemma story generation.");
      setActiveJobId(result.jobId);
      setJobStatus("queued");
      setMessage("Story queued. Gemma is reviewing the selected moments and their evidence.");
    } catch (caught) {
      setJobStatus("failed");
      setError(caught instanceof Error ? caught.message : "Could not queue Gemma story generation.");
    }
  }

  async function saveStory() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/groups/${groupId}/event-story`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          narrative,
          momentIds: selectedMomentIds,
          expectedRevision: revision,
        }),
      });
      const result = await response.json() as {
        story?: EventStoryDraft;
        error?: string;
      };
      if (!response.ok || !result.story) throw new Error(result.error ?? "Could not save the event story.");
      setRevision(result.story.revision);
      setEvidenceReferences([]);
      setGeneratedByGemma(false);
      setMessage("Event story saved for your album.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the event story.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="shell trust-page event-story-page">
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <MemoryNavigation active="albums" />
        <nav className="top-actions" aria-label="Album navigation">
          <Link href={`/groups/${groupId}`}>{groupName}</Link>
        </nav>
      </header>
      <section className="event-story-header">
        <p className="eyebrow">A STORY MADE TOGETHER</p>
        <h1>{groupName}</h1>
        <p className="lede">Gemma builds a draft from selected confirmed Moments and their consented observations. Your group can review and edit it.</p>
      </section>

      <section className="event-story-editor">
        <label>
          Story title
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="event-story-actions">
          <button className="secondary-button" type="button" disabled={!includedMoments.length || Boolean(activeJobId)} onClick={() => void generateStory()}>
            {activeJobId ? "Gemma is writing…" : "Generate with Gemma"}
          </button>
          <span>
            Select up to {maxMoments}. Photos and video frames use Gemma observations; voice contributes only its author-reviewed transcript.
          </span>
        </div>
        <label>
          Your group&apos;s story
          <textarea
            value={narrative}
            maxLength={20_000}
            placeholder="What happened? What little details do you want to keep?"
            onChange={(event) => setNarrative(event.target.value)}
          />
        </label>
        {generatedByGemma && evidenceReferences.length > 0 && (
          <section className="event-story-provenance" aria-label="Gemma evidence references">
            <strong>Evidence behind this draft</strong>
            <ul>
              {evidenceReferences.map((reference, index) => (
                <li key={`${index}-${reference.fragmentIds.join("-")}`}>
                  <span>{reference.claim}</span>
                  <small>
                    {reference.uncertainty === "uncertain" ? "Uncertain · " : ""}
                    {reference.fragmentIds.length} cited {reference.fragmentIds.length === 1 ? "fragment" : "fragments"}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="event-story-save-row">
          <button className="primary-button" type="button" disabled={saving || Boolean(activeJobId) || title.trim().length < 2} onClick={() => void saveStory()}>
            {saving ? "Saving…" : "Save event story"}
          </button>
          {message && !activeJobId && <p className="privacy-status" role="status">{message}</p>}
          {activeJobId && <p className="privacy-status" role="status">{jobStatus === "running" ? "Gemma is creating the story…" : message}</p>}
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>
      </section>

      <section className="event-timeline" aria-labelledby="event-timeline-heading">
        <div className="section-head">
          <div><p className="eyebrow">THE MOMENTS THAT MAKE IT</p><h2 id="event-timeline-heading">Event timeline</h2></div>
          <span>{moments.length} confirmed</span>
        </div>
        {!moments.length ? (
          <p className="empty-moment">Confirm a few Moments in this album to start its story.</p>
        ) : (
          <ol className="event-timeline-list">
            {[...moments].sort((left, right) => left.startAt.getTime() - right.startAt.getTime()).map((moment) => (
              <li className="event-timeline-item" key={moment.id}>
                <label className="event-moment-select">
                  <input
                    type="checkbox"
                    checked={selectedMomentIds.includes(moment.id)}
                    onChange={() => toggleMoment(moment.id)}
                  />
                  Include in story
                </label>
                <time>{formatCaptureTime(moment.startAt)}</time>
                <h3>{moment.title ?? "A moment from the day"}</h3>
                <p>{moment.summary}</p>
                <ul className="event-evidence-grid">
                  {moment.evidence.map((evidence) => {
                    const source = sourcesById.get(evidence.fragmentId);
                    if (!source) return null;
                    const mediaUrl = `/api/groups/${groupId}/fragments/${source.id}/${source.type === "voice" ? "audio" : "media"}`;
                    return (
                      <li key={source.id}>
                        {(source.type === "image" || source.type === "screenshot") && source.source === "upload" && (
                          <Image src={mediaUrl} alt={source.caption || "Photo from this moment"} width={420} height={320} unoptimized />
                        )}
                        {source.type === "video" && source.source === "upload" && (
                          <video src={mediaUrl} controls playsInline preload="metadata" />
                        )}
                        {source.type === "voice" && source.source === "upload" && (
                          <AudioWaveform src={mediaUrl} label="Voice from this moment" />
                        )}
                        {(source.type === "text" || source.type === "voice") && source.textContent && (
                          <p className="event-evidence-quote">“{source.textContent}”</p>
                        )}
                        {source.caption && <p className="event-evidence-caption">{source.caption}</p>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
