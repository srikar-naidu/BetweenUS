# Between Us

Between Us is a private shared-memory system for reconstructing the moments a group of friends actually experienced together from the tiny fragments each person captured independently. Instead of treating photos as the primary object, the system treats a real-world moment as the primary unit of understanding.

## Problem

Most shared-photo products answer: “What did my friends post?”

Between Us answers: “What actually happened between all these fragments?”

Friends rarely document an event completely. Different people remember different details, but nobody recorded the full story in one place.

Between Us discovers those relationships, reconstructs the likely moment, and preserves evidence and uncertainty instead of inventing certainty.

## Why it differs from a normal shared album

The product is not a gallery, a social feed, or an AI recap generator. It is a memory reconstruction system.

The key abstraction is:

- Fragment: one captured piece of information
- Moment: a reconstructed real-world event from multiple fragments
- Story: a recurring pattern or relationship across multiple moments over time

The user experience is designed to answer: “We forgot this happened,” not “Here is a pretty AI recap.”

## Core user experience

1. Multiple people contribute text fragments from the same period.
2. The system groups likely related fragments.
3. The AI reasons over only relevant candidate context.
4. The system surfaces a probable moment with evidence.
5. Users can inspect why the system connected the fragments.
6. Over time, recurring stories and hidden connections are surfaced.

## Architecture overview

The architecture is intentionally small and local-first:

- Local AI layer: Gemma via Ollama
- Application DB: MongoDB Atlas
- Retrieval layer: Tiger Data for temporal and lexical candidate search; vectors are deferred until an embedding model is selected
- Persistent, confirmed group memory: Backboard
- Opt-in voice-note transcription: ElevenLabs Scribe, after privacy and credit gates
- Durable processing: Temporal TypeScript workflows
- Privacy-scrubbed observability: Sentry
- Deployment: Render
- Bounded model-specialization experiment: Tinker, compared against Gemma; not the default runtime

## Current local runtime status

This workspace has a verified local runtime:

- Runtime: Ollama
- Version: 0.35.1
- Local endpoint: http://localhost:11434
- Available Gemma model: gemma4:e2b-it-q4_K_M
- Model capabilities: completion, vision, audio, tools, thinking
- Context length: 131072 tokens
- Embedding length: 1536

The runtime adapter targets Ollama's HTTP API; it does not assume a different local runtime.

## Setup overview

The application foundation uses Next.js App Router and TypeScript on Node.js 20.19+, 22.12+, or 23.2+. Better Auth provides Google OAuth and MongoDB-backed group membership; all group data routes verify the server session and membership. MongoDB Atlas owns canonical fragment and moment records. Tiger Data stores a derived, group-visible retrieval projection.

The provider in `src/lib/ai/gemma-provider.ts` sends compact context packets to Ollama's non-streaming `/api/chat` endpoint, requests JSON Schema-constrained output, and can pass image bytes for multimodal analysis. Configuration defaults to `http://localhost:11434`, `gemma4:e2b-it-q4_K_M`, and a five-minute timeout; override these with `OLLAMA_HOST`, `GEMMA_MODEL`, and `GEMMA_TIMEOUT_MS`. The current reconstruction and fragment-analysis flows still process approved text/transcripts only; the presence of image/audio capabilities in the local runtime does not mean the private upload pipeline is already multimodal.

Set `MONGODB_URI` and `TIGER_DATABASE_URL` for database access. See `.env.example` for the expected variables. Apply `migrations/tiger/001_fragment_search.sql` and `migrations/tiger/002_fragment_analysis_search.sql` to the selected Tiger database before retrieval is used.

