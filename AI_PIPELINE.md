# AI Pipeline: Evidence, Hypotheses, and Convergence

## Goal and invariants

The pipeline turns independent group Fragments into evidence-backed Moment hypotheses and recurring Stories across confirmed Moments. It must preserve uncertainty and provenance as evidence changes. It must not convert model confidence into fact or let any model confirm a Moment or Story.

- Authorize and filter before retrieval or inference.
- Persist source evidence and versioned Observations before deriving group claims.
- Every claim points to active, authorized source Fragments in the same group.
- Treat model and scorer outputs as hypotheses; members alone confirm.
- Keep media, transcripts, prompts, and Context Packets out of Temporal histories and Sentry events.
- Depend on the `GemmaService` interface. Local development uses Ollama on the developer machine; Render uses the private Ollama service deployed with the application. Optional third parties remain separate, consented, and disabled by default.

## Target pipeline

```text
Text/image/video capture -> validate -> Mongo Fragment/ProcessingJob
  -> MongoDB queue worker (opaque IDs)
  -> Gemma Observation (or opt-in voice STT -> author-reviewed transcript -> Observation)
  -> Mongo structured graph + authorized Tiger projection
  -> Tiger temporal/semantic retrieval + Mongo relationship expansion
  -> minimal Context Packet + a few confirmed Backboard meanings
  -> optional TabPFN feature score -> Gemma investigation of hypotheses
  -> deterministic evidence/privacy audit -> Mongo Moment revisions
  -> member confirm/reject/correct
  -> on-demand bounded confirmed-Moment packet -> Gemma StoryConnection
  -> deterministic evidence/privacy audit -> Mongo Story candidate
  -> member confirm/reject -> evaluation example -> gated Tinker study
```

Text, image, and short video ingestion, consent-gated observations, group-scoped retrieval, and MongoDB queue-worker processing are implemented. New posts are group-visible because they are created within a group. Voice audio is stored in MongoDB GridFS and never sent to Gemma; optional external transcription is separately gated.

## 1. Ingestion and provenance

The authenticated API binds each submission to the current user and requested group. Text submissions validate length, capture timestamp/timezone, group visibility, and consent. Voice submissions validate WAV PCM format, actual duration, size, capture timestamp/timezone, and a separate provider-specific consent. A voice post is group-visible; its transcript remains author-only until review. Gemma analysis, if consented, waits until transcript approval.

MongoDB stores canonical Fragment fields: author, group, source, capture time and timezone, visibility, AI and external-transcription consent, processing version/status, and deletion state. `voice_notes` GridFS stores the bounded audio object; `voice_transcripts` stores author-only transcript review state and word offsets until approval. Private image/video bytes are kept in group-scoped GridFS and exposed only through authenticated group routes. AI processing stays off unless the member explicitly opts in. The `fragment_analyses` collection stores the analysis contract/version, configured Gemma model tag, a source-content digest, and evidence references.

ElevenLabs is disabled by default and requires an API key plus non-zero, bounded monthly seconds and request caps. Only the selected WAV file is sent. The author must explicitly consent, then review/edit the returned transcript before transcript visibility in the group or Gemma processing. No provider retry is automatic, avoiding duplicate charges. Any pre-existing objects in a former bucket require manual cleanup.

## 2. Observation: Gemma sees

For an active, consented text fragment, a worker calls the configured `GemmaService` with that fragment and the extraction schema. For an eligible image, it sends the image; for video, it sends at most six sampled frames with frame locators. The output is validated against the source fragment ID, modality, exact text spans or bounded visual evidence, and confidence limits before it is persisted as a versioned FragmentAnalysis. Raw audio is never sent. A revoked or deleted fragment is not indexed; group visibility and AI consent are rechecked before and after the Tiger projection write.

- source-quoted or visually grounded people/place/object/activity/tone/reference/visible-text observations;
- literal entities and bounded summary/hints derived from the source;
- per-fact and overall model confidence signals, with `possible` or `unknown` status only;
- source ID, analysis version, configured model tag, and checksum provenance.

Visual observations are always tentative (maximum confidence 0.7), cannot identify people or infer relationships/sensitive attributes/exact locations, and require an authorized image/frame locator. Video keyframes are bounded; the worker does not send an archive or every frame. Malformed or unsupported output is rejected, not persisted as fact. Media bytes are fetched only for processing, are not logged or duplicated in derived stores, and remain subject to the fragment's existing deletion lifecycle.

