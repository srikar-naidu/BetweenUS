# Final MVP Implementation Plan

## Product target

Ship the smallest trustworthy Between Us product that lets multiple members of a private group contribute fragments and later see those fragments reconstructed into a candidate shared moment, with inspectable evidence, explicit uncertainty, correction, and deletion.

The final MVP proves:

```text
private group
  -> members upload fragments
  -> authorized fragments are analyzed and indexed
  -> the system retrieves a small candidate set
  -> Gemma proposes a moment with evidence
  -> deterministic checks validate the proposal
  -> the group sees the moment, sources, uncertainty, and correction controls
```

A moment is the main product object. This is not a public feed, generic chatbot, AI photo-captioner, or semester-recap generator.

## MVP scope

### Required product capabilities

- Sign in, create a private group, invite members, and enforce membership on every read/write.
- Upload photos, screenshots, short videos, text, and optional voice notes.
- Set visibility and AI-processing consent per fragment; private and restricted fragments never enter group candidate retrieval by inference alone.
- Show upload/processing state and a chronological fragment view.
- Extract structured fragment observations with provenance.
- Retrieve candidates using group + time window + semantic similarity + people/place/entity overlap.
- Reconstruct a candidate Moment through local Gemma using a compact ContextPacket.
- Validate cited fragment IDs, group/visibility permissions, timestamps, relationship types, contradictions, and uncertainty before persistence.
- Let members inspect evidence, reject a merge, correct an interpretation, and confirm a moment.
- Store confirmed group corrections and stable aliases as group-scoped Backboard memories with MongoDB provenance.
- Provide an opt-in ElevenLabs speech-to-text path for voice-note fragments, subject to the consent and retention gate below.
- Orchestrate media-processing jobs through Temporal workflows with MongoDB holding canonical job status and business data.
- Monitor application and worker failures in Sentry with request bodies, AI prompts/outputs, media, and direct identifiers scrubbed or disabled.
- Evaluate a Tinker specialization experiment against the local Gemma baseline; keep the app's default inference path local Gemma.

### Explicitly out of scope

- Public profiles, followers, likes, comments, or a recommendation feed.
- Generic "chat with all memories" as the primary interface.
- Automatic confirmation of AI-created moments.
- Voice cloning, synthetic voices, AI music, or generated recap films.
- Sending private media, raw group histories, or personally identifiable uploads to Tinker.
- Using a Tinker checkpoint in production unless the experiment passes its gate and the data/privacy review approves it.
- Stories/recurring-pattern mining as a release blocker. Preserve the schema for a later phase.

## Architecture and ownership

| System | MVP responsibility | Must not own |
|---|---|---|
| Next.js App Router + Node.js/TypeScript | UI, authenticated API routes, upload orchestration, provider adapters | Client-visible secrets or authorization decisions in the browser |
| MongoDB Atlas | Canonical users, groups, membership, fragment metadata, visibility/consent, observations, moments, evidence, corrections, jobs, provider references | Vector retrieval source of truth |
| Private media storage | Raw image/audio/video bytes, addressed through an adapter and short-lived authorized URLs | Group permissions or AI interpretations |
| Tiger Data | Derived group-visible time/vector/lexical retrieval projection | Raw media, permissions, canonical moment state |
| Gemma via local Ollama | Default fragment understanding and moment reconstruction | Full-database access or persistent application state |
| Backboard | High-level, explicitly confirmed group memory: aliases, recurring references, approved corrections | Raw media, speculative claims, private member memory, canonical state |
| ElevenLabs | Opt-in speech transcription for voice-note fragments only | Default processing for other media, memory storage, generated voice |
| Tinker | Time-boxed training/sampling experiment on approved de-identified examples | Default app request path or unapproved personal media |
| Temporal | Durable fragment-processing workflows, retries, timeouts, and activity execution | Canonical user/group/moment data or large media/prompt payloads in workflow history |
| Sentry | Error/performance monitoring for Next.js and processing workers, with strict privacy scrubbing | Raw media, request bodies, prompts/completions, auth credentials, direct user identifiers |
| Render | Next.js web service and Node processing worker | Durable work state without MongoDB job records |

