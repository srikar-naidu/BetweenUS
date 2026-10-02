# Context engineering

## Principle

The central design requirement is:

> Maximum useful context with minimum unnecessary context.

Gemma should never receive the whole database, all memories, or broad historical context without a task-specific reason.

## What Gemma receives

Gemma receives a compact Context Packet created specifically for the current task.

A representative packet contains:

- task type, such as reconstruct_possible_moment
- group_id
- time window
- group member context
- candidate fragments
- relevant memory summaries
- constraints and uncertainty rules

Example:

```json
{
  "task": "reconstruct_possible_moment",
  "group_id": "group_123",
  "time_window": {
    "start": "2026-09-04T11:50:00Z",
    "end": "2026-09-04T12:30:00Z"
  },
  "known_group_context": {
    "members": [
      { "id": "u1", "display_name": "A" },
      { "id": "u2", "display_name": "B" }
    ]
  },
  "candidate_fragments": [
    {
      "id": "f123",
      "timestamp": "2026-09-04T12:04:00Z",
      "author_id": "u1",
      "type": "image",
      "caption": "...",
      "semantic_summary": "...",
      "similarity_score": 0.91
    }
  ],
  "relevant_memories": [
    {
      "memory": "Recurring cafeteria joke and group travel dynamic",
      "confidence": 0.87
    }
  ],
  "constraints": [
    "Do not infer an event unless supported by evidence.",
    "Return uncertainty explicitly."
  ]
}
```

## What Gemma does not receive

Gemma should not be sent:

- the full MongoDB database
- all historical fragments
- all embeddings
- all previous chat history
- all Backboard memory records
- unrelated group contexts
- long global event histories unrelated to the current task

This is inefficient, expensive, and reduces the chance of coherent reasoning on irrelevant material.

## Retrieval strategy

The model should operate after retrieval, not before.

### 1. Temporal filtering

The system should first use time windows to filter nearby fragments. The time window should be dynamic and based on the type of event being considered.

Examples:

- short-lived incident: around 15 to 30 minutes
- social outing: around 1 to 3 hours
- recurring story discovery: longer historical ranges

### 2. Semantic retrieval

The system should find fragments that are semantically related through their extracted metadata, text, or observations.

### 3. Relationship filtering

Candidates should be weighted by:

- shared people
- shared location
- shared entity or object
- known group-specific references
- known timeline relationships

### 4. Ranking

Ranking should combine:

- temporal proximity
- semantic similarity
- shared participants
- shared location
- same event-like objects or references
- existing moment relationships

This should populate a short candidate set that is small enough to fit within the model’s context budget.

## Token and latency considerations

The project must aim for a narrow reasoning loop:

- cheap deterministic filtering
- retrieval-based narrowing
- small candidate set
- one focused Gemma call

This is preferred over sending broad histories or all uploaded media to the model.

The design should minimize:

- prompt bloat
- repeated long contexts
- redundant model calls
- re-analyzing unchanged media

## Caching strategy

Stable AI outputs should be cached to avoid reprocessing.

Examples:

- fragment semantic summaries
- extracted entity observations
- clustering decisions for unchanged candidate sets
- moment-level summaries for stable states

Cache invalidation should happen when:

- fragment contents change
- model version changes
- retrieval configuration changes
- evidence or interpretation rules change

## Memory strategy

Memory must be layered:

### Level 1 — raw memory

The uploaded fragment itself is application data.

### Level 2 — semantic memory

Extracted observations from a fragment, including likely people, location, activity, and tone.

### Level 3 — episodic / group memory

Higher-level events or recurring stories that are reconstructed from multiple fragments.

Backboard should store only the high-value, durable memory layer; it should not duplicate raw media or exhaustive fragment history.

## Hallucination prevention

Gemma must operate under strict anti-hallucination rules:

1. Never invent a person.
2. Never invent an event.
3. Never invent a location.
4. Never invent a relationship.
5. Never convert an assumption into a fact.
6. Never infer private information unnecessarily.
7. Always distinguish observed facts from interpretations.
8. Cite source fragments internally.
9. Prefer “unknown” over guessing.
10. Never create a narrative that contradicts source evidence.

The system should encode these as model constraints in the Context Packet and in structured validation after the result is returned.

## Decision principle

A good Context Packet should answer only one question clearly: “Given this small body of evidence, what is the most defensible conclusion we can make right now?”
