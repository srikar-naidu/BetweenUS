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
- Version: 0.35.0
- Local endpoint: http://localhost:11434
- Available Gemma model: gemma4:e2b-it-q4_K_M
- Model capabilities: completion, vision, audio, tools, thinking
- Context length: 131072 tokens
- Embedding length: 1536

The runtime adapter targets Ollama's HTTP API; it does not assume a different local runtime.

## Setup overview

The application foundation uses Next.js App Router and TypeScript on Node.js. Better Auth provides Google OAuth and MongoDB-backed group membership; all group data routes verify the server session and membership. MongoDB Atlas owns canonical fragment and moment records. Tiger Data stores a derived, group-visible retrieval projection.

The provider in `src/lib/ai/gemma-provider.ts` sends compact context packets to Ollama's non-streaming `/api/chat` endpoint, requests JSON Schema-constrained output, and can pass image bytes for multimodal analysis. Configuration defaults to `http://localhost:11434`, `gemma4:e2b-it-q4_K_M`, and a five-minute timeout; override these with `OLLAMA_HOST`, `GEMMA_MODEL`, and `GEMMA_TIMEOUT_MS`.

Set `MONGODB_URI` and `TIGER_DATABASE_URL` for database access. See `.env.example` for the expected variables. Apply `migrations/tiger/001_fragment_search.sql` to the selected Tiger database before retrieval is used.

Authentication also requires `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Configure the Google OAuth callback as `/api/auth/callback/google`. Without these values, sign-in and group data APIs fail closed; there is no development impersonation mode.

Run locally with `npm install`, then `npm run dev`. `npm test`, `npm run typecheck`, and `npm run build` provide the current verification gates.

## Text fragments and processing worker

The current app supports text fragments only. Media upload and retrieval endpoints have been removed, and no object-storage provider is required. Previously stored objects in any legacy bucket are not deleted by this app and must be cleaned up manually.

Text processing uses a separate Temporal worker. For a local Temporal service, set `TEMPORAL_ADDRESS=localhost:7233`, `TEMPORAL_NAMESPACE=default`, and `TEMPORAL_TLS=false`; for Temporal Cloud, use its namespace endpoint/namespace, TLS, and `TEMPORAL_API_KEY`. Start the app with `npm run dev` and the worker in a separate terminal with `npm run worker`. The worker receives opaque group, fragment, and job IDs only and fetches authorized text records from MongoDB.

Text ingestion requires the database and processing configuration; it fails with a configuration error rather than accepting work that cannot be processed. Do not put Temporal credentials in `NEXT_PUBLIC_` variables.


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

The MVP does not include media uploads, public social features, comment systems, generic AI chat, or polished recap generation. The first build is scoped to proving that multiple users can contribute text fragments and that the system can identify likely shared moments with evidence-backed reasoning.

## Definition of success

This project is successful when multiple people independently contribute fragments from the same experience and the system can connect them into a shared moment, explain the connection, preserve uncertainty, and surface a meaningful memory without inventing false details.