### Data path

```mermaid
flowchart LR
  M[Member] --> UI[Next.js UI]
  UI --> AUTH[Auth + group authorization]
  AUTH --> UP[Private media upload]
  UP --> MDB[(MongoDB canonical records)]
  UP --> TEMP[Temporal ProcessFragmentWorkflow]
  TEMP --> WORKER[Node Temporal Worker]
  WORKER --> EX[Gemma extraction / optional ElevenLabs STT]
  EX --> RET[Tiger time + vector retrieval]
  RET --> PACK[Small group-scoped ContextPacket]
  PACK --> GEM[Local Gemma reconstruction]
  GEM --> VAL[Evidence + uncertainty validator]
  VAL --> MDB
  VAL --> UI
  CORR[Member-confirmed correction] --> MDB
  CORR --> BB[Backboard group memory]
  EVAL[De-identified eval set] --> T[Tinker experiment]
  OBS[Sentry, scrubbed errors/traces] -.-> UI
  OBS -.-> WORKER
```

MongoDB is authoritative. Tiger and Backboard are derived/context services that can be rebuilt or reconciled from authorized MongoDB state and provenance records. Backboard service failure must not block normal text-fragment submissions or erase MongoDB state.

## Implementation phases

### Phase 0: Freeze access, budgets, and unresolved decisions

Do this before consuming provider credits or implementing external integrations.

**Current status: NOT COMPLETE.** Repository review found the following decisions already represented: Better Auth + Google OAuth is the identity path; Google callback configuration is documented in `README.md`; new fragments default to private with AI processing consent off; local Gemma is the default; and the current home screen/CSS establish an initial screen and token direction. See `DECISIONS.md` Decision 12 for the additional Phase 0 defaults locked during this review.

The following exit-gate items remain unverified and must be completed by an operator with access to the provider accounts before any external provider is enabled or any real personal media is sent:

- Record remaining credits, expiry, permitted use, rate limits, billing behavior, retention, and training terms for Backboard, Tinker, ElevenLabs, Temporal Cloud, and Sentry.
- Verify Tinker's live supported-model catalog, Gemma compatibility, sampling/checkpoint options, and account billing; until then, Tinker remains disabled and no samples are sent.
- Configure and test Google OAuth credentials and the `/api/auth/callback/google` callback; the repository's `.env.example` contains blank credential placeholders and does not prove configuration.
- Image/video upload and third-party object storage are disabled. Optional voice notes use private MongoDB GridFS under the separate Phase 6 design; any other media feature requires a new storage/privacy decision.
- Confirm that no real personal media has already been sent to a third party. The repository cannot establish this historical fact.
- Before enabling any billable call, implement its feature flag, usage logging, and an explicitly approved non-zero cap; until that approval, the authorized external spend ceiling is $0.

The project can continue on local Gemma and synthetic demo data while these account checks are pending. Phase 1 implementation does not waive this gate for external processing.

- Confirm actual remaining Backboard, Tinker, and ElevenLabs credits, expiry, allowed use, rate limits, and billing behavior from the developer accounts. The plan does not assume credits are unlimited or still active.
- Verify Temporal Cloud availability/credits and establish a small usage budget; choose Cloud only if account terms and deployment connectivity fit the Render worker.
- Review Sentry plan limits and retention. Disable capture of media, HTTP bodies, AI inputs/outputs, auth/session data, and direct user identifiers before sending any events.
- Set an explicit maximum spend for each provider. Add usage logging and a feature flag before any billable call.
- Review provider data retention/training terms. ElevenLabs documents zero-retention mode as enterprise-only; do not send real voice notes until consent, retention, and deletion terms are acceptable.
- Check Tinker's live supported-model catalog and whether the local Gemma 4 model/weights can be used. Do not assume Gemma compatibility. Confirm sampling/checkpoint options and billing for the account.
- Configure the selected Better Auth + Google OAuth provider credentials and callback. Choose the private object-storage provider; keep media behind an adapter and do not store production media on ephemeral Render disk.
- Lock fragment size/type limits, visibility defaults, and consent text.
- Design the key product screens and UI tokens before implementing their final layouts.

