# AI Pipeline: Evidence, Hypotheses, and Convergence

## Goal and invariants

The pipeline turns independent group Fragments into evidence-backed Moment hypotheses and, over time, Stories. It must preserve uncertainty and provenance as evidence changes. It must not convert model confidence into fact or let any model confirm a Moment.

- Authorize and filter before retrieval or inference.
- Persist source evidence and versioned Observations before deriving group claims.
- Every claim points to active, authorized source Fragments in the same group.
- Treat model and scorer outputs as hypotheses; members alone confirm.
- Keep media, transcripts, prompts, and Context Packets out of Temporal histories and Sentry events.
- Prefer local Gemma. Cloud providers are opt-in, minimal, budgeted, and disabled until privacy/retention approval.

## Target pipeline

```text
Text capture -> validate -> Mongo Fragment/ProcessingJob
  -> Temporal workflow (opaque IDs)
  -> Gemma Observation (or opt-in voice STT -> Observation)
  -> Mongo structured graph + authorized Tiger projection
  -> Tiger temporal/semantic retrieval + Mongo relationship expansion
  -> minimal Context Packet + a few confirmed Backboard meanings
  -> optional TabPFN feature score -> Gemma investigation of hypotheses
  -> deterministic evidence/privacy audit -> Mongo Moment revisions
  -> member confirm/reject/correct -> evaluation example -> gated Tinker study
```

This is the intended architecture, not a claim that every integration is currently active. The current app accepts text fragments only; media upload/retrieval and object storage have been removed. It has private-by-default access boundaries, a local Gemma demo, and a Temporal worker skeleton.

## 1. Ingestion and provenance

The authenticated API binds each text submission to the current user and requested group. It validates text length, capture timestamp/timezone, visibility, and consent. It creates a stable idempotency key, Mongo Fragment, and ProcessingJob.

MongoDB stores the canonical text Fragment fields: author, group, source, capture time and timezone, visibility, AI consent, processing version/status, and deletion state. New fragments remain private and AI processing stays off unless the member explicitly opts in. Legacy media metadata may remain in MongoDB, but source bytes are unavailable through the app.

Media upload and retrieval are disabled. Any pre-existing objects in a former bucket require manual cleanup; text processing uses MongoDB and Temporal only.

## 2. Observation: Gemma sees

For eligible fragments, a worker calls local Gemma with only authorized text and the extraction schema. Gemma returns a structured Observation containing, when supported:

- visible objects, activity, scene, and text/OCR evidence;
- location clues and time clues with source offsets/metadata;
- possible entity references or group aliases, never an asserted real-world identity;
- direct observations versus inferred interpretations;
- uncertainty, missing evidence, and model/version provenance.

For video, inspect only the documented short-video sample/keyframes after Phase 2 limits are validated; do not pass an archive or every frame. Never identify a person by face without separately approved consent/safety design. Malformed output is rejected or retried; it is not persisted as a fact.

For opted-in voice notes, a separate activity may send only the source audio and minimum options to ElevenLabs STT after account terms/retention and spend/consent gates pass. Store transcript, speaker labels, and word timestamps as derived evidence linked to the audio. Speaker labels are local transcript labels, not identity. The author reviews transcript content before group retrieval. Until that gate passes, voice processing remains disabled.

## 3. Structured memory and retrieval

Persist Observation claims and graph edges in MongoDB with source Fragment IDs, group, extractor version, and provenance. Project only active, group-visible, AI-consented fields into Tiger. Remove or invalidate projections when visibility, consent, or deletion changes.

Candidate retrieval happens before reasoning and combines:

- hard group, active-state, visibility, consent, and time-window filters;
- time distance and capture density;
- semantic similarity only after an embedding model, dimensions, license, and retrieval-quality test are selected;
- lexical matching as a current fallback;
- MongoDB shared entity/place/person-alias and existing Moment/Story relationships;
- a few relevant, confirmed Backboard meanings (nicknames, inside jokes, recurring references).

MongoDB remains the graph authority. Tiger is a derived retrieval index, not a store of permissions. Backboard is semantic group context, not a duplicate graph or a place for speculative claims. A failed Backboard read degrades to no semantic context; it never blocks core reconstruction.

## 4. Context Packet

Build a task-specific Packet from the smallest authorized candidate set. Include pseudonymous member keys only when they matter, candidate IDs/timestamps, compact Observations and provenance, known contradictions, relevant confirmed Backboard meanings, and explicit output constraints. Do not include raw unrelated history, private fragments, direct identifiers, or all Backboard memory. See [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md) for packet budgets and boundaries.

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

Temporal may schedule later reevaluations (for example, after new evidence or a bounded delay) and longer-range Story discovery. Schedule intervals, user notifications, retention, and cost must be designed before enabling periodic runs. No timer or score automatically changes a hypothesis to member-confirmed.

## 8. Member correction and Tinker learning loop

Every confirm, reject, split, merge, or correction is stored in MongoDB with actor, timestamp, affected hypothesis, prior/new interpretation, selected evidence, and provenance. Use these outcomes first to evaluate retrieval/reconstruction quality. Build structured, de-identified examples with no raw media or direct identifiers. Tinker is a separate, budget-capped experiment after a baseline and held-out dataset exist; verify its current supported model catalog, task/runtime path, data terms, sampling/checkpoint controls, deletion, and pricing first. Never assume Gemma compatibility or put a Tinker checkpoint on the production path by default.

## 9. Optional narrated memories

ElevenLabs TTS may narrate only a member-approved/confirmed Moment or Story, from a short, validated text representation. It must not receive private source media, the full Context Packet, or an unconfirmed speculative narrative. Require an explicit narration action/consent, disclose external processing, use an approved stock voice (no cloning or voice imitation), budget calls, keep generated audio private, link it to the Moment/version, and support deletion. Keep disabled until retention and account policy are verified.

## 10. Durable orchestration and observability

Temporal owns text ingestion, observation, retrieval/reconstruction, deletion cleanup, and (later) convergence workflows with idempotent activities, explicit timeouts/retries, and stable workflow IDs. MongoDB owns job status and domain state. Workflow arguments/results contain only opaque IDs and small status values. Activities fetch authorized text/context at execution time, persist outputs in MongoDB/Tiger, and return opaque references.

Mastra is not a durable job store. Sentry should trace workflow steps, Gemma calls, retrieval, optional scoring, provider calls, latency, and failures using scrubbed operation names and opaque IDs. Disable request bodies, media, prompts/completions, transcripts, direct identity, session replay, and sensitive span attributes. A telemetry failure must not affect processing.

## Current demo boundary

The synthetic demo creates a candidate from seeded fragments, applies a bounded time/lexical retrieval, validates cited evidence, requires multiple fragments/authors, and derives uncertainty. It is not the production ingestion workflow and has no user-media access. Text-fragment ingestion schedules processing jobs, but the complete Gemma Observation -> retrieval -> Moment convergence chain remains subsequent work.
