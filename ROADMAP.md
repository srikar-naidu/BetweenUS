# Roadmap

## MVP

The MVP is the smallest product that proves the core claim:

- multiple users upload fragments
- the system finds likely relationships
- Gemma reconstructs a candidate moment
- the user sees an evidence-backed result with uncertainty

MVP scope includes:

- authenticated private groups and membership isolation
- group setup
- fragment upload
- private media storage and deletion
- fragment metadata extraction
- candidate retrieval
- moment reconstruction
- evidence display
- basic corrections
- group-scoped Backboard memory for member-confirmed corrections and aliases
- opt-in voice-note transcription through ElevenLabs, only after privacy/retention and credit checks
- MongoDB-backed durable jobs with a separate Render worker, leases, and restart recovery
- Sentry monitoring with request bodies, AI content, media, and user identity collection disabled
- a capped Tinker specialization experiment with a written baseline comparison; not required for production inference

The phase-by-phase implementation sequence and release gates are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## V1

V1 extends the MVP into a more trustworthy, more useful private memory system.

Features may include:

- stronger evidence visualization
- better event clustering
- better person and place extraction
- initial support for story-like group memory summaries
- improved uncertainty labeling and user corrections

## V2

V2 focuses on retrospective memory discovery and broader pattern awareness.

Examples:

- forgotten moments
- recurring stories
- hidden connections across time
- perspective reconstruction across different contributors
- “you forgot this” experiences

## Experimental

Experimental items are important ideas but not required for core product success.

Examples:

- memory archaeology across long time spans
- group-specific recurring joke detection
- scheduled Story refresh after new confirmed Moments
- stronger multimodal extraction experiments
- additional Tinker training iterations only if the bounded MVP experiment shows a measurable need
- TabPFN experiment on aggregated, non-identifying activity patterns after enough labeled moments exist
- Entire development-session provenance only if its Copilot CLI/external-agent integration fits the team workflow

## Optional partner technologies

The following technologies remain deferred because there is no MVP product requirement or a selected service already covers the responsibility:

- Mastra
- SerpApi
- DigitalOcean
- Arduino

Mastra overlaps with Temporal and the typed provider adapters; SerpApi adds unrelated web search to a private-memory product; DigitalOcean duplicates the selected Render deployment. Revisit only if a concrete requirement changes that trade-off.

## Tinker experiment

Tinker is included as a bounded MVP experiment because the developer has partner credits, but it is not on the production request path by default. Run it only after the Gemma baseline and labeled evaluation set exist, the live catalog/credit entitlement is verified, and a specific model failure is measurable. Tinker usage requires an explicit spend cap.

Use only synthetic or explicitly de-identified/consented examples. Do not send raw group media or private memories. Verify that the current Tinker catalog supports the intended base model; do not assume Gemma 4 is available. If it is not, compare one suitable supported model as a separate experiment while keeping local Gemma as the product default.

The experiment report must include:

- baseline performance
- failure cases
- dataset collection
- specialization approach
- evaluation strategy
- improvement measurement
- actual credits consumed
- a go/no-go decision for any future runtime use

Only consider production adoption if held-out quality improves without increasing false merges or evidence failures, the inference route is compatible, privacy is approved, and the credit/cost limit is met. Otherwise the experiment is complete with no production Tinker dependency.

## Backboard plan

Backboard is part of the MVP for confirmed group memory, not a replacement for MongoDB. Use a separate assistant per group because assistant memory is shared across every thread attached to that assistant. Explicitly add only confirmed aliases, recurring references, and member-approved corrections; use read-only retrieval for context assembly. Store Backboard IDs and source provenance in MongoDB so edits, member removal, and group deletion can update/delete provider memories.

## ElevenLabs plan

Use ElevenLabs Scribe only for opt-in voice-note transcription. The author reviews/corrects the transcript before it becomes group-visible or enters shared reconstruction. Treat this as an external processing boundary: verify current credits, terms, and retention, set a hard usage cap, and provide a manual/local fallback. Voice cloning and TTS are out of MVP scope.
