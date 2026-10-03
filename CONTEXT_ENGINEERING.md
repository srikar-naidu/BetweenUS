# Context Engineering: Minimum Sufficient Evidence

## Principle

Provide the smallest authorized context that can answer one task. Context is not a shortcut around access control: group, author, visibility, AI consent, and deletion checks happen before retrieval and again before persistence.

MongoDB owns structured facts and provenance. Tiger returns a bounded derived candidate set. Backboard contributes a few durable meanings the group explicitly confirmed. Gemma receives none of these stores wholesale.

## Context profiles

| Task | Context allowed | Never include |
|---|---|---|
| `observe_fragment` | One authorized source Fragment, required media bytes or its text, extraction schema, capture metadata, and consent state | Other group history, unrelated members, Backboard corpus, or a full timeline |
| `transcribe_voice` | The opted-in audio object, language/options, and source Fragment ID held outside provider payload where possible | Images, group history, prompts about the group's memories, or unrelated audio |
| `investigate_moment` | A narrow hypothesis, eligible candidate Observations, timestamps, provenance, contradictions, selected graph relations, a few confirmed Backboard meanings, and optional validated scoring features | Private/restricted candidates, unbounded history, direct identifiers not required for reasoning, or unsupported inferred participants |
| `detect_story` | A bounded set of eligible confirmed/provisional Moments across a specific group/time range, with their evidence summaries and correction history | Other groups, raw media, all member histories, or speculative Backboard content |
| `narrate_confirmed_memory` | Member-approved Moment/Story text and pronunciation hints explicitly approved for narration | Raw media, source transcripts, unconfirmed hypotheses, full Context Packets, or unrelated group context |
| `build_correction_example` | Prediction, member action, chosen evidence IDs, structured features, versions, and consent/de-identification state | Raw media, direct identity, API keys, full prompts, or private member text unless separately approved |

## Context Packet contract

Packets are task-specific, versioned, size-bounded, and reproducible from canonical records. Each candidate item has a stable opaque ID, group ID, capture time/timezone, source type, visibility/consent snapshot, Observation references, evidence provenance, and retrieval signals. The packet distinguishes:

- **Observation:** what the media/text directly supports;
- **Interpretation:** uncertain semantic explanation;
- **Relationship:** an evidence-backed link to another object;
- **Hypothesis:** a possible Moment/Story, not a fact;
- **Contradiction/unknown:** evidence that weakens or does not resolve a claim.

Example investigation packet:

```json
{
  "schema_version": "moment-investigation-v1",
  "task": "investigate_moment_hypotheses",
  "group_ref": "opaque-group-ref",
  "time_window": {
    "start": "2026-09-04T11:50:00Z",
    "end": "2026-09-04T12:30:00Z"
  },
  "hypotheses": [
    {
      "id": "opaque-hypothesis-id",
      "summary": "A possible cafeteria gathering",
      "uncertainty": "possible",
      "evidence_ids": ["fragment-a", "fragment-b"]
    }
  ],
  "candidates": [
    {
      "fragment_id": "fragment-a",
      "captured_at": "2026-09-04T12:04:00Z",
      "type": "image",
      "observations": [
        { "claim": "cafeteria table with drinks", "kind": "visual_observation", "source": "fragment-a" }
      ],
      "retrieval_signals": { "time_distance_seconds": 0, "lexical_match": true }
    }
  ],
  "group_meanings": [
    { "meaning": "A member-confirmed alias for the cafeteria", "provenance": "correction-id" }
  ],
  "scoring": null,
  "constraints": [
    "Cite only supplied evidence IDs.",
    "Do not infer identity from uploader identity or face appearance.",
    "Return competing explanations and uncertainty when evidence is ambiguous.",
    "Never mark a Moment confirmed."
  ]
}
```

The example is illustrative. Production packets must not contain the human-readable names shown here unless the task requires an already-authorized display value.

## Retrieval order and budgets

1. Authorize group and requesting member.
2. Fetch only active Fragments visible to that member or group and eligible for the specific AI purpose.
3. Apply deterministic time window and candidate-count limits.
4. Query Tiger for temporal/lexical results; add semantic-vector search only after its model, dimensions, quality, and privacy behavior are verified.
5. Expand a bounded set of MongoDB relationships (confirmed aliases, Places, Entities, Moments, Story edges) with same-group filters on every read.
6. Fetch only a few relevant confirmed Backboard meanings for that group.
7. Deduplicate, rank, and truncate before building the packet.

