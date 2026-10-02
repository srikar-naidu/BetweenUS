# Between Us

Between Us is a private shared-memory system for reconstructing the moments a group of friends actually experienced together from the tiny fragments each person captured independently. Instead of treating photos as the primary object, the system treats a real-world moment as the primary unit of understanding.

## Problem

Most shared-photo products answer: “What did my friends post?”

Between Us answers: “What actually happened between all these fragments?”

Friends rarely document an event completely. One person uploads a photo, another sends a screenshot, someone else records a short video, and another writes a caption like “bro 💀.” Those fragments may belong to the same real-world event, but nobody recorded the full story in one place.

Between Us discovers those relationships, reconstructs the likely moment, and preserves evidence and uncertainty instead of inventing certainty.

## Why it differs from a normal shared album

The product is not a gallery, a social feed, or an AI recap generator. It is a memory reconstruction system.

The key abstraction is:

- Fragment: one captured piece of information
- Moment: a reconstructed real-world event from multiple fragments
- Story: a recurring pattern or relationship across multiple moments over time

The user experience is designed to answer: “We forgot this happened,” not “Here is a pretty AI recap.”

## Core user experience

1. Multiple people upload fragments from the same period.
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
- Persistent memory: Backboard
- Deployment: Render
- Future specialization: Tinker only if a clear training problem emerges

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

The application foundation uses Next.js App Router and TypeScript on Node.js. MongoDB Atlas owns canonical fragment and moment records. Tiger Data stores a derived, group-visible retrieval projection.

The provider in `src/lib/ai/gemma-provider.ts` sends compact context packets to Ollama's non-streaming `/api/chat` endpoint, requests JSON Schema-constrained output, and can pass image bytes for multimodal analysis. Configuration defaults to `http://localhost:11434`, `gemma4:e2b-it-q4_K_M`, and a five-minute timeout; override these with `OLLAMA_HOST`, `GEMMA_MODEL`, and `GEMMA_TIMEOUT_MS`.

Set `MONGODB_URI` and `TIGER_DATABASE_URL` for database access. See `.env.example` for the expected variables. Apply `migrations/tiger/001_fragment_search.sql` to the selected Tiger database before retrieval is used.

Run locally with `npm install`, then `npm run dev`. `npm test`, `npm run typecheck`, and `npm run build` provide the current verification gates.


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

## What is intentionally excluded from the first build

The MVP does not include public social features, comment systems, generic AI chat, or polished recap generation. The first build is scoped to proving that multiple users can upload fragments and that the system can identify likely shared moments with evidence-backed reasoning.

## Definition of success

This project is successful when multiple people independently upload fragments from the same experience and the system can connect them into a shared moment, explain the connection, preserve uncertainty, and surface a meaningful memory without inventing false details.
