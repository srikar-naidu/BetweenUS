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

The signed-in experience also includes a weekly Home journal, Friends discovery, and Albums. Each group is an album; a friend connection alone never shares a person's posts or grants album access. Group owners and admins can upload a private JPEG, PNG, or WebP album cover (up to 12 MB); without one, the latest group-visible photo/video remains the automatic cover. Members can optionally let others find them by name. An album's Event story is a separate, editable recap built only from its currently member-visible, confirmed Moments; members choose which Moments to include and can edit the text before saving.

Event stories are generated asynchronously by the same `GemmaService` through the Temporal worker. Gemma uses the current, consented fragment observations supporting the selected confirmed Moments: image observations, sampled video-frame observations, and author-reviewed voice transcripts. The story is returned as cited sections, and the application validates every evidence reference before saving. Raw voice recordings are not sent to Gemma; if an observation is missing, stale, or consent was revoked, generation fails rather than filling the gap. Configure and run the Temporal worker as described below.

## Core user experience

1. Multiple people contribute text fragments from the same period.
2. The system groups likely related fragments.
3. The AI reasons over only relevant candidate context.
4. The system surfaces a probable moment with evidence.
5. Users can inspect why the system connected the fragments.
6. Over time, recurring stories and hidden connections are surfaced.

## Architecture overview

The inference interface is portable; the runtime changes by environment:

- Development AI layer: Gemma 4 E2B via local Ollama
- Render AI layer: Gemma 4 E2B via a dedicated private Ollama service
- Application DB: MongoDB Atlas
- Retrieval layer: Tiger Data for temporal and lexical candidate search; vectors are deferred until an embedding model is selected
- Persistent, confirmed group memory: Backboard
- Opt-in voice-note transcription: ElevenLabs Scribe, after privacy and credit gates
- Durable processing: Temporal TypeScript workflows
- Privacy-scrubbed observability: Sentry
- Deployment: Render
- Bounded model-specialization experiment: Tinker, compared against Gemma; not the default runtime

## Gemma runtime

The application uses Gemma 4 E2B through `GemmaService`. Local development talks to the developer's Ollama at `http://localhost:11434`; Render runs a separate Ollama service on Render's private network. The production worker never falls back to localhost or a developer machine.

Install Ollama, then pull and run the supported E2B model:

```powershell
ollama pull gemma4:e2b
ollama run gemma4:e2b
```

Ollama's Gemma 4 integration accepts text and image inputs and supports JSON Schema-constrained responses on `/api/chat`. The E2B model also supports audio, but Between Us deliberately does not send raw voice recordings to Gemma: only author-reviewed transcripts may enter the memory pipeline. Gemma extracts uncertain, source-linked observations and evaluates bounded retrieval context; it is not used as a chatbot or caption generator.

## Setup overview

The application foundation uses Next.js App Router and TypeScript on Node.js 20.19+, 22.12+, or 23.2+. Better Auth provides Google OAuth and MongoDB-backed group membership; all group data routes verify the server session and membership. MongoDB Atlas owns canonical fragment and moment records. Tiger Data stores a derived, group-visible retrieval projection.

`src/lib/ai/gemma-provider.ts` owns the `GemmaService` interface, the shared Ollama protocol adapter, and the `LocalGemmaAdapter`/`RenderGemmaAdapter` runtime choices. Set `GEMMA_RUNTIME=local` for development (the default outside production), `OLLAMA_HOST=http://localhost:11434`, `GEMMA_MODEL=gemma4:e2b`, and `GEMMA_TIMEOUT_MS=300000`. The adapter sets temperature to zero and caps requests at 4,096 context tokens and 2,048 generated tokens. Observation extraction disables optional thinking for lower CPU latency; bounded Moment reconstruction enables it. Structured response schemas and all source/evidence checks are validated again in application code before persistence.

Set `MONGODB_URI` and `TIGER_DATABASE_URL` for database access. See `.env.example` for the expected variables. Apply `migrations/tiger/001_fragment_search.sql` and `migrations/tiger/002_fragment_analysis_search.sql` to the selected Tiger database before retrieval is used.