**Exit gate:** written decisions for identity, provider credit caps, data-sharing/retention, and model compatibility. Any future media-storage integration requires a separate decision. No real personal media has been sent to a third party yet.

### Phase 1: Trust foundation and real group boundaries

- Implement Better Auth Google sign-in, MongoDB-backed sessions, group creation/invites, membership roles, and server-side authorization helpers. Use the Google callback `/api/auth/callback/google` and require verified email for email-bound invitations.
- Add tests proving users cannot enumerate or retrieve another group's fragments, moments, evidence, or Backboard assistant ID.
- Add per-fragment visibility and explicit AI-use consent. Default to private until the member chooses group visibility and eligible processing.
- Create deletion states and provenance links so dependent observations, retrieval entries, Backboard memories, and stored media can be removed or invalidated.
- Add server-only configuration and secret validation.

**Exit gate:** two test groups remain isolated across API, Mongo queries, retrieval, object URLs, and provider context.

### Phase 2: Ingestion, storage, and processing jobs

**Current implementation boundary:** Text-fragment creation and processing jobs are implemented. The optional Phase 6 voice lane stores bounded WAV clips in private MongoDB GridFS. Image/video upload, retrieval, and third-party object storage remain disabled; any legacy objects in a former bucket require manual cleanup.

- Add text-fragment creation and capture-time/time-zone handling.
- Store source, author, group, visibility, consent, capture time, and processing version.
- Use Temporal as the processing orchestrator: `ProcessFragmentWorkflow` schedules idempotent Node activities for extraction, embedding, candidate search, reconstruction, and deletion cleanup with explicit timeouts/retries.
- Store only opaque Mongo fragment/job IDs and small status data in Temporal workflow history; activities fetch authorized text and context from their canonical stores. Activities persist sensitive outputs in MongoDB/Tiger and return opaque IDs/status, not extracted text, transcripts, prompts, or completions. Never place full ContextPackets in workflow inputs/results.
- Mirror user-facing processing status, provider references, and final outputs into MongoDB. Do not run a second Mongo polling queue alongside Temporal.

**Exit gate:** text and voice fragments survive server restarts, duplicate job retries do not create duplicate fragments, and deletion marks dependent AI state stale and removes voice bytes/transcripts. Reintroducing image/video media requires a separately approved private-storage design and migration plan.

### Phase 3: Baseline intelligence and temporal/vector retrieval

**Current implementation status:** Consent-gated text analysis now uses a validated, versioned Gemma contract. Author-approved voice transcripts use the same path with explicit transcript-source provenance. Analysis records include source quotes, source-text checksum, configured model tag, and analysis version. Only active, group-visible, AI-consented text or approved voice transcripts are projected to Tiger; retrieval rechecks eligibility in MongoDB and ranks a bounded candidate set by time, lexical overlap, extracted-entity overlap, and indexed Moment links. Context packets are capped at 12 fragments and carry compact analysis excerpts, never the full source fragments.

- Keep the local Ollama Gemma provider as the default path; add fragment-analysis contracts and model/version tracking.
- Keep image/video analysis deferred: those uploads and third-party object storage remain disabled by Decision 16. Reintroducing images/video requires an approved storage design; video must then use a documented, small keyframe sample rather than whole archives. Approved voice transcripts are analyzed as text-derived evidence, never as raw-audio analysis.
- Extract text observations as uncertain AI data with source-quoted evidence, candidate places/entities, and model/version provenance. Do not infer identity or treat extracted entities as confirmed aliases.
- Run the same-event retrieval comparison on a labeled dataset before selecting an embedding model. No local Ollama service or labeled real-fragment dataset was available during this implementation, so vector embeddings remain unselected and retrieval keeps its no-vector fallback.
- Write only active, group-visible, AI-consented fragment projections to Tiger Data. Current ranking uses time, lexical overlap, extracted-entity overlap, and indexed Moment links; confirmed alias ranking depends on the future confirmed-entity model.
- Build bounded ContextPackets from authorized analyses with a 12-fragment cap, pseudonymous author keys, evidence quotes, and no full raw source fragments.

