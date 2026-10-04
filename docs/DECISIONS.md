# Architecture decisions

This document records the major product and engineering choices in ADR-style format.

## Decision 1: Use local Gemma as the default reasoning layer

### Context

The challenge requires local-first reasoning and explicit constraints around privacy, efficiency, and local runtime integration.

### Options considered

- Use a cloud-only AI provider
- Use a local model runtime without a formal adapter
- Use Gemma through a local runtime like Ollama

### Chosen approach

Use Gemma through a local adapter over Ollama.

### Reason

This matches the requirement for local AI first, avoids unnecessary paid infrastructure, and gives the project a clear runtime boundary for future abstraction.

### Trade-offs

- Pros: local control, lower cost, privacy alignment, supported model choice
- Cons: hardware constraints, less raw scale than large cloud models, possible latency on heavier reasoning

## Decision 2: Treat the moment as the primary product object

### Context

The project is not a photo-sharing product or a gallery. The challenge demands a system focused on event reconstruction rather than uploaded media as the primary artifact.

### Options considered

- Photo-first product experience
- Event-first reconstruction architecture
- Hybrid gallery plus AI summary

### Chosen approach

Event-first architecture with fragments feeding into moments and moments feeding into stories.

### Reason

This matches the product thesis and makes the system meaningfully different from normal shared-album products.

### Trade-offs

- Pros: stronger differentiation, more relevant AI work, better user value
- Cons: harder to explain to users at first, less obvious than “photo album” UX

## Decision 3: Use MongoDB for canonical app state and Tiger Data for retrieval

### Context

The system needs both canonical application state and time-aware retrieval. No embedding model has been selected yet.

### Options considered

- Single database for everything
- MongoDB plus a separate retrieval index
- Use only one retrieval-oriented database

### Chosen approach

MongoDB Atlas for canonical application state; Tiger Data for time-aware retrieval. Start with temporal filtering and lexical matching; defer vector indexing until an embedding model and dimensions are chosen.

### Reason

This keeps operational state and retrieval concerns separated while respecting the requirement that temporal retrieval is a first-class concern.

### Trade-offs

- Pros: clear separation of concerns and a first-class temporal retrieval path
- Cons: extra operational complexity; vector retrieval remains pending an embedding decision

## Decision 4: Build context packets rather than sending broad historical context to Gemma

### Context

The system must avoid overloading the model with unnecessary historical data.

### Options considered

- Send everything to Gemma each time
- Send broad historical context on every task
- Send a compact, task-specific Context Packet

### Chosen approach

Use dynamically assembled Context Packets built from retrieved candidates and relevant memory.

### Reason

This minimizes cost, improves latency, and reduces the chance of mistakes caused by irrelevant context.

### Trade-offs

- Pros: efficiency, better reasoning quality, lower cost
- Cons: more development effort and retrieval pipeline complexity

## Decision 5: Require evidence and uncertainty for every AI-generated conclusion

### Context

The project explicitly requires evidence-based conclusions and forbids hallucinations.

### Options considered

- Produce free-form narrative without constraints
- Produce narrative but skip evidence
- Produce structured evidence-linked outputs with uncertainty labels

### Chosen approach

Use structured outputs with evidence references and explicit uncertainty labels.

### Reason

This makes the product safer and more explainable. It is a direct response to hallucination risk.

### Trade-offs

- Pros: trustworthiness, explainability, better UX
- Cons: more engineering effort, less narrative freedom for the model

## Decision 6: Add technologies only for a specific product role

### Context

Partner availability or free credits are useful constraints, but do not justify adding a provider without a product role, privacy review, and usage cap.

### Options considered

- Add every partner to satisfy a broad architecture checklist
- Keep only the required stack and defer optional tools
- Add a few small extras for convenience

### Chosen approach

Keep Gemma, MongoDB, Tiger Data, Backboard, Render, and the Next.js application on the core path. Use ElevenLabs only for opted-in voice transcription and Tinker only for a bounded, measured specialization experiment.

### Reason

The product’s first value is proving that events can be reconstructed from fragments. Backboard supports confirmed group context, ElevenLabs supports a meaningful optional fragment type, and Tinker can test a measured baseline weakness without replacing the local default.

### Trade-offs

- Pros: partner integrations map to specific responsibilities and can be disabled independently
- Cons: extra privacy, billing, and failure-boundary work is required

## Decision 7: Use Next.js, TypeScript, and Node.js for the application runtime

### Context

The first Gemma adapter was prototyped in Python, but the user selected a JavaScript ecosystem for the application and prefers Next.js.

### Options considered

- Keep a separate Python AI service
- Use Next.js with TypeScript for the app and provider adapter

### Chosen approach

Use Next.js App Router and TypeScript on Node.js for application and server-side AI provider code.

### Reason

This keeps the first application services in one runtime and matches the user's preferred stack. TypeScript supports the typed data contracts already defined in the planning documents.

### Trade-offs

- Pros: one application runtime, typed interfaces, direct use of Node database drivers
- Cons: future model workflows must fit Node libraries or introduce a separately justified worker runtime