Authentication also requires `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Configure the Google OAuth callback as `/api/auth/callback/google`. Without these values, sign-in and group data APIs fail closed; there is no development impersonation mode.

Run locally with `npm install`, then `npm run dev`. `npm test`, `npm run typecheck`, and `npm run build` provide the current verification gates.

## Fragment processing worker

The app supports text fragments, short private WAV voice notes, private photo uploads (JPEG/PNG/WebP up to 12 MB), and short video uploads (MP4/WebM up to 25 MB). Photo/video media is stored in a private MongoDB GridFS bucket and served only after group membership and fragment visibility checks. With explicit AI consent, the background worker loads an image or at most six sampled video frames and sends those bytes only to the configured internal Gemma runtime. It stores bounded observations, not duplicate media or captions. Video frames are transient processing inputs. Voice audio uses its own private GridFS bucket and is never sent to Gemma. Previously stored objects in any legacy bucket are not deleted by this app and must be cleaned up manually.

Group posting starts from one Post action and supports text, photo, audio, or video. New posts are visible to members of that group; the composer does not ask for an audience setting. Gemma classification is a separate opt-in. For audio, the raw recording is group-visible but is never sent to Gemma; optional ElevenLabs transcription has separate explicit consent, and the author reviews the transcript before sharing it or allowing Gemma to analyze the approved text. Image/video previews and an audio waveform/player are shown in the composer and group feed.

AI processing is off until a contributor opts in. The upload request persists the fragment and queues a Temporal workflow; Gemma inference runs later in the separate worker, so slow inference does not hold the upload request open. The group UI polls and displays queued/running/failed/reviewable state, plus Gemma's validated tentative observations and their quoted evidence when available. Failure messages distinguish runtime reachability, invalid model output, and ineligible source without exposing raw model or media data. Only active, group-visible, consented analyses are indexed in Tiger. For a local Temporal service, set `TEMPORAL_ADDRESS=localhost:7233`, `TEMPORAL_NAMESPACE=default`, and `TEMPORAL_TLS=false`; for Temporal Cloud, set `TEMPORAL_ADDRESS` to the namespace endpoint host and port, `TEMPORAL_NAMESPACE` to the fully qualified namespace, `TEMPORAL_API_KEY` to a namespace-scoped API key, and `TEMPORAL_TLS=true`. Set the same values on the web service and worker. The Render blueprint declares all four as operator-supplied secrets/settings; keep them server-side and never use `NEXT_PUBLIC_`. Start the app with `npm run dev` and the worker in a separate terminal with `npm run worker`. Workflow history contains only opaque group, fragment, job, and requester IDs; workers recheck authorization and fetch the source when they run.

Text capture works without AI consent or Temporal. Consented analysis requires MongoDB, Temporal, the configured Ollama/Gemma service, and Tiger Data for group-visible projections. A failed Gemma call leaves the original fragment stored and processing marked failed for retry/review; it does not make upload synchronous. Do not put Temporal or model-service credentials in `NEXT_PUBLIC_` variables.

Voice-note uploads require mono 16-bit PCM WAV at 16 kHz, up to 60 seconds/2 MB. They stay private until the author reviews/edits the transcript and separately chooses visibility and local-AI processing consent. Optional ElevenLabs transcription is off by default; check account retention/terms and explicitly approve usage caps before setting `ELEVENLABS_TRANSCRIPTION_ENABLED=true`, `ELEVENLABS_API_KEY`, `ELEVENLABS_MONTHLY_SECONDS`, and `ELEVENLABS_MONTHLY_REQUESTS`. The current demo caps are 3,600 audio seconds and 60 requests per month. Create an ElevenLabs key with **Speech to Text: Access** only; leave other endpoints and account/workspace permissions disabled. Zero monthly caps keep transcription unavailable; provider/Temporal/credit unavailability leaves the clip for manual transcription.

Members can request Moment reconstruction from an eligible group-visible fragment. Retrieval first builds a small `ContextPacket` from MongoDB/Tiger Data plus up to three opted-in, confirmed Backboard memories; the entire database is never sent to Gemma. The server validates cited evidence and derives uncertainty, and group members can review candidates, correct or remove evidence, and confirm moments. Members can also request a background Story connection analysis across at most eight relevant confirmed Moments. Its compact packet contains only their summaries, current authorized observations, timestamps, and source IDs; candidates remain `possible` until a group member confirms them. Story jobs are group-scoped, idempotent Temporal workflows and never block uploads. Merge actions require MongoDB transaction support. Backboard memory is disabled by default: an owner/admin must enable it, and a member must explicitly share an individual correction on a confirmed Moment. Set `BACKBOARD_API_KEY` on the server/Render web service; only member-approved corrections are persisted there, and read-only searches use brief summaries/entities from eligible group-visible fragments. Raw media and raw source text are not sent to Backboard. Disabling Backboard or deleting a group removes the group's Backboard assistant and Story records/jobs.

## Phase 9 evaluation and deployment preparation

Run `npm run evaluate:phase9` for the deterministic synthetic acceptance report. It contains 84 generated fragments across development and held-out event/group splits, with same-place and same-people near-neighbors, misleading text, single-contributor evidence, synthetic mixed-modality labels, and insufficient-evidence examples. The report measures retrieval false merges/misses and exercises server evidence validation against private and foreign-group IDs. It contains no real participant content and is not a model-quality or pilot-performance claim. Set an explicit acceptable pilot false-merge threshold before launch.

`render.yaml` defines separate Render web and Temporal worker services plus a private Ollama/Gemma service. The blueprint does not deploy automatically. `/api/health` checks application liveness only, not model readiness. Before enabling production processing, an operator must supply credentials and verify MongoDB/Tiger access, model startup and inference, Google OAuth callbacks, Temporal Cloud/staging configuration and recovery, deletion behavior, provider terms/cost limits, available Render credits, and the pilot invite list.

### Render Gemma capacity and limitations

The `betweenus-gemma` Render private service uses the `4c-16g` compute plan (4 CPU, 16 GB RAM) and a 20 GB persistent disk for Ollama's model cache. The web and Temporal worker remain separate, small services and talk to Gemma over Render's private network; `OLLAMA_HOST` is populated from the private service reference, not a developer-supplied URL. Render does not expose this model service on the public internet. Ollama 0.35.1 is pinned in the Dockerfile, and startup pulls `gemma4:e2b` only when it is absent from the persistent disk.

The selected compute has enough headroom for a CPU-only demo based on Gemma's published Q4_0 static-weight estimate (about 2.9 GB) and Ollama's current E2B package size (about 7.5 GB on disk). Static-weight figures exclude the runtime and context/KV cache; actual peak RAM and disk use must still be observed after startup on Render. The persistent disk has room for that model plus runtime/download overhead. This is a conservative starting point, not a benchmark or a latency guarantee. There is no GPU: cold pulls/load and inference can be slow, requests are serialized, and each prompt is bounded to a 4K context. Monitor CPU, peak RAM, disk, and inference latency in Render before inviting a pilot group; do not increase context or parallel inference without measuring first.

Local smoke-test measurement on the developer machine: a warm CPU-only, 168-output-token observation took 41.6 seconds, and `ollama ps` reported 970 MB loaded for the locally installed Q4_K_M E2B model. This is a single synthetic request on different hardware/model packaging, not a Render performance or peak-memory result.

Render config sets `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, and a 5-minute keep-alive. Render plans/costs and available credits are account-specific; this repo cannot verify the account balance or perform a live deployment. The local developer PC, its GPU/RAM, and its network are not part of production capacity or availability.