For opted-in voice notes, a separate MongoDB worker job sends only the selected source audio and minimum options to ElevenLabs Scribe after account terms/retention and usage-cap gates pass. Store the transcript and word timestamps as derived evidence linked to the audio. Speaker diarization is off. The author reviews/edits transcript content before group retrieval; approved transcript quotes remain labeled as transcript-derived evidence. If the provider is disabled or a budget is exhausted, keep the note private for manual transcription.

## 3. Structured memory and retrieval

Persist Observation claims and graph edges in MongoDB with source Fragment IDs, group, extractor version, and provenance. Project only active, group-visible, AI-consented fields into Tiger. Remove or invalidate projections when visibility, consent, or deletion changes.

Candidate retrieval is implemented as a group-scoped, bounded projection and combines:

- hard group, active-state, visibility, consent, and time-window filters;
- time distance and capture density;
- lexical matching over generated analysis summaries;
- overlap in extracted entity phrases, treated as candidate signals rather than confirmed aliases;
- indexed Moment links when available;
- vector semantic similarity only after an embedding model, dimensions, license, and retrieval-quality test are selected; none is currently selected;
- confirmed entity/place/person-alias relationships only after that domain model exists;
- a few relevant, confirmed Backboard meanings (nicknames, inside jokes, recurring references).

MongoDB remains the graph authority. Tiger is a derived retrieval index, not a store of permissions. Backboard is semantic group context, not a duplicate graph or a place for speculative claims. A failed Backboard read degrades to no semantic context; it never blocks core reconstruction.

## 4. Context Packet

Build a task-specific Packet from the smallest authorized candidate set. The current builder caps the set at 12 fragments and includes pseudonymous member keys, candidate IDs/timestamps, bounded analysis summaries and source quotes, retrieval signals, and explicit output constraints. It does not include full source fragments, private fragments, or the author's account identifier; source excerpts may contain literal names included in a group-visible fragment. See [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md) for packet budgets and boundaries.

## 5. Evidence scoring and Gemma investigation

TabPFN is an optional feature scorer, not a language model. Its input may include time distance, semantic similarity, shared confirmed entities/places, explicit participant evidence, text/visual similarity, capture density, and prior relationship evidence. It may estimate `P(same_moment)` only after supported API/runtime, sufficient labeled data, calibration, false-merge review, and a spend/privacy gate are verified. Store model version and feature provenance. The score never confirms a Moment or overrides evidence constraints.

Gemma receives the bounded Packet, optional validated score/features, and competing hypotheses. It proposes relationships, summaries, contradiction notes, and uncertainty with citations to candidate IDs. Mastra may later coordinate distinct AI steps (observation, retrieval investigation, evidence audit, Story detection, narration) inside an activity; Temporal remains the durable process/retry/schedule owner. Do not add both as competing workflow engines.

## 6. Deterministic evidence and privacy audit

Before persistence, deterministic code validates:

- every cited Fragment/Observation exists and belongs to the authorized group;
- every source is active and permitted by visibility and consent at decision time;
- evidence IDs are in the retrieved Packet, not invented by the model;
- timestamp and stated relationships are supported by stored data;
- contradictions and missing evidence remain visible;
- a private/restricted Fragment cannot become group evidence by inference;
- `confirmed` can only come from a member action.

If validation fails, reject the unsupported output or return `unknown` without storing a Moment. Do not repair invalid citations by guessing.

## 7. Moment hypotheses and convergence

MongoDB stores candidate hypotheses as versioned graph records with group, evidence links, competing interpretations, status, uncertainty label/reason, Observation/retrieval/scorer/model versions, and revision provenance. New authorized evidence triggers an idempotent reevaluation workflow for affected hypotheses; it should update, split, merge, or leave hypotheses unresolved without erasing prior revisions.

Temporal may schedule later Moment reevaluations (for example, after new evidence or a bounded delay). Schedule intervals, user notifications, retention, and cost must be designed before enabling periodic reevaluations. No timer or score automatically changes a hypothesis to member-confirmed.

## 8. Story connections across Moments

Story discovery is an explicit member action and runs as a durable Temporal job, not during upload. The worker rechecks active group membership and selects at most eight relevant confirmed Moments whose complete source evidence is still active, group-visible, AI-consented, and backed by current FragmentAnalysis records. Gemma receives only their bounded Moment summaries, up to two source Fragments per Moment, a few validated observation values/entities, timestamps, and opaque Moment/Fragment IDs; it never receives raw media or the full database.