## Decision 8: Keep MongoDB canonical and Tiger Data as a derived retrieval index

### Context

The application needs canonical fragment/moment writes and efficient time-window candidate retrieval, while no embedding model has been selected yet.

### Options considered

- Store all fragment state in both databases
- Store canonical records in MongoDB and a minimal search projection in Tiger Data
- Delay Tiger Data until semantic embeddings are ready

### Chosen approach

Store fragments and moments in MongoDB. Store only group-visible candidate metadata in Tiger Data and support temporal plus lexical retrieval first.

### Reason

This preserves a single source of truth while enabling retrieval before model-specific vector decisions are made.

### Trade-offs

- Pros: minimal duplication, useful time-aware retrieval now, no invented embedding dimensions
- Cons: index synchronization and eventual consistency must be handled by the future processing worker

## Decision 9: Keep Backboard memory group-scoped and explicitly curated

### Context

Backboard stores memory at assistant scope and shares it across threads. Between Us requires strict group isolation and evidence-backed memories.

### Chosen approach

Create one Backboard assistant per group. Use explicit memory writes only for member-confirmed aliases and corrections; use read-only retrieval in ContextPackets. MongoDB remains canonical and stores provider IDs/provenance.

### Reason

This uses persistent memory for stable group context without storing raw media or treating model speculation as fact.

### Trade-offs

- Pros: persistent, relevant context with a clear group boundary and deletion mapping
- Cons: assistant lifecycle, asynchronous provider operations, and cross-system deletion require dedicated handling

## Decision 10: Use ElevenLabs only for opt-in voice-note transcription

### Context

Voice notes are a useful fragment type, and the developer has partner credits, but transcription sends audio to an external provider.

### Chosen approach

Offer server-side Scribe transcription only when the author opts in, provider retention/terms are acceptable, and credit caps are configured. Require transcript review before group use.

### Reason

This gives voice notes a defined product role without making cloud audio processing a default for private media.

### Trade-offs

- Pros: adds voice as an input modality and improves retrieval from spoken context
- Cons: external data processing, quota/credit dependence, and transcript corrections are required

## Decision 11: Run Tinker as a bounded offline experiment

### Context

The local Gemma baseline must be measured before specialization. Tinker has a current supported-model catalog and usage-based training/sampling; Gemma 4 compatibility and account credits are not assumed.

### Chosen approach

After an evaluation dataset exists, run one capped experiment on synthetic or de-identified/consented examples. Compare a supported checkpoint against Gemma on held-out grouping/evidence metrics. Keep Gemma as default unless the result passes quality, privacy, compatibility, and budget gates.

### Reason

This uses Tinker for an actual model-improvement question while protecting the local-first app path from an unverified hosted dependency.

### Trade-offs

- Pros: measurable partner use, reproducible improvement report, no mandatory production dependency
- Cons: separate training workflow and possible second model/inference interface; may yield no deployable improvement

## Decision 12: Use MongoDB as the durable processing queue

### Context

Fragment processing includes multiple steps, optional external providers, and inference that may outlive an HTTP request. A managed orchestration service is not part of this deployment; existing MongoDB job collections are the durable queue and status store.

### Chosen approach

Use an independent Node worker that atomically claims queued MongoDB jobs, heartbeats a lease during processing, and allows stale leases to be reclaimed after interruption. Keep HTTP upload handlers limited to persisting fragments/jobs and returning promptly.

### Reason

MongoDB already stores job records, avoiding another required service/account for the Render demo. A separate worker keeps slow Gemma inference out of HTTP requests and does not depend on a developer machine.

### Trade-offs

- Pros: fewer services, durable queue state, recovery after worker interruption, compact deployment
- Cons: queue claiming, leases, and retry state are application-managed; the initial worker processes one job at a time

## Decision 13: Add Sentry for pilot observability with strict data minimization

### Context

The final MVP spans uploads, MongoDB worker activities, Gemma, Backboard, Tiger Data, and opt-in ElevenLabs calls. Provider and worker failures need actionable diagnostics, but these requests can contain sensitive memories.

### Chosen approach

Instrument Next.js and the MongoDB worker for errors and latency while disabling request/response bodies, GenAI inputs/outputs, user identity, local variables, and replay capture. Scrub events/spans and correlate with opaque job IDs.

### Reason

This enables staging/pilot debugging without creating a second content store for personal memories.

### Trade-offs

- Pros: better visibility into timeouts, failed uploads, workflow retries, and provider outages
- Cons: less payload-level debugging; scrubbers and event sampling must be maintained

## Decision 14: Defer sponsor tools that duplicate selected roles or lack a product need

### Context

The event includes more sponsor tools than the product should place on its critical path.

### Chosen approach

Defer Mastra because Temporal plus typed provider adapters cover the present linear workflow; defer SerpApi because web search is not a product requirement; defer DigitalOcean because Render is already selected. Consider TabPFN only for aggregate, non-identifying event patterns after enough labeled moments exist. Use Entire only as an optional development tool if its Copilot CLI/external-agent integration fits the team's workflow; do not migrate the app's hosting or source of truth.