**Exit gate:** the checked-in synthetic ranking fixture demonstrates the entity/moment-aware reranker can beat a temporal/lexical distractor case. The same-event versus unrelated-event gate on a labeled real-fragment set, a measured embedding-model choice, and live cross-group integration checks remain open.

### Phase 4: Moment reconstruction, evidence, and correction

**Current implementation status:** The group page queues reconstruction as an idempotent Temporal workflow from an eligible group-visible text fragment or author-approved voice transcript. The worker rechecks active group membership, fetches an authorized bounded ContextPacket, and asks Gemma for a schema-constrained proposal; the server validates candidate IDs, quote provenance, and evidence relationships, then assigns uncertainty deterministically and persists provenance. The UI polls the job and presents its result. Members can confirm, reject, merge, correct or undo the latest correction, and remove evidence. Review events retain before/after snapshots; review writes use revision checks and candidate merges use a MongoDB transaction.

- Ask Gemma for schema-constrained candidate summaries, evidence links, contradictions, missing evidence, and uncertainty notes.
- Validate IDs and permissions against MongoDB, not just model output. Validate relationship types using stored observations; reject unsupported links.
- Derive `unknown`, `possible`, or `likely` with documented deterministic evidence rules. A model score never upgrades a label. `confirmed` is only a member action.
- Persist candidate moments, evidence references, model version, retrieval version, and validation outcome in MongoDB.
- Implement the member review flow: confirm, reject/merge, correct a person/place/reference, and remove a fragment from a moment.
- Reflect a confirmed correction into Backboard only after authorization and explicit confirmation. Keep its memory ID and Mongo provenance for update/delete.

**Exit gate:** unit tests cover unsupported evidence rejection, insufficient-evidence `unknown`, deterministic uncertainty, audit snapshots, undo, and transaction-scoped merge writes. Live Gemma/database behavior remains unverified in this environment. MongoDB merges require a deployment topology that supports transactions. Backboard correction sync is deferred to Phase 5 and remains disabled.

### Phase 5: Backboard group memory integration

**Current implementation status:** Backboard is server-configured and disabled by default. Owners/admins explicitly enable or disable one assistant per group; members can explicitly share only a correction attached to a confirmed Moment. MongoDB stores provider IDs, provenance, and asynchronous operation state. Reconstruction retrieves at most three group-scoped, verified memories and degrades to no Backboard context if provider retrieval fails. Group disable/deletion and fragment privacy/deletion changes remove linked provider data before local access is withdrawn. Provider memory operations are currently polled from the request path rather than Temporal. This repository has no member-removal route, so member-removal cleanup remains unwired. Provider/account retention terms and live behavior still require deployment verification.

- Create one Backboard assistant per Between Us group and map its `assistant_id` in MongoDB. The assistant boundary is essential because Backboard memories are shared across all threads under one assistant.
- Store only high-level group facts members confirmed: group aliases, stable place names, recurring references, and accepted corrections. Do not send raw media, private fragments, or speculative moment text.
- Prefer explicit `addMemory`/`searchMemories`/`updateMemory`/`deleteMemory` operations. Use read-only retrieval for reconstruction; do not use automatic write-on-every-message memory for unreviewed interpretations.
- Retrieve only a few relevant memories and include them in the ContextPacket with provenance.
- Handle asynchronous memory operations; write operation references/status into MongoDB and do not treat a pending write as durable.
- On member removal, group deletion, or memory correction, apply the documented cleanup and verify deletion through the provider API.

**Exit gate:** tests prove group A cannot retrieve group B memory, unconfirmed Moments cannot write, only explicitly shared correction values are stored, pending operations stay tracked, and memory removal is reflected in Backboard/Mongo provenance. Live provider, account-retention, and operational cleanup behavior remain unverified.

### Phase 6: Optional voice-note input through ElevenLabs

**Current implementation status:** WAV voice notes are uploaded into a private MongoDB GridFS bucket with actual format, duration, and size validation. The ElevenLabs integration remains disabled by default and requires provider-specific author consent plus bounded monthly seconds/request caps. Eligible clips are transcribed in a Temporal activity with automatic retries disabled. Transcript and word offsets remain author-only until the author edits/approves the transcript and chooses visibility and separate local-AI consent. Missing provider setup or exhausted usage leaves a private clip for manual transcription. Live terms, retention, credits, and account eligibility remain an operator gate.

