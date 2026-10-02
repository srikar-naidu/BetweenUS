# MVP definition

## Goal

The MVP should prove the project’s core claim: multiple people can upload different fragments of the same real-world moment, the system can connect them, and it can explain why with evidence.

## Required MVP flow

```text
multiple users
      ↓
upload fragments
      ↓
AI understands fragments
      ↓
system finds related fragments
      ↓
Gemma reconstructs candidate moment
      ↓
user sees evidence-backed moment
```

## In-scope MVP functionality

### 1. Group creation and user membership

Users can create or join a group and upload content within that shared space.

### 2. Fragment upload

Users can upload one or more fragments, including photos or screenshots, each with metadata and a timestamp.

### 3. Fragment analysis

The system extracts metadata and creates a basic structured summary for each fragment.

### 4. Candidate retrieval

The system finds temporally nearby and semantically related fragments.

### 5. Moment reconstruction

Gemma evaluates a small candidate set and returns a probable moment candidate with evidence and uncertainty.

### 6. Evidence display

The user can see the moment summary and the fragment evidence supporting the inference.

### 7. Correction capability

The user can reject or correct a reconstructed moment so future memory state improves.

## Explicit non-goals for MVP

The MVP does not include:

- advanced recurring story detection
- long-term retrospective reconstruction at scale
- complex social features
- generic AI chat
- large end-to-end polishing across all discovery features

## Validation criteria for MVP

The MVP should be considered successful only if it can demonstrate:

- two or more users contribute fragments
- fragments from the same event are grouped as a likely moment
- the system explains why the fragments belong together
- uncertainty is preserved when evidence is incomplete
- false merges are rare enough to be acceptable in a small test set

## Minimum test scenario

A small group uploads 8 to 12 fragments from a single event and a few unrelated fragments.

The system should identify the likely shared moment, produce a summary, show evidence, and avoid inventing details.

## Hard requirement

The product must feel like memory reconstruction rather than data dumping. The user should not read a raw AI dump; they should see a concise, credible inference with a clear connection to the underlying evidence.
