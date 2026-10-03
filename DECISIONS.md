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

## Decision 12: Use Temporal as the single durable processing orchestrator

### Context

Fragment processing includes multiple steps, external providers, retries, and deletion cleanup that may outlive an HTTP request. A separate Mongo polling queue would duplicate orchestration state and retry logic.

### Chosen approach

Use the Temporal TypeScript SDK for the fragment-processing workflow and a Node worker. MongoDB remains canonical for business records and user-visible job status; do not run a second Mongo-backed queue. Use Temporal Cloud only after access, cost, and Render connectivity are verified.

### Reason

The media/AI pipeline has a real need for durable retries and recovery, and the TypeScript SDK matches the selected application runtime.

### Trade-offs

- Pros: durable retries, recovery, activity timeouts, visible workflow state
- Cons: another service and persistent workflow history; activities must be idempotent and inputs must stay small/non-sensitive

## Decision 13: Add Sentry for pilot observability with strict data minimization

### Context

The final MVP spans uploads, Temporal activities, local Gemma, Backboard, Tiger Data, and opt-in ElevenLabs calls. Provider and worker failures need actionable diagnostics, but these requests can contain sensitive memories.

### Chosen approach

Instrument Next.js and the Temporal worker for errors and latency while disabling request/response bodies, GenAI inputs/outputs, user identity, local variables, and replay capture. Scrub events/spans and correlate with opaque job IDs.

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