Use hard candidate and token budgets as configuration, record the budget/version, and measure recall versus false merges before changing them. A budget must never be raised to recover unauthorized/private data. Retrieval outages may fall back to a simpler temporal/lexical path; they may not fall back to cross-group or private history.

## Evidence scoring and convergence context

If TabPFN is verified and enabled, pass a separately versioned feature vector, not media or free-form history. Candidate signals may include time distance, validated semantic similarity, shared confirmed entity/place, explicit participant evidence, event-like text overlap, capture density, existing Moment links, and contradiction indicators. Missing evidence is represented explicitly, not coerced to zero certainty. Persist scorer version/calibration and its estimate alongside provenance. Gemma may investigate the score; neither score nor model output confirms a Moment.

For convergence, packets include the current hypothesis version, prior evidence IDs, competing hypotheses, changed/new evidence, and member corrections relevant to this exact group. Do not send the entire revision history: summarize it with links to canonical records and include only the changes needed for the current decision.

## Memory layers

1. **Source memory:** private R2 bytes and Mongo Fragment metadata. Exact source, author, consent, capture timezone, checksum, and deletion state stay linked.
2. **Observation memory:** structured, uncertain claims in MongoDB tied to one or more source IDs and model versions.
3. **Episodic memory:** competing Moment hypotheses, evidence relations, confirmations/corrections, and Stories in MongoDB.
4. **Retrieval memory:** group-visible derived Tiger projections that can be deleted/rebuilt from authorized MongoDB state.
5. **Semantic group context:** Backboard meanings members confirmed: nicknames, inside jokes, aliases, and recurring references. This is not canonical event state and does not duplicate raw media.

## Voice context

STT receives only the author-opted-in audio and minimal transcription options. Store transcript and timestamps as a derived Observation linked to the original voice Fragment. Speaker diarization produces anonymous speaker labels unless a member explicitly maps a label; it never performs identity recognition. The author reviews transcript content before group-level use.

TTS is a separate opt-in operation after a Moment/Story is confirmed or specifically approved for narration. Send only the approved short text, not the Context Packet or group memory. Store output as a private derived object with provenance, consent, provider/version, and deletion linkage. Keep disabled until retention, credits, and provider terms pass review.

## Corrections and learning data

Corrections remain canonical Mongo records and preserve the original prediction. Evaluation examples should contain only the structured prediction, action, selected evidence/features, uncertainty, and implementation versions. Apply data minimization and de-identification before export. Tinker use additionally requires explicit experiment approval, supported model/runtime verification, account terms, spend cap, held-out evaluation, and deletion plan. Do not treat every correction as training consent.

## Caching and invalidation

Cache only versioned derived outputs such as an Observation or retrieval result. Cache keys include source checksum, group scope, visibility/consent state, model/extractor version, schema version, and retrieval configuration. Invalidate when content, access, consent, deletion state, model/schema, or evidence rules change. Never reuse a cached result across groups or after access revocation.

## Hallucination, privacy, and telemetry controls

- Distinguish direct observations from inference; cite opaque source IDs for every claim.
- Do not infer identity, relationships, locations, or events unsupported by evidence.
- If evidence is weak or conflicting, preserve competing hypotheses or return `unknown`.
- Verify cited IDs and permissions from MongoDB after model return; do not trust the Packet or model output alone.
- Temporal history contains opaque IDs and small statuses only, never raw media, transcripts, embeddings, prompts, completions, or Context Packets.
- Sentry receives scrubbed spans, timings, safe error categories, component/model versions, and opaque job/Moment IDs. Disable bodies, generative-AI content capture, direct user identity, and replay.
- External services receive only task-specific minimum data after explicit consent/retention/budget gates. No automatic provider fallback.

## Current implementation boundary

The current production code can ingest private media/text, record provenance and processing jobs, and enforces retrieval/evidence/visibility boundaries in the existing demo. The full multimodal Observation schema, Mongo graph expansion, Tiger semantic vectors, Backboard context, TabPFN scoring, Mastra orchestration, correction-trained Tinker loop, and voice narration remain design targets, not active capabilities. Do not expose UI or telemetry claiming otherwise.
