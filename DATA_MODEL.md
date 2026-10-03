# Data model

This document defines the initial schema model for the MVP. It is intentionally simple and designed to support private group memory reconstruction without over-engineering the first build.

## Entity overview

The core entities are:

- User
- Group
- GroupMember
- Fragment
- Moment
- Story
- Entity
- AIObservation
- Permission
- ProcessingJob

## User

```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "picture_url": "string|null",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

Responsibilities:

- identity and profile
- group membership ownership
- authentication or account linkage

## Group

```json
{
  "id": "string",
  "name": "string",
  "description": "string|null",
  "created_by_user_id": "string",
  "backboard_assistant_id": "string|null",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

Responsibilities:

- logical boundary for a private shared memory space
- contains group members and moments

## GroupMember

```json
{
  "id": "string",
  "group_id": "string",
  "user_id": "string",
  "role": "member|admin",
  "joined_at": "datetime",
  "status": "active|removed",
  "permissions": ["string"]
}
```

Responsibilities:

- membership state
- permission snapshot per group
- authorization boundaries

## Fragment

```json
{
  "id": "string",
  "group_id": "string",
  "author_user_id": "string",
  "type": "image|video|text|screenshot|voice|location|other",
  "storage_uri": "string",
  "media_url": "string|null",
  "caption": "string|null",
  "timestamp": "datetime",
  "created_at": "datetime",
  "metadata": {
    "width": 0,
    "height": 0,
    "duration_seconds": 0,
    "location": null,
    "mime_type": "string"
  },
  "visibility": "private|group|restricted",
  "status": "uploaded|processing|processed|rejected",
  "processing_job_id": "string|null"
}
```

Responsibilities:

- raw user-uploaded content
- canonical source evidence object
- ownership and visibility handling

## Moment

```json
{
  "id": "string",
  "group_id": "string",
  "title": "string|null",
  "summary": "string",
  "confidence": 0.0,
  "uncertainty_label": "confirmed|likely|possible|unknown",
  "uncertainty_reason": "string",
  "start_time": "datetime",
  "end_time": "datetime",
  "status": "draft|candidate|confirmed|rejected",
  "created_at": "datetime",
  "updated_at": "datetime",
  "evidence_fragment_ids": ["string"],
  "source_summary": "string"
}
```

Responsibilities:

- reconstructed real-world event
- holds evidence-backed interpretation
- primary object of interaction

## Story

```json
{
  "id": "string",
  "group_id": "string",
  "title": "string",
  "summary": "string",
  "confidence": 0.0,
  "uncertainty_label": "confirmed|likely|possible|unknown",
  "start_time": "datetime|null",
  "end_time": "datetime|null",
  "moment_ids": ["string"],
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

Responsibilities:

- recurring pattern across multiple moments
- higher-level episodic memory

## Entity

```json
{
  "id": "string",
  "group_id": "string",
  "name": "string",
  "type": "person|place|object|event|nickname|alias",
  "confidence": 0.0,
  "source_fragment_ids": ["string"],
  "created_at": "datetime"
}
```

Responsibilities:

- people, places, recurring references, and other named entities
- supports matching across fragments

## AIObservation

```json
{
  "id": "string",
  "group_id": "string",
  "fragment_id": "string|null",
  "moment_id": "string|null",
  "story_id": "string|null",
  "model_version": "string",
  "observation_type": "semantic_summary|person_reference|event_cluster|story_pattern|correction",
  "content": {
    "key": "value"
  },
  "confidence": 0.0,
  "uncertainty_label": "confirmed|likely|possible|unknown",
  "evidence_fragment_ids": ["string"],
  "created_at": "datetime"
}
```

Responsibilities:

- structured AI output storage
- preserves evidence and traceability
- allows caching and validation

## Permission

```json
{
  "id": "string",
  "group_id": "string",
  "subject_user_id": "string",
  "object_type": "fragment|moment|story|group",
  "object_id": "string",
  "permission": "view|edit|delete|share|ai_use",
  "granted_by_user_id": "string",
  "granted_at": "datetime"
}
```

Responsibilities:

- allowlists and role boundaries
- explicit visibility controls

## ProcessingJob

```json
{
  "id": "string",
  "group_id": "string",
  "fragment_id": "string|null",
  "job_type": "ingest|analyze|retrieve_candidates|reconstruct_moment|story_discovery",
  "status": "queued|running|succeeded|failed|retrying",
  "attempt_count": 0,
  "input_ref": "string|null",
  "output_ref": "string|null",
  "error_message": "string|null",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

Responsibilities:

- asynchronous processing tracking
- retry and idempotency context
- operational accountability for expensive AI tasks

## Relationships and ownership

### Ownership

- User owns their personal profile and uploads
- Group owns shared memory state
- Fragment belongs to a group and an author
- Moment belongs to a group
- Story belongs to a group
- AIObservation belongs to the relevant entity or group context
- Permission is scoped by group, user, and object

### Relationships

- User -> GroupMember -> Group
- Group -> many Fragments
- Group -> many Moments
- Group -> many Stories
- Fragment -> many AIObservation records
- Moment -> many Evidence references
- Story -> many Moment references
- Entity -> many source fragments

## Design note

The schema should remain intentionally narrow. It should support essential memory reconstruction and privacy without baking in unnecessary social features before the product has proven its core value.

## Runtime mapping

The Node.js implementation uses TypeScript camelCase fields and stores the domain `id` as MongoDB `_id`. MongoDB remains canonical for fragments and moments. Tiger Data stores only a derived retrieval projection for group-visible fragments: group ID, fragment ID, capture time, semantic summary, and entity keys. It does not own the raw fragment, permissions, or moment records.

The initial Tiger retrieval path filters by group and time, optionally applies lexical matching, and orders candidates by distance from the window midpoint. Vector search is intentionally not implemented until an embedding model and dimensionality are selected. Private and restricted fragments must not be written to the group retrieval index.