### Testing the live local model

Run the opt-in live model test after starting local Ollama and pulling the model:

```powershell
$env:RUN_GEMMA_INTEGRATION = "true"
npx tsx --test tests/gemma-local.integration.test.ts
Remove-Item Env:RUN_GEMMA_INTEGRATION
```

The normal test suite uses deterministic fake responses and does not need Ollama, credentials, or private media.

### Future GPU portability

The memory pipeline depends only on `GemmaService.generateStructured`, not Render, Ollama networking, or a GPU implementation. A future `RemoteGemmaAdapter` can implement the same interface for a separately approved, private Gemma 4 E2B deployment. Keep that endpoint private, retain schema/evidence validation in the application, and never replace it with a hosted LLM or send private media to a third-party model API.

References: [Gemma 4 capabilities and inference memory](https://ai.google.dev/gemma/docs/core), [Ollama Gemma 4 model](https://ollama.com/library/gemma4), [Ollama chat API](https://docs.ollama.com/api/chat), [Ollama Docker runtime](https://docs.ollama.com/docker), [Render compute plans](https://render.com/docs/compute-plans), [Render private services](https://render.com/docs/private-services), [Render persistent disks](https://render.com/docs/disks), and [Render background workers](https://render.com/docs/background-workers).

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

The MVP does not include public social features, comment systems, generic AI chat, or polished recap generation. Members can contribute text, private photos, short videos, and optional bounded WAV voice notes. With explicit AI consent, Gemma analyzes private photos and at most six sampled frames per video; raw voice recordings are never sent to Gemma. Voice transcription is a separate, disabled-by-default opt-in, and only author-reviewed transcripts can enter the memory pipeline. The system identifies likely shared Moments from eligible, evidence-backed observations and supports member-triggered, evidence-linked Story candidates across confirmed Moments.

## Definition of success

This project is successful when multiple people independently contribute fragments from the same experience and the system can connect them into a shared moment, explain the connection, preserve uncertainty, and surface a meaningful memory without inventing false details.