### Reason

The project should maximize useful sponsor participation without duplicating orchestration, adding unrelated search, or splitting deployment infrastructure.

### Trade-offs

- Pros: fewer operational systems and clearer sponsor value
- Cons: several sponsors remain evaluation/development-only rather than runtime integrations

## Decision 15: Lock Phase 0 operational defaults before provider use

### Context

The implementation plan requires account-specific credit, billing, retention, and compatibility checks before external integrations. Those values cannot be inferred from source code or assumed from partner credits.

### Chosen approach

- Keep Better Auth with Google OAuth as the identity path; require verified email for email-bound invitations and use `/api/auth/callback/google`.
- (Superseded by Decision 16) Use a private R2 bucket as the production media-storage target, accessed only through a server-side storage adapter. Never use public object URLs or Render's ephemeral disk for production media.
- Set the authorized external-provider spend ceiling to $0 until account balances/terms are checked and a non-zero per-provider cap is explicitly approved. Every billable integration must have a kill-switch feature flag and usage logging before it can be enabled.
- Keep Backboard, Tinker, ElevenLabs, and Sentry external calls disabled until their account-specific terms, retention, billing, and privacy configuration are verified. Local Gemma and synthetic demo data remain usable.
- Keep fragment visibility private and AI-processing consent off by default. General AI consent does not authorize external-provider processing; each such use requires provider-specific, informed consent before implementation.
- (Media bounds superseded by Decision 16) Initial ingestion bounds: JPEG/PNG/WebP images and screenshots up to 15 MiB; MP4 video up to 50 MiB and 60 seconds; text up to 10,000 characters. Validate actual content and media duration server-side, not just the supplied MIME type. Voice uploads and transcription remain disabled until the ElevenLabs gate passes; any later voice feature is separately capped and consented.
- Use this consent copy for the initial local-AI flow: "Allow AI processing for group moment suggestions. This fragment stays private unless you separately choose Group visibility. Turning this off excludes it from AI processing." External processing must present a separate provider-specific notice and consent before sending data.
- Treat the existing home screen and CSS tokens as the initial product-design baseline; refine them as implementation proceeds rather than blocking the trust foundation on a second design pass.

### Verification still required

Provider balances, expiry, rate limits, billing behavior, live retention/training terms, Tinker model/checkpoint compatibility, OAuth credentials/callback operation, and confirmation that no real personal media has already been sent are operator checks. They are intentionally not claimed as complete by this repository decision. Until verified, the $0 spend ceiling and disabled external-call policy remain in force.

### Reason

This makes the decisions that are safe to make from the project context while preventing unknown credits, retention, and account entitlements from silently becoming approval to send data or incur charges.

### Trade-offs

- Pros: unambiguous privacy and spending defaults; local development can continue without provider credentials
- Cons: optional integrations remain unavailable until account checks and explicit caps are recorded

## Decision 16: Disable media uploads and object storage

### Context

The active product uses text fragments only and has no requirement for a third-party media-storage integration.

### Chosen approach

- Remove the R2 integration, credentials, upload/download endpoints, and media-upload UI.
- Keep text-fragment capture and its existing group privacy controls.
- Do not configure or call an object-storage provider in the current app.
- Any objects left in a previously configured bucket require manual cleanup; deleting fragment metadata in the app cannot remove those external bytes.

### Reason

Keep the running product aligned with its current text-only capability and avoid carrying an unnecessary infrastructure dependency.

## Decision 17: Add bounded voice notes in private MongoDB storage

### Context

Phase 6 adds an audio evidence source while preserving the no-third-party-object-storage decision. Transcription sends voice data to an external provider and carries separate retention and credit risks.

### Chosen approach

- Scope a narrow exception to Decision 16 for voice notes only; image/video uploads and third-party object storage remain disabled.
- Store audio in MongoDB GridFS, behind authenticated group/fragment authorization, before any optional provider processing.
- Accept only mono 16-bit PCM WAV at 16 kHz, with server-enforced 60-second and 2 MB limits.
- Keep ElevenLabs disabled by default. Require explicit per-upload author consent and bounded monthly seconds/request caps before sending audio.
- Keep the voice fragment private and local-AI-disabled until the author reviews/edits the transcript and separately approves its visibility and local-AI consent.
- Preserve word offsets as derived transcript provenance. Do not enable diarization, voice cloning, or TTS.
- Retain private audio for manual transcription when provider configuration or the usage budget is unavailable. Delete audio and transcript records when the fragment/group is deleted.
- Verify provider-specific retention, terms, credits, and account eligibility before enabling the feature operationally.

### Reason

Support opted-in voice memories without introducing another storage provider or conflating general AI consent with permission to send audio to a cloud service.

### Trade-offs

- Pros: original audio remains linked to reviewed transcript evidence; provider use is bounded and off by default.
- Cons: WAV-only input and MongoDB-backed media limit convenience; account-level retention and billing behavior remain operator gates.
