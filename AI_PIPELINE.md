# AI pipeline design

## Goal

The AI pipeline should turn a single incoming fragment into a meaningful candidate moment while minimizing cost, latency, and hallucination risk.

The system should use deterministic filtering and retrieval first, and only then invoke Gemma on a compact Context Packet.

## High-level flow

```text
UPLOAD
  ↓
INGEST
  ↓
EXTRACT
  ↓
EMBED
  ↓
RETRIEVE CANDIDATES
  ↓
CLUSTER / COMPARE
  ↓
GEMMA REASONING
  ↓
MOMENT CANDIDATE
  ↓
EVIDENCE VALIDATION
  ↓
STORE
  ↓
SURFACE TO USER
```

## 1. Ingestion

When a fragment arrives, the system should record:

- user and group ownership
- timestamp
- media metadata
- source type
- visibility rules
- processing job status

The ingestion layer should avoid doing expensive AI work immediately for every fragment. The system should capture the raw data and then queue incremental analysis.

## 2. Multimodal analysis

For supported media, the system should extract:

- visible faces or people references
- objects and locations
- scene type
- text present in the image or screenshot
- activities or motion cues
- likely timestamps or metadata context

Not all fragments require full multimodal reasoning. The system should attempt to extract only the fields needed for candidate grouping.

## 3. Semantic extraction

Each fragment should generate a structured semantic summary such as:

- people: [A, B, C]
- location: cafeteria
- activity: eating or waiting
- objects: table, food, phone
- tone: playful, tense, chaotic
- known references: bunker, nickname, recurring joke

These are AI observations, not unquestionable facts.

## 4. Embeddings

Embeddings should be generated selectively for retrieval, not blindly for every object.

Priority candidates for embedding:

- fragment semantic summaries
- moment summaries
- story summaries
- relevant textual observations

The exact embedding model should be documented and chosen based on:

- local availability
- latency
- dimensionality
- compatibility with Tiger Data
- retrieval quality

If multimodal embeddings are available locally and useful, they can be evaluated. If not, text-derived representations are an acceptable baseline.

## 5. Retrieval

Candidate retrieval should happen before Gemma reasoning.

### Temporal retrieval

Search nearby time ranges around the fragment, such as:

- ±10 minutes for short-lived events
- ±1 hour for longer social gatherings
- wider period if there is weak evidence or repeated patterns

### Semantic retrieval

Retrieve fragments that are similar in meaning or content.

### Relationship retrieval

Prefer fragments involving:

- same people
- same location
- same entity
- same shared reference or nickname
- known group memory context

## 6. Candidate ranking

Fragments should be ranked using a mixture of signals:

- temporal proximity
- semantic similarity
- shared people
- shared location
- shared entities
- known relationship knowledge
- existing moment linkage

The result is a small candidate set. This reduces model cost and improves accuracy.

## 7. Context assembly

The system should build a compact Context Packet that includes only the minimum relevant information required for the current task.

This packet should include:

- task type
- group ID
- time window
- group members
- candidate fragments
- relevant memories
- constraints and uncertainty rules

The point is to give Gemma a narrowly scoped decision space rather than a database dump.

## 8. Gemma inference

The model should reason over the Context Packet and produce a structured output. The prompt should instruct the model to:

- be evidence-based
- mention uncertainty explicitly
- not invent people, places, or relationships
- cite source fragment IDs internally
- return only outputs supported by the evidence

## 9. Structured outputs

The AI should prefer structured JSON over free-form text for internal processing. Examples:

- FragmentAnalysis
- MomentCandidate
- MomentUpdate
- StoryCandidate
- EvidenceLink
- Uncertainty

This makes validation, persistence, and UI display easier and more reliable.

## 10. Evidence validation

Every AI-generated conclusion should be tied back to source fragments. The system should validate:

- evidence existence
- fragment ownership
- group relevance
- temporal plausibility
- contradiction handling

If the evidence is thin, the system should prefer “not enough evidence” over a narrative story.

## 11. Persistence

Structured results should be stored in MongoDB and associated with the relevant fragments, moment, or story record.

Persisted outputs may include:

- AI observation summaries
- confidence score
- evidence references
- uncertainty label
- relationship explanations

## 12. Incremental processing

The system should avoid expensive full-history analysis for every upload.

### Real-time path

- understand new fragment
- search nearby candidates
- compare against likely moment contexts
- update or create a candidate moment

### Periodic path

- re-evaluate related moments over longer windows
- look for recurring stories or connections
- refine event clusters

### Long-term path

- retrospective pattern detection
- forgotten-connections discovery
- recurring story surfaces

This keeps the system efficient and allows the AI work to scale with real use.

## Current runnable demo slice

The Next.js demo route seeds one synthetic group with four group-visible fragments across photo, screenshot, video, and text types. It filters a 40-minute window around an anchor fragment, ranks candidates using the time window and a lexical term, sends only those candidates to local Gemma, validates that returned evidence IDs came from the candidate set, requires evidence from at least two fragments and two authors, and stores a candidate moment.

The display label is derived from evidence count and distinct authors; the numeric confidence remains the model/system confidence estimate and is not factual probability. Without database environment variables, the route uses an in-memory demo store. When both `MONGODB_URI` and `TIGER_DATABASE_URL` are set, it writes canonical records to MongoDB and retrieves candidates through Tiger Data. Apply `migrations/tiger/001_fragment_search.sql` first. The demo route is development-only unless explicitly enabled with `ENABLE_DEMO_PIPELINE=true`.