Gemma may propose one StoryConnection supported by repeated text/transcript people or place evidence, grounded recurring-theme overlap, or a bounded timeline connection. The server rejects references outside the packet and unsupported relationship types, attaches the underlying source Fragment IDs, deduplicates by the selected Moment set, and derives `possible` uncertainty. Unsupported/no-pattern results produce no Story record. Stories stay candidates until an active group member confirms or rejects them. Reads and reviews recheck that every linked Moment remains confirmed and every cited Fragment remains group-visible and consented. Group deletion removes Story records and pending jobs.

## 9. Member correction and Tinker learning loop

Every confirm, reject, split, merge, or correction is stored in MongoDB with actor, timestamp, affected hypothesis, prior/new interpretation, selected evidence, and provenance. Use these outcomes first to evaluate retrieval/reconstruction quality. Build structured, de-identified examples with no raw media or direct identifiers. Tinker is a separate, budget-capped experiment after a baseline and held-out dataset exist; verify its current supported model catalog, task/runtime path, data terms, sampling/checkpoint controls, deletion, and pricing first. Never assume Gemma compatibility or put a Tinker checkpoint on the production path by default.

## 10. Optional narrated memories

ElevenLabs TTS may narrate only a member-approved/confirmed Moment or Story, from a short, validated text representation. It must not receive private source media, the full Context Packet, or an unconfirmed speculative narrative. Require an explicit narration action/consent, disclose external processing, use an approved stock voice (no cloning or voice imitation), budget calls, keep generated audio private, link it to the Moment/version, and support deletion. Keep disabled until retention and account policy are verified.

## 11. Durable orchestration and observability

The MongoDB-backed worker processes text/media ingestion, observations, Moment reconstruction, member-triggered Story reconstruction, and deletion cleanup from durable job records. Claims are atomic, each job has a renewable lease, and expired worker leases can be reclaimed. MongoDB owns job status and domain state. Job records contain only opaque IDs and small status values; worker activities fetch authorized evidence/context at execution time and persist outputs in MongoDB/Tiger.

Mastra is not a durable job store. Sentry should trace workflow steps, Gemma calls, retrieval, optional scoring, provider calls, latency, and failures using scrubbed operation names and opaque IDs. Disable request bodies, media, prompts/completions, transcripts, direct identity, session replay, and sensitive span attributes. A telemetry failure must not affect processing.

## Current production and demo boundary

The group page queues member-triggered Moment reconstruction as an idempotent MongoDB job for active, group-visible, AI-consented fragments. Queue records contain opaque group, fragment, job, and requester IDs only; the worker rechecks active membership before fetching authorized context. The production path retrieves a bounded `ContextPacket`, optionally retrieves up to three Mongo-provenance-checked Backboard memories when the group has opted in, asks Gemma for candidate evidence/contradiction/missing-evidence notes, rechecks source eligibility before persistence, validates cited IDs/quotes/relationships, derives uncertainty deterministically, and persists the result with model/retrieval/validation provenance. The UI polls the job for a reviewable result. Insufficient evidence is persisted as an `unknown` draft and is not shown as a candidate.

For Stories, the group page queues a separate idempotent MongoDB job. It starts only from confirmed Moments and current eligible source observations, stores only opaque IDs/status in the job record, and persists any validated Story candidate in MongoDB. The UI polls the job and lets group members confirm/reject the candidate. Inference or worker unavailability does not block uploads or Moment review; queued jobs remain durable until a worker is available.

Group members can confirm, reject, merge, correct a person/place/reference, undo the latest correction, and remove evidence. These actions append actor/time/before/after snapshots. Merge writes require MongoDB transactions. Backboard stays disabled until an owner/admin explicitly opts the group in. Only a correction on a confirmed Moment can be sent, and a member must separately choose to share it. Brief summaries/entities from eligible group-visible fragments are sent only as search queries; raw source text is not sent to Backboard. Provider operation references and source provenance are retained in MongoDB. Disabling the integration deletes its per-group assistant and memories; a failed Backboard read degrades to no semantic group context.

The separate synthetic demo still uses seeded examples and is not the production ingestion workflow. Live Gemma, MongoDB, and transaction behavior have not been verified by the unit tests; only synthetic fixtures exercise the deterministic contracts.
