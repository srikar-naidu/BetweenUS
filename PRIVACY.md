# Privacy and governance

## Goal

Between Us is a private memory system. Privacy is not a product feature layered on later; it is part of the product’s architecture.

## Group isolation

Each group has a private memory boundary. Fragments and AI interpretations should be segregated by group.

Rules:

- no cross-group reuse of fragments without explicit membership
- no shared moment inference across groups unless membership is explicitly shared
- group IDs must be used in retrieval and visibility checks

## Media visibility

Image/video upload and third-party object-storage retrieval are disabled. Optional voice notes are stored in a private MongoDB GridFS bucket and are available only through authenticated, group-scoped routes. Existing legacy media records may remain for compatibility, and any original files in a previously configured bucket require manual cleanup.

The system must enforce:

- author ownership
- group visibility rules
- consent for shared interpretation
- explicit boundaries for private evidence

A private fragment must not be exposed to the rest of the group merely because the AI thinks it belongs to a shared moment.

## AI processing boundaries

AI processing should occur within the group context and with explicit ownership checks.

Rules:

- AI may analyze only authorized fragments
- AI observations must carry evidence references
- AI-generated interpretations must not bypass visibility rules
- private fragments must remain private unless explicitly allowed

## Deletion and correction

Users must be able to delete content and associated AI observations where appropriate.

The system must handle:

- deletion of the raw fragment
- invalidation of dependent AI observations
- notification of impacted moments or stories
- retention rules for evidence references

## Ownership

Ownership is explicit:

- the original uploader owns the raw fragment
- the group owns the shared memory space
- AI-generated interpretations do not replace ownership claims
- any group-level insight must still trace back to source evidence and permissions

## Consent

The system should require consent for non-trivial AI use cases involving personal material.

Examples:

- a fragment is used in shared memory reconstruction
- an upload is included in group-level evidence or discovery
- a correction or memory interpretation is merged into shared context

## Private fragments

Private fragments are treated as sensitive records. They may:

- be analyzed for local understanding
- be used only when the user’s access scope permits it
- contribute to shared moment reconstruction only under explicit rules

The system should default to privacy-preserving behavior and require a clear policy for when private data can be used in group-level inference.

## Evidence access

Users should be able to inspect why a moment or story was inferred.

The system should support:

- fragment-level evidence visibility
- confidence and uncertainty display
- explicit user controls over what can be shown within the group

## Privacy-by-default principle

If the system is uncertain whether a fragment should be used in a shared inference, it should default to “do not include” rather than “assume it belongs.”

## External AI providers

### Backboard

- Create a separate assistant for each group; assistant-level memories are shared across its threads.
- Store only confirmed, high-level group facts and corrections. Do not store raw media, private fragment content, or speculative moment narratives.
- Keep provider memory IDs and source provenance in MongoDB. Implement update/delete propagation and verify group deletion.
- Retrieve memory read-only for context assembly; only explicitly confirmed corrections may be written.

### ElevenLabs

- Voice-note transcription is opt-in per author and disabled until provider retention, terms, credits, and account eligibility are reviewed.
- Store voice audio in a private, group/fragment-scoped MongoDB GridFS bucket before any provider call. Currently accept only mono 16-bit PCM WAV at 16 kHz, at most 60 seconds and 2 MB.
- Tell the uploader that audio leaves Between Us for transcription. Record provider-specific consent separately from local AI consent. Send only the selected audio file, not a full ContextPacket or group history.
- Keep the fragment private and AI-disabled until the author edits/approves the transcript and selects visibility and local-AI consent. Preserve word timestamps as offsets to the original audio.
- Keep the feature off by default. Enable only with `ELEVENLABS_TRANSCRIPTION_ENABLED=true`, an API key, and approved non-zero `ELEVENLABS_MONTHLY_SECONDS` and `ELEVENLABS_MONTHLY_REQUESTS`; enforce the clip cap server-side. Reservations are stored per UTC month and are not refunded after provider outcomes become uncertain.
- ElevenLabs documents zero-retention mode as enterprise-only; do not assume it is available on a free-credit account.
- Do not use voice cloning, speaker diarization, or TTS in the MVP. Do not automatically retry a failed external transcription.
- If consent, quota, provider configuration, or Temporal is missing, retain the clip privately for manual transcription without blocking text-fragment capture.

### Tinker

- Tinker is an offline experiment, not a production inference dependency by default.
- Use synthetic or explicitly de-identified/consented training examples only. Never upload private group media, raw Backboard memory, or personal identifiers.
- Use a dedicated project, a hard spend cap, and documented cleanup for training runs/checkpoints. Confirm current model support and data terms before sending any sample.

### Temporal

- Temporal workflow history can persist for retries and replay; pass only opaque IDs and minimal status metadata.
- Activities fetch authorized media/context from canonical stores at execution time. Persist sensitive outputs to MongoDB/Tiger and return opaque IDs/status only. Never put binary media, extracted text, transcripts, full ContextPackets, model prompts/completions, or access tokens in workflow arguments/results.
- Use idempotency keys and authorization checks in every activity. Workflow failure must not widen visibility or bypass deletion.

### Sentry

- Disable request/response body, generative-AI input/output, user-identity, stack-local, and session-replay collection.
- Scrub exception messages, breadcrumbs, spans, URLs, and tags so fragment text, group names, emails, transcripts, and credentials cannot enter telemetry.
- Correlate using opaque job IDs and safe error categories. Sentry failure must not block product actions.
