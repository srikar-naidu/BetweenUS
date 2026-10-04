# AI contracts

This project should use structured contracts internally instead of free-form narrative generation whenever possible. The goal is to make AI outputs inspectable, validatable, and easy to persist.

## Core design principle

The system should prefer JSON contracts that can be validated before storing or showing them to the user.

## Contract: FragmentAnalysis

```json
{
  "fragment_id": "string",
  "summary": "short exact excerpt from the source text",
  "observed_facts": [
    {
      "type": "person|place|object|activity|tone|reference",
      "value": "string",
      "confidence": 0.0,
      "source": "text",
      "evidence": "short exact quote from the source text"
    }
  ],
  "people": ["string"],
  "entities": ["string"],
  "location_hint": "string|null",
  "activity_hint": "string|null",
  "tone_hint": "string|null",
  "confidence": 0.0,
  "uncertainty": {
    "status": "possible|unknown",
    "reason": "string"
  },
  "evidence_fragment_ids": ["string"]
}
```

Phase 3 adds server-owned `analysis_version`, configured `model_version`, `source_text_sha256`, and `analyzed_at` provenance when persisting this contract. The current implementation accepts text fragments only. Fact values must appear inside their exact evidence spans, summaries must be exact source excerpts, and literal people/entity phrases must appear in the source text; the model cannot emit `likely` or `confirmed`.

## Contract: MomentReconstructionProposal

Gemma proposes evidence and notes only; it does not return an uncertainty label or confirmation state.

```json
{
  "title": "string|null",
  "summary": "string",
  "confidence": 0.0,
  "evidence": [
    {
      "fragment_id": "authorized context-packet fragment ID",
      "relationship": "temporal|shared_people|shared_location|semantic_similarity|entity_overlap"
    }
  ],
  "contradictions": [
    {
      "summary": "string",
      "evidence": [
        { "fragment_id": "authorized context-packet fragment ID", "quote": "exact stored observation quote" }
      ]
    }
  ],
  "missing_evidence": ["string"],
  "uncertainty_notes": ["string"],
  "inference_notes": ["string"]
}
```

The server validates every referenced ID against the authorized packet, exact quotes against stored observations, and each relationship against the stored observations or timestamps. Deterministic evidence rules assign `unknown`, `possible`, or `likely`; model confidence cannot upgrade the label. Only an explicit member action sets `confirmed`.

## Contract: MomentCandidate

```json
{
  "moment_id": "string|null",
  "group_id": "string",
  "candidate_window": {
    "start": "datetime",
    "end": "datetime"
  },
  "fragment_ids": ["string"],
  "summary": "string",
  "confidence": 0.0,
  "uncertainty": {
    "status": "confirmed|likely|possible|unknown",
    "reason": "string"
  },
  "evidence": [
    {
      "fragment_id": "string",
      "relationship": "temporal|shared_people|shared_location|semantic_similarity|entity_overlap"
    }
  ],
  "inference_notes": ["string"]
}
```

MongoDB adds reconstruction model/retrieval versions, validation outcome, contradiction evidence, and an append-only review history containing actor, action, timestamp, and before/after snapshots. Member correction values are separately linked to evidence and may be undone; merge writes run transactionally.

## Contract: MomentUpdate

```json
{
  "moment_id": "string",
  "update_type": "create|merge|refine|reject",
  "reasons": ["string"],
  "new_summary": "string|null",
  "confidence": 0.0,
  "evidence_fragment_ids": ["string"],
  "uncertainty": {
    "status": "confirmed|likely|possible|unknown",
    "reason": "string"
  }
}
```

## Contract: StoryCandidate

```json
{
  "story_id": "string|null",
  "group_id": "string",
  "moment_ids": ["string"],
  "title": "string",
  "summary": "string",
  "confidence": 0.0,
  "uncertainty": {
    "status": "confirmed|likely|possible|unknown",
    "reason": "string"
  },
  "evidence": [
    {
      "moment_id": "string",
      "relationship": "shared_people|same_location|recurring_theme|timeline_connection"
    }
  ]
}
```

## Contract: EvidenceLink

```json
{
  "source_fragment_id": "string",
  "target_fragment_id": "string",
  "relationship": "temporal|semantic|people|location|entity|theme",
  "strength": 0.0,
  "explanation": "string"
}
```

## Contract: Uncertainty

```json
{
  "status": "confirmed|likely|possible|unknown",
  "confidence": 0.0,
  "reason": "string",
  "missing_evidence": ["string"],
  "contradictions": ["string"]
}
```

## Contract validation requirements

Any AI-generated contract should satisfy:

- evidence references must point to existing fragment IDs when possible
- confidence must be within a normalized range, e.g. 0.0 to 1.0
- uncertainty status must be explicit
- no invented people, spaces, or events
- contradictions and missing evidence must be captured if relevant

## Responsible usage

These contracts are for internal reasoning and persistence. The user-facing UI can still present a polished narrative, but it should be grounded in the structured evidence behind the contract.

## Current moment-reconstruction gate

The MVP asks Gemma for a summary, a normalized confidence signal, and evidence fragment IDs with relationship types. Before persistence, the server verifies that every ID is in the retrieved group-visible candidate set and that each relationship is supported by the available evidence. The demo has no participant-recognition data, so `shared_people` is rejected; distinct upload authors alone do not prove who was present.

Moment uncertainty is derived by the server, not accepted from Gemma:

- `unknown`: fewer than two distinct cited fragments or fewer than two distinct authors. Do not persist a moment.
- `possible`: at least two distinct cited fragments from at least two authors, but the stronger rule below is not met.
- `likely`: at least three cited fragments from at least two authors, a validated corroborating relationship beyond time alone, and no more than 20 minutes between the earliest and latest evidence.
- `confirmed`: never emitted by the model or this pipeline. Reserve it for an explicit human confirmation flow.

The numeric confidence remains a model/system signal, not a factual probability, and cannot upgrade the deterministic uncertainty label. Invalid IDs or unsupported relationship claims reject the candidate rather than being silently rewritten.

## Phase 5 group memory contract

- Backboard is optional and off until a group owner/admin explicitly enables it.
- Store only a correction a member explicitly shares from a confirmed Moment; never upload raw source text, private fragments, or unconfirmed proposals.
- Read-only lookup may send the bounded summary/entities of an eligible group-visible, AI-consented anchor. Return at most three results, and accept only exact memory content whose provider ID, group, confirmed Moment, correction, and active evidence source all match MongoDB provenance.
- Backboard meanings provide context, not source evidence for a Moment. They cannot create or upgrade event evidence or uncertainty.
- Persist external operation references and status in MongoDB. A pending operation is not a completed memory write.
- Disabling the integration or deleting the group removes the group's assistant and stored memories. Fragment privacy/deletion changes remove linked provider memories before local eligibility changes.

## Phase 3 retrieval state

The current no-vector reranker uses deterministic time, lexical, extracted-entity, and available Moment-link signals, with a maximum of 12 candidate fragments per ContextPacket. Extracted entity phrases are unconfirmed clues, not identity or alias proof. A small synthetic test fixture covers a near-time lexical distractor; selecting an embedding model and demonstrating retrieval gains on a labeled real-fragment set remain open evaluation gates.
