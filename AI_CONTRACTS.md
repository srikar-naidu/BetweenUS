# AI contracts

This project should use structured contracts internally instead of free-form narrative generation whenever possible. The goal is to make AI outputs inspectable, validatable, and easy to persist.

## Core design principle

The system should prefer JSON contracts that can be validated before storing or showing them to the user.

## Contract: FragmentAnalysis

```json
{
  "fragment_id": "string",
  "analysis_version": "string",
  "observed_facts": [
    {
      "type": "person|place|object|activity|tone|reference",
      "value": "string",
      "confidence": 0.0,
      "source": "metadata|vision|text|classification"
    }
  ],
  "people": ["string"],
  "entities": ["string"],
  "location_hint": "string|null",
  "activity_hint": "string|null",
  "tone_hint": "string|null",
  "confidence": 0.0,
  "uncertainty": {
    "status": "confirmed|likely|possible|unknown",
    "reason": "string"
  },
  "evidence_fragment_ids": ["string"]
}
```

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
