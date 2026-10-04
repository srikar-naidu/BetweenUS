# MVP definition

## Goal

The MVP should prove the project’s core claim: multiple people can contribute different text fragments about the same real-world moment, the system can connect them, and it can explain why with evidence.

## Required MVP flow

```text
multiple users
      ↓
contribute text fragments
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

### 1. Authentication, groups, and permissions

Users sign in through Better Auth with Google OAuth, then create or join private groups through the organization/membership model. Invitations are email-bound and require a verified matching account. Server-side authorization applies to text-fragment creation, candidate retrieval, moments, evidence, corrections, and deletion.

### 2. Text fragment entry

Users can create text fragments with metadata and a timestamp. Media upload and retrieval are disabled. New fragments default to private with AI processing disabled; changing visibility or granting AI consent is an author-only operation.

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

### 8. Confirmed group memory

Member-confirmed aliases and corrections may be mirrored into a group-scoped Backboard assistant. MongoDB remains canonical and stores memory provenance; Backboard never receives raw/private fragments or speculative candidate narratives.

### 9. Optional voice notes

Voice notes may be transcribed through ElevenLabs only after the author opts in, the privacy/retention review passes, and a credit cap is configured. The author reviews the transcript before group use. Voice processing remains disabled.

### 10. Tinker experiment

After collecting a baseline evaluation set, run one bounded, de-identified model-specialization experiment with Tinker if the account and model catalog support it. Report the result; do not make Tinker a production inference dependency unless it beats the baseline and passes privacy, quality, compatibility, and budget gates.

### 11. Durable processing and pilot monitoring

Use Temporal for the multi-step processing workflow and retries, with MongoDB retaining canonical job status. Use Sentry for staging/pilot failures and latency only after disabling request bodies, AI content, media, user identity, stack locals, and replay capture.

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

A small group contributes 8 to 12 text fragments from a single event and a few unrelated fragments.

The system should identify the likely shared moment, produce a summary, show evidence, and avoid inventing details.

## Current demo implementation

The local demo implements a synthetic group with four fragments, temporal/lexical candidate retrieval, a structured Ollama/Gemma call, evidence-ID validation, and candidate moment persistence. It demonstrates the pipeline shape only; it does not replace evaluation on a labeled dataset.

The complete implementation sequence, UI direction, provider gates, and acceptance criteria for the final MVP are defined in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Hard requirement

The product must feel like memory reconstruction rather than data dumping. The user should not read a raw AI dump; they should see a concise, credible inference with a clear connection to the underlying evidence.