- Add voice as an opt-in Fragment type, while keeping provider transcription disabled until the Phase 0 privacy/retention gate is approved.
- Upload audio to private MongoDB GridFS first; queue transcription in the background and send only that audio file plus minimal options to ElevenLabs Scribe.
- Let the author review/correct the transcript before group visibility or shared reconstruction; keep author-review controls available for manual transcription.
- Preserve the original audio as evidence, the approved transcript as derived text, and returned word timestamps as source offsets.
- Disclose the cloud provider and do not assume zero retention unless account eligibility is confirmed.
- Enforce a strict clip/duration cap and approved monthly seconds/request cap. If credits/configuration are unavailable or consent is absent, keep the voice fragment private for manual transcription; never silently switch to a paid service.
- Do not add voice cloning or TTS to the MVP.

**Implementation note:** Current audio format is mono 16-bit PCM WAV at 16 kHz, maximum 60 seconds / 2 MB. Image/video upload remains disabled.

**Exit gate:** implementation tests verify consent, transcript editing/review, source audio linkage/deletion, monthly usage bounds, and manual fallback. Live provider, account-retention, and credit behavior must still be verified before enabling the feature outside a development environment.

### Phase 7: Tinker specialization experiment

This is an MVP experiment deliverable, not a production dependency.

**Current implementation status:** A reproducible, fully synthetic, event-disjoint benchmark now compares the existing hybrid candidate retriever against a lexical/time baseline (`npm run evaluate:phase7`). It includes 60 labeled candidate pairs across 12 independent scenarios, with development and held-out scenarios, same-event positives, hard negatives, insufficient-evidence cases, and synthetic transcript text. The held-out fixture currently reports hybrid precision@1 1.00, recall@1 0.50, recall@3 1.00, versus lexical/time precision@1 0.00, recall@1 0.00, recall@3 0.50. These are fixture sanity metrics only: the small templated set is not representative and the comparison does not test model inference, pairwise grouping decisions, evidence validation, or uncertainty. It does not call Gemma or Tinker and does not represent image/video performance. Tinker training and model-to-model evaluation remain blocked on operator verification of account eligibility, model catalog/compatibility, data terms, retention, and an explicit spend ceiling; no external calls or credentials were added. This benchmark baseline is for retrieval ranking only, not a measured local Gemma baseline.

- First freeze a Gemma baseline and a labeled evaluation set containing same-event pairs, unrelated-nearby pairs, misleading text, insufficient evidence, and diverse media types.
- Use synthetic or explicitly de-identified/consented training examples only. Do not upload raw group media, private fragments, names, or live Backboard memories.
- Check current Tinker catalog and account entitlement. If Gemma 4 is unsupported, choose a supported small instruction model only for a comparison experiment; keep local Gemma as production default.
- Train one small supervised/LoRA specialization for one measured weakness, likely moment candidate grouping or evidence selection. Keep the training script/workspace separate from the Next.js app runtime.
- The official Tinker quickstart currently documents a Python SDK. Keep the deployed application Node-only; use the Tinker console or an isolated research workspace for the experiment. If a Node-compatible supported training path cannot be verified and the project constraint is Node-only for all tooling, defer Tinker training rather than adding a Python service.
- Use a project-isolated Tinker workspace, set a spend ceiling, log training/sample/checkpoint usage, and store no credentials in the repository.
- Compare the Tinker checkpoint on a held-out set with the Gemma baseline. Track pairwise grouping precision/recall, false merges, evidence-ID validity, uncertainty behavior, latency, and spend.
- Adopt the Tinker model in production only if it passes a pre-agreed improvement threshold, does not worsen false merges or hallucination/evidence failures, has a compatible inference route, fits privacy requirements, and is cheaper/valuable within the credit cap. Otherwise publish the experiment result and leave Gemma as the runtime model.

**Exit gate:** reproducible Gemma-vs-Tinker model report and an explicit adopt/defer decision. Tinker spend never exceeds the approved cap. The current local synthetic ranking comparison is preparation only and does not pass this gate.