Authentication also requires `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Configure the Google OAuth callback as `/api/auth/callback/google`. Without these values, sign-in and group data APIs fail closed; there is no development impersonation mode.

Run locally with `npm install`, then `npm run dev`. `npm test`, `npm run typecheck`, and `npm run build` provide the current verification gates.

## Text fragments and processing worker

The current app supports text fragments, short private WAV voice notes, private photo uploads (JPEG/PNG/WebP up to 12 MB), and short video uploads (MP4/WebM up to 25 MB). Photo/video media is stored in a private MongoDB GridFS bucket and served only after group membership and fragment visibility checks. Images/videos are not sent to AI or used for Moment reconstruction; members can add text captions and separately contribute eligible text or reviewed voice transcripts. Voice audio uses its own private GridFS bucket. Previously stored objects in any legacy bucket are not deleted by this app and must be cleaned up manually.

Text-fragment analysis is off by default. A contributor must explicitly enable AI processing; only group-visible, consented analyses are indexed in Tiger. Local Gemma analysis and reconstruction run through a separate Temporal worker. For a local Temporal service, set `TEMPORAL_ADDRESS=localhost:7233`, `TEMPORAL_NAMESPACE=default`, and `TEMPORAL_TLS=false`; for Temporal Cloud, use its namespace endpoint/namespace, TLS, and `TEMPORAL_API_KEY`. Start the app with `npm run dev` and the worker in a separate terminal with `npm run worker`. Workflow history contains only opaque group, fragment, job, and requester IDs; workers recheck authorization and fetch authorized text-derived analyses from MongoDB.

Text capture works without AI consent or Temporal. Consented analysis requires MongoDB, Temporal, the local Ollama model named by `GEMMA_MODEL`, and Tiger Data for group-visible projections. Do not put Temporal or model-service credentials in `NEXT_PUBLIC_` variables.

Voice-note uploads require mono 16-bit PCM WAV at 16 kHz, up to 60 seconds/2 MB. They stay private until the author reviews/edits the transcript and separately chooses visibility and local-AI processing consent. Optional ElevenLabs transcription is off by default; check account retention/terms and explicitly approve usage caps before setting `ELEVENLABS_TRANSCRIPTION_ENABLED=true`, `ELEVENLABS_API_KEY`, `ELEVENLABS_MONTHLY_SECONDS`, and `ELEVENLABS_MONTHLY_REQUESTS`. Zero monthly caps keep transcription unavailable; provider/Temporal/credit unavailability leaves the clip for manual transcription.

Members can request Moment reconstruction from an eligible group-visible text fragment. Gemma receives a bounded context packet; the server validates evidence and derives uncertainty, and group members can review candidates, correct or remove evidence, and confirm moments. Merge actions require MongoDB transaction support. Backboard memory is disabled by default: an owner/admin must enable it, and a member must explicitly share an individual correction on a confirmed Moment. Set `BACKBOARD_API_KEY` on the server; brief summaries/entities from eligible group-visible fragments may be sent as read-only search queries, but raw source text is not sent to Backboard. Disabling Backboard or deleting a group removes the group's Backboard assistant.

## Phase 9 evaluation and deployment preparation

Run `npm run evaluate:phase9` for the deterministic synthetic acceptance report. It contains 84 generated fragments across development and held-out event/group splits, with same-place and same-people near-neighbors, misleading text, single-contributor evidence, synthetic mixed-modality labels, and insufficient-evidence examples. The report measures retrieval false merges/misses and exercises server evidence validation against private and foreign-group IDs. It contains no real participant content and is not a model-quality or pilot-performance claim. Set an explicit acceptable pilot false-merge threshold before launch.

`render.yaml` prepares separate Render web and Temporal worker services, and `/api/health` is a liveness endpoint. The blueprint does not deploy automatically. Before creating paid services, an operator must supply credentials and verify MongoDB/Tiger access, Gemma runtime availability, Google OAuth callbacks, Temporal Cloud/staging configuration and recovery, deletion behavior, provider terms/cost limits, and the pilot invite list.

### Gemma 4 E2B Render readiness gate (2026-10-04)

**Do not deploy the current Gemma-dependent worker with the plans in `render.yaml`.** Both the web and Temporal worker currently use Render's legacy `starter` plan. Render documents this as 0.5 CPU and 512 MB RAM for web services and background workers. That is insufficient for Gemma 4 E2B.

The local developer runtime was inspected with Ollama 0.35.1: `gemma4:e2b-it-q4_K_M` is installed and occupies 4.6 GB on disk. Google documents an approximate 2.9 GB memory requirement for Gemma 4 E2B Q4_0 static weights alone; that estimate excludes the serving software and context/KV cache. The exact Ollama Q4_K_M package has a larger on-disk footprint, and its runtime memory requirement must be measured on the actual deployment plan. CPU-only inference is expected to be slow. The app must not point Render at a developer's localhost, PC, GPU, or private LAN.

The smallest viable Render-only deployment to evaluate is a dedicated **private service** running Ollama and the pinned Gemma 4 E2B model on the `pro_plus` / `4c-8g` plan (4 CPU, 8 GB RAM), with a persistent disk of at least 10 GB mounted for Ollama's model store. Keep the web app and Temporal orchestration worker separate and have them reach this private inference service over Render's private network. This leaves room for the model's weights plus Ollama, context, and the service process; it is a starting capacity to benchmark, not a performance guarantee. Verify actual load peak memory, inference latency, disk usage, and available Render credits before enabling AI in production. Do not use the existing 512 MB worker plan to host Gemma.

This configuration is **not implemented or deployed yet**. The current app has an Ollama-specific provider, the Render Blueprint has no Ollama service or model disk, and the end-to-end pipeline does not yet process uploaded image/video/audio observations. Until the resource and credit gate is approved and measured, local Gemma remains development-only and production AI must remain disabled; do not substitute a hosted LLM or external Ollama host.

References: [Gemma 4 capabilities and inference memory](https://ai.google.dev/gemma/docs/core), [Ollama Gemma 4 model](https://ollama.com/library/gemma4), [Ollama chat API](https://docs.ollama.com/api/chat), [Ollama vision API](https://docs.ollama.com/capabilities/vision), [Render compute plans](https://render.com/docs/compute-plans), [Render persistent disks](https://render.com/docs/disks), and [Render background workers](https://render.com/docs/background-workers).

Sentry is disabled by default (`SENTRY_ENABLED=false` and `NEXT_PUBLIC_SENTRY_ENABLED=false`). Before enabling it, an operator must verify the Sentry project and retention settings. The SDK disables identity, cookies, headers, request/response bodies, query parameters, GenAI content, database payloads, queue arguments, local variables, and replay. Event and span hooks replace exception details and remove request/context/attribute data; no source maps are uploaded. Staging must still verify actual incoming events are scrubbed before enabling telemetry for a pilot.

## Documentation set

The product and architecture planning documents are:

- PRODUCT.md
- ARCHITECTURE.md
- AI_PIPELINE.md
- CONTEXT_ENGINEERING.md
- DATA_MODEL.md
- AI_CONTRACTS.md
- PRIVACY.md
- MVP.md
- ROADMAP.md
- DECISIONS.md
- IMPLEMENTATION_PLAN.md

## What is intentionally excluded from the first build

The MVP does not include public social features, comment systems, generic AI chat, or polished recap generation. Members can contribute text, private photos, short videos, and optional bounded WAV voice notes. Photo/video AI analysis is not enabled; voice transcription is a separate, disabled-by-default opt-in. The system identifies likely shared moments from eligible text and reviewed voice transcripts with evidence-backed reasoning.

## Definition of success

This project is successful when multiple people independently contribute fragments from the same experience and the system can connect them into a shared moment, explain the connection, preserve uncertainty, and surface a meaningful memory without inventing false details.
