"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { AudioWaveform } from "@/components/audio-waveform";
import { formatCaptureTime } from "@/lib/domain/format-time";
import type { Fragment, MemberMoment } from "@/lib/domain/memory";

export interface EventStoryDraft {
  title: string;
  narrative: string;
  momentIds: string[];
  revision: number;
  updatedAt: Date;
}

type StorySource = Pick<
  Fragment,
  "id" | "type" | "source" | "caption" | "textContent" | "capturedAt" | "authorUserId"
>;

function draftFromMoments(moments: MemberMoment[]): string {
  return [...moments]
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
    .map((moment) => {
      const when = formatCaptureTime(moment.startAt);
      const heading = moment.title ?? "A moment from the day";
      return `${when} — ${heading}\n${moment.summary}`;
    })
    .join("\n\n");
}

export function EventStoryEditor({
  groupId,
  groupName,
  initialStory,
  moments,
  sources,
}: {
  groupId: string;
  groupName: string;
  initialStory: EventStoryDraft | null;
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const includedMoments = moments.filter((moment) => selectedMomentIds.includes(moment.id));

  function toggleMoment(momentId: string) {
    setSelectedMomentIds((current) => current.includes(momentId)
      ? current.filter((id) => id !== momentId)
      : [...current, momentId]);
  }

  function makeDraft() {
    setNarrative(draftFromMoments(includedMoments));
    setTitle((current) => current.trim() || `${groupName}: the story`);
    setMessage("Draft built from member-confirmed Moments. Edit it to add your own details.");
    setError(null);
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
        <Link className="wordmark" href="/home">between us<span>.</span></Link>
        <nav className="top-actions" aria-label="Album navigation">
          <Link href="/albums">Albums</Link>
          <Link href={`/groups/${groupId}`}>{groupName}</Link>
        </nav>
      </header>
      <section className="event-story-header">
        <p className="eyebrow">A STORY MADE TOGETHER</p>
        <h1>{groupName}</h1>
        <p className="lede">Put the confirmed moments in order, then add the details only your group remembers.</p>
      </section>

      <section className="event-story-editor">
        <label>
          Story title
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="event-story-actions">
          <button className="secondary-button" type="button" disabled={!includedMoments.length} onClick={makeDraft}>
            Draft from confirmed Moments
          </button>
          <span>Only confirmed Moments can be included.</span>
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
        <div className="event-story-save-row">
          <button className="primary-button" type="button" disabled={saving || title.trim().length < 2} onClick={() => void saveStory()}>
            {saving ? "Saving…" : "Save event story"}
          </button>
          {message && <p className="privacy-status" role="status">{message}</p>}
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