### Phase 8: The expressive product UI

Start the visual system in Phase 0 and implement it in parallel with the backend; do not leave all UX until the end.

#### Visual direction: Memory Atlas

Make the interface bold and emotionally alive, but keep evidence and privacy unmistakable. Avoid generic dashboard cards and avoid turning it into an ML console.

- Use a tactile, editorial visual language: warm paper, deep ink-green, electric cobalt, citrus-lime, and coral accents; strong serif display typography paired with precise mono timestamps and compact sans-serif controls.
- Make real fragment media the visual anchor. Use a timeline/atlas canvas where separate contributions align by time and the evidence connections become visible as the moment is reconstructed.
- Give each contributor a consistent, accessible color/key, while never relying on color alone for identity or evidence.
- Use an immersive moment detail view: clear title and uncertainty, source fragments arranged along a time rail, visible provenance links, and an expandable "why these connect" layer.
- Make the group timeline the working first screen: upload entry point, recent moments, and unresolved candidate moments. No marketing landing page.
- Build high-utility responsive flows: quick capture/upload on mobile; evidence comparison and corrections on desktop; explicit private/group visibility controls in the upload flow.
- Add a few purposeful motions: fragments align into a moment, evidence links draw in, and corrections update the reconstruction. Respect reduced-motion preferences and keep a static accessible equivalent.
- Keep button labels, uncertainty explanations, and evidence text readable; provide keyboard, focus, screen-reader, and high-contrast states.

#### MVP screens

1. **Group space:** memory timeline, upload/capture action, processing status, candidate moments.
2. **Add fragment:** image/video/text/voice input, capture time, visibility, AI-consent toggle, and upload status.
3. **Moment reconstruction:** concise summary, uncertainty label/reason, contributors, timeline, source fragments, and evidence relationships.
4. **Review/correct:** confirm/reject, change a group alias/person reference, remove a fragment, or explain "not enough evidence."
5. **Group memory:** review/manage confirmed aliases and recurring references backed by member corrections.

**Exit gate:** usability test with at least three people who did not build the product; they can upload, understand why a candidate appeared, identify uncertainty, correct/reject it, and distinguish private from group-visible media.

### Phase 9: Evaluation, deployment, and pilot

- Evaluate on a held-out, labeled dataset (target: 50–100 fragments across multiple small events and unrelated near-neighbors). Include spec cases: same place/different event, same people/different event, misleading text, single uploader, mixed media, and insufficient evidence.
- Require 100% valid evidence IDs after server validation, zero cross-group leaks, zero private-fragment evidence leakage, and no confirmed moment without explicit member action. Track false merges and misses; block launch if false merges exceed the agreed pilot threshold.
- Test provider outage, malformed Gemma output, Backboard timeout, ElevenLabs quota exhaustion, queue retries, media deletion, and duplicate uploads.
- Configure Sentry for Next.js server/client and the Temporal worker. Disable HTTP body and GenAI input/output capture, user identity collection, and session replay; add explicit redaction in `beforeSend`/span hooks. Emit only opaque job IDs and safe error categories.
- Verify a test exception and workflow-activity failure arrive in Sentry without request bodies, AI prompts/completions, media URLs, direct user identity, or raw provider response text.
- Deploy a Next.js web service plus a Node worker to Render; MongoDB is canonical, Tiger is rebuildable, Backboard and external speech providers have explicit timeout/fallback behavior.
- Connect the Node worker to Temporal Cloud or the approved Temporal deployment and verify workflow retries/recovery in staging.
- Start with an invite-only pilot group, collect corrections and user-perceived errors, and re-run the eval set before widening access.

**Release gate:** all privacy/evidence acceptance checks pass; one complete multi-user upload-to-moment workflow succeeds in staging; provider cost caps and deletion checks are confirmed.

## Additional sponsor experiments and explicit deferrals

| Sponsor | MVP decision | Product fit and gate |
|---|---|---|
| GitHub Copilot | Use during development | Document meaningful use in scaffolding, tests, route/repository code, and debugging. It is not runtime infrastructure. |
| TabPFN | Post-MVP experiment only | Once enough member-approved moments exist, compare a TabPFN classifier/forecaster against simple baselines using aggregated, non-identifying group activity features. Do not send raw fragments or infer personal traits; skip it if the sample is too small or the result does not improve a real feature. |
| Entire | Optional development-only trial | Entire documents a built-in Copilot CLI integration, not the VS Code extension. Use only if the team chooses Copilot CLI or a verified agent integration and the setup is low-friction. Keep GitHub as the source of truth; do not migrate the repo or include user media/session secrets. Skip otherwise. |
| Sentry | Include for staging/pilot | Add the official `@sentry/nextjs` SDK for provider failures, upload errors, workflow activity failures, and latency. Disable bodies, prompts/completions, media, stack locals, replay, and direct identifiers; scrub exceptions/spans. |
| Temporal | Include for processing durability | Add the Temporal TypeScript client/worker/workflow SDKs. The pipeline needs retries, timeouts, and recovery. Temporal owns execution state; MongoDB owns business state and user-visible job status. |
| SerpApi | Do not use in MVP | There is no web-research user story, and internet search adds privacy and factuality risks without helping reconstruct private group memories. |
| DigitalOcean | Do not use in MVP | Render is already the deployment target; adding a second hosting platform duplicates operations without a requirement. |
| Mastra | Defer | Mastra workflows/agents would overlap with the chosen Temporal orchestration and direct typed provider adapters. Revisit only if AI branching/tool orchestration becomes hard to maintain; do not deploy both workflow engines for the current linear pipeline. |

These deferrals are intentional sponsor decisions, not unfinished integrations. See [ROADMAP.md](ROADMAP.md) for when the TabPFN and Entire experiments can be reconsidered.

## Provider and credit policy

- Check actual balance, expiration, billing triggers, and account terms for every free-credit grant before coding a live integration.
- Put provider calls behind server-side interfaces, feature flags, usage accounting, and hard per-provider/monthly limits.
- Do not place keys in `NEXT_PUBLIC_*` variables, logs, browser bundles, prompts, or sample files.
- Keep local Gemma the default. External services are called only for their named use case with the user/group's consent.
- Credit exhaustion degrades optional voice/Tinker features, not core uploads or memory access.

## Critical path

```text
Access + privacy decisions
  -> authentication + group isolation
  -> secure media storage + Temporal workflows
  -> Gemma baseline + eval data
  -> Tiger retrieval + Moment validation
  -> Backboard confirmed group memory
  -> final UI + correction flow
  -> ElevenLabs opt-in voice lane
  -> Tinker benchmark/training experiment
  -> Sentry privacy-safe monitoring
  -> Render + Temporal pilot and release gate
```

Build and test the UI shell alongside the first four engineering phases. ElevenLabs, Tinker, Entire, and TabPFN are isolated/optional work packages and must not block the core image/text fragment-to-moment path. Temporal and Sentry are used for reliability at the pilot gate, not as reasons to delay the local demo.

## References checked for planning

- [Backboard persistent memory](https://backboard-docs.docsalot.dev/sdk/memory.md) and [assistant/thread architecture](https://backboard-docs.docsalot.dev/concepts/architecture.md)
- [Tinker quickstart](https://tinker-docs.thinkingmachines.ai/tinker/quickstart/), [current model catalog](https://tinker-docs.thinkingmachines.ai/tinker/models.json), and [data isolation/permissions](https://tinker-docs.thinkingmachines.ai/tinker/data-model/)
- [ElevenLabs speech-to-text API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) and [model capabilities](https://elevenlabs.io/docs/overview)
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript), [activity retries/timeouts](https://docs.temporal.io/develop/typescript/activities/execution), and [workflow determinism](https://docs.temporal.io/develop/typescript/workflows/basics)
- [Sentry for Next.js](https://docs.sentry.io/platforms/javascript/guides/nextjs/) and [data collection options](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/)
- [TabPFN capabilities](https://docs.priorlabs.ai/), [Entire agent integrations](https://docs.entire.io/agents/overview), and [Mastra workflows](https://mastra.ai/docs/workflows/overview)
- [Next.js local documentation](node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md)
