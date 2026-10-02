# Between Us

## Project Specification & Build Instructions

> **IMPORTANT: Read this entire document before writing application code.**
>
> This document is the source of truth for the first stage of the project.
>
> **Your first task is NOT to build the application.**
>
> Your first task is to create a set of clear `.md` project documents that turn this specification into an implementable engineering plan.
>
> Only after those documents are created and reviewed should implementation begin.

---

# 1. Product

## Working name

**Between Us**

## One-line description

> A private shared memory system that reconstructs the moments a group of friends experienced together from the tiny fragments they independently captured.

---

# 2. The problem

Existing shared-photo products primarily answer:

> “What did my friends post?”

Between Us should answer a different question:

> **“What actually happened between all these fragments?”**

Friends rarely document an event completely.

One person takes a photo.

Another sends a screenshot.

Someone else records a three-second video.

Someone writes:

> “bro 💀”

Another person takes a photo 10 minutes later.

These fragments may all belong to the same real-world event, but nobody explicitly records the complete story.

Between Us should discover those relationships.

---

# 3. The core product distinction

Do NOT build:

* a photo album
* a photo-sharing social network
* a generic AI companion
* an AI photo caption generator
* a generic AI slideshow maker
* a semester recap clone
* a social feed with AI added
* a “chat with your memories” wrapper
* a normal gallery with semantic search

The central product abstraction is:

> **Fragment → Moment → Story**

### Fragment

A single piece of captured information:

* photograph
* video
* screenshot
* text
* optional voice note
* optional location
* timestamp
* caption
* other supported media

### Moment

A real-world event reconstructed from multiple fragments.

Example:

```text
12:04 — Person A uploads cafeteria photo
12:07 — Person B uploads photo of Person C asleep
12:11 — Person C uploads screenshot
12:16 — Person D uploads short video

              ↓

        ONE RECONSTRUCTED MOMENT
```

### Story

A larger pattern formed by multiple moments over time.

Example:

```text
September 4  → cafeteria incident
September 19 → same people + same location
October 2    → inside joke appears again
October 17   → another related event
November     → someone references the original incident
```

The system may eventually identify this as a recurring group story.

---

# 4. Product thesis

The emotional payoff should NOT be:

> “Here is your AI-generated recap.”

The emotional payoff should be:

> **“You forgot this happened.”**

Examples:

### Example 1 — reconstructed event

> We found 5 uploads from four people between 12:04 and 12:17 PM.
>
> They appear to describe the same event.
>
> Nobody uploaded a complete record of it.
>
> **Here's what happened.**

### Example 2 — forgotten connection

> Three people independently photographed the same place on September 14.
>
> None of the uploads mentioned the other people.
>
> They appear to belong to the same afternoon.

### Example 3 — recurring story

> This joke first appeared in September.
>
> It resurfaced in six separate moments over the next two months.
>
> You may not have realized it became one of your group's recurring stories.

The system must distinguish **evidence-backed discoveries** from speculation.

Never invent events.

---

# 5. What makes this different from Retro

Retro-like products focus on capturing and sharing memories.

Between Us should focus on:

## Retro-style behavior

```text
capture
   ↓
share
   ↓
look back
```

## Between Us behavior

```text
capture fragments
       ↓
understand fragments
       ↓
find relationships
       ↓
reconstruct moments
       ↓
connect moments across time
       ↓
surface forgotten stories
```

The product must therefore treat the **moment/event** as the primary object, not the photograph.

---

# 6. Important product principles

## 6.1 AI must be necessary

If a feature can be implemented as ordinary CRUD, do not call it AI.

AI should be responsible for things such as:

* semantic understanding
* cross-fragment relationships
* event clustering
* entity/people references
* contextual interpretation
* story reconstruction
* discovering recurring patterns
* generating evidence-backed explanations

---

## 6.2 Evidence before narrative

Every AI-generated conclusion must be traceable to source fragments.

For example:

```json
{
  "claim": "The group left the cafeteria together",
  "confidence": 0.82,
  "evidence": [
    "fragment_123",
    "fragment_127",
    "fragment_131"
  ]
}
```

The UI should eventually allow the user to inspect the underlying evidence.

---

## 6.3 Never hallucinate memories

The AI must never turn uncertainty into fact.

Bad:

> “You all went to the beach on Friday.”

when the evidence only suggests that possibility.

Good:

> “These fragments may be from the same beach trip. We found three uploads from different members within 18 minutes, but we don't have enough evidence to confirm that they were together.”

Use explicit uncertainty.

---

## 6.4 Respect privacy

This is a private group memory product.

The system must have clear boundaries around:

* group membership
* media ownership
* who can see what
* AI-generated interpretations
* deletion
* consent
* private uploads
* evidence visibility

Do not make someone's private upload automatically visible to the group merely because the AI thinks it belongs to a shared event.

---

# 7. Core architecture

The initial required technology stack is intentionally small.

## Required now

### 1. Gemma

Core local AI reasoning/model layer.

### 2. Backboard

Persistent AI memory/context layer.

### 3. MongoDB Atlas

Canonical application database.

### 4. Tiger Data

Temporal/event-oriented retrieval and vector search layer.

### 5. Tinker

Potential model specialization/fine-tuning layer, but only when we identify a concrete training problem.

### 6. Render

Application deployment.

### 7. GitHub Copilot

Development assistance.

---

# 8. Optional technologies

DO NOT add these during the initial implementation unless a real requirement appears:

* TabPFN
* Entire
* Mastra
* Sentry
* Temporal
* SerpApi
* DigitalOcean
* ElevenLabs
* Arduino

Do not add a partner merely to increase the partner count.

Every technology must have a defensible engineering reason.

---

# 9. Technology responsibilities

## Gemma

Gemma is the central AI layer.

Use it for:

* multimodal fragment understanding where supported
* extracting structured observations from media
* identifying possible people/entities
* identifying semantic relationships
* candidate event clustering
* generating moment descriptions
* generating evidence-backed story explanations
* uncertainty estimation
* natural-language interaction with memories

Do not use Gemma simply to generate captions.

The AI should operate primarily on **structured candidate context**, not the entire database.

---

# 10. Gemma context architecture — VERY IMPORTANT

## Never do this

Do NOT send:

```text
entire MongoDB database
+
all Backboard memories
+
all historical fragments
+
all embeddings
+
all previous conversations
```

to Gemma.

That is inefficient, expensive, slow, and unnecessary.

---

# 11. Context should be assembled dynamically

Gemma should receive a small **Context Packet** created specifically for the task.

The pipeline should look approximately like:

```text
User action / background job
          ↓
Determine task
          ↓
Retrieve candidate fragments
          ↓
Temporal filtering
          ↓
Semantic retrieval
          ↓
Relationship filtering
          ↓
Rank candidates
          ↓
Build compact Context Packet
          ↓
Gemma
          ↓
Structured result
          ↓
Persist result
```

---

# 12. Context Packet

Create a formal internal representation called something like:

`ContextPacket`

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
      {
        "id": "u1",
        "display_name": "A"
      },
      {
        "id": "u2",
        "display_name": "B"
      }
    ]
  },

  "candidate_fragments": [
    {
      "id": "f123",
      "timestamp": "...",
      "author_id": "u1",
      "type": "image",
      "caption": "...",
      "semantic_summary": "...",
      "similarity_score": 0.91
    }
  ],

  "relevant_memories": [
    {
      "memory": "...",
      "confidence": 0.87
    }
  ],

  "constraints": [
    "Do not infer an event unless supported by evidence.",
    "Return uncertainty explicitly."
  ]
}
```

The exact schema can evolve.

The important principle is:

> **Gemma receives only the context needed for the current reasoning task.**

---

# 13. Retrieval should happen BEFORE Gemma

For example, if a new fragment arrives at:

```text
12:11 PM
```

do not ask Gemma to inspect every memory from the semester.

Instead:

### Stage 1 — temporal candidate retrieval

Search nearby time ranges:

```text
11:45 AM → 12:40 PM
```

Adjust the window dynamically depending on media/event type.

### Stage 2 — semantic retrieval

Find fragments that are semantically similar.

### Stage 3 — group/person relationships

Prefer fragments involving:

* the same people
* the same location
* related entities
* known group memories

### Stage 4 — ranking

Rank candidate fragments based on:

```text
temporal proximity
+
semantic similarity
+
shared people
+
shared location
+
shared entities
+
existing moment relationships
```

### Stage 5 — Gemma

Only now send the best candidates to Gemma.

---

# 14. Why Tiger Data is important

Tiger Data should handle the temporal/vector retrieval problem.

The project needs to search things such as:

> “What semantically related things happened around this time?”

and:

> “Find older memories related to this moment, but prioritize nearby periods.”

Use the time dimension as a first-class retrieval signal.

Do not treat all historical memories equally.

The temporal dimension is part of the meaning.

Tiger Data supports PostgreSQL/vector approaches and time-based vector retrieval, making it a natural place to experiment with this hybrid retrieval layer.

---

# 15. MongoDB responsibility

MongoDB Atlas should be the canonical application database.

Potential collections:

```text
users
groups
group_members
fragments
moments
stories
entities
permissions
processing_jobs
ai_observations
```

MongoDB should contain canonical application state.

Do not create unnecessary duplication between databases.

Clearly document which system owns each piece of information.

---

# 16. Backboard responsibility

Backboard should represent persistent AI memory.

Do not dump every photo into Backboard memory.

That would defeat the purpose.

Backboard should contain useful high-level group context such as:

```text
People
relationships
inside jokes
recurring references
stable group terminology
known event aliases
AI interaction context
confirmed user corrections
```

Use memory retrieval only when it is relevant to the current task.

Backboard's persistent memory and semantic retrieval should complement, not replace, the application's own databases.

---

# 17. Three levels of memory

Design the system around:

## Level 1 — Raw memory

The actual uploaded fragment.

```text
photo
video
screenshot
text
```

Stored as application data.

---

## Level 2 — Semantic memory

What the system believes the fragment contains.

Example:

```text
people: [A, B]
location: cafeteria
objects: food, table
activity: eating
tone: humorous
```

These are AI observations, not unquestionable facts.

---

## Level 3 — Episodic/group memory

Higher-level things the group repeatedly experienced.

Example:

```text
Event:
"The cafeteria escape"

Participants:
A, B, C, D

Evidence:
f123, f127, f131

Confidence:
0.84
```

This hierarchy is central to the architecture.

---

# 18. The most important AI pipeline

Implement conceptually:

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

Do not make every upload trigger an expensive full-history analysis.

Use incremental processing.

---

# 19. Incremental intelligence

When a new fragment arrives:

```text
new fragment
     ↓
understand fragment
     ↓
find nearby candidates
     ↓
compare against candidate moments
     ↓
update existing moment OR create candidate moment
```

Only periodically perform deeper analysis across longer time ranges.

For example:

```text
real-time:
fragment → candidate moment

periodic:
moments → recurring story

long-term:
stories → forgotten connections / retrospective
```

This keeps the system efficient.

---

# 20. A powerful additional feature: “You Forgot This”

The system should eventually have a discovery mechanism.

Examples:

### Forgotten moment

> **You forgot this.**
>
> Four members independently captured this event within 15 minutes.

### Hidden connection

> **We found a connection.**
>
> These two moments happened three weeks apart but share three people and the same recurring reference.

### Recurring story

> **This became a thing.**
>
> The same joke appears across seven moments over two months.

### Missing perspective

> **Three people captured the same moment differently.**
>
> Here's how the fragments fit together.

This should be one of the signature product experiences.

---

# 21. Another unique feature: multiple perspectives

Do not simply merge everything into one AI-written story.

Preserve the fact that different people experienced the moment differently.

Example:

```text
THE NIGHT OUT

A's perspective:
"Everyone was trying to find the restaurant."

B's perspective:
"I thought we were already there."

C's perspective:
"Nobody knew where the entrance was."

Evidence:
photo A
video B
message C
photo D
```

This can make the system feel much more like **collective memory reconstruction** rather than automated journaling.

---

# 22. Another unique feature: “what nobody captured”

The AI should be allowed to identify gaps.

For example:

> “We have evidence that something happened between these two fragments, but no direct capture of that part.”

Never fill the gap with hallucinated content.

Instead:

> **“There seems to be a missing part of this story.”**

This is potentially a very distinctive product behavior.

---

# 23. Another unique feature: corrections become memory

Users should be able to say:

> “No, that happened on Thursday.”

or:

> “That's not Rahul, that's Arjun.”

or:

> “We call this place the bunker.”

The correction should update the appropriate memory/state.

This is where persistent AI memory becomes genuinely useful.

---

# 24. Tinker

Do not integrate Tinker just because it is required by the challenge.

First build a baseline system using Gemma.

Then collect examples of:

```text
fragment set
→ expected moment grouping
```

and:

```text
evidence
→ desired reconstruction
```

If we discover a consistent model weakness and Tinker's currently supported models/training workflow are compatible, use Tinker to specialize the relevant behavior.

Document:

* baseline behavior
* failure cases
* training dataset
* specialization approach
* evaluation
* improvement

If no meaningful Tinker use case exists, do not fake one.

---

# 25. Render

Use Render for deployment.

Keep deployment simple.

The initial deployment should ideally contain:

```text
frontend
backend/API
background processing worker
```

Only add more services if necessary.

---

# 26. GitHub Copilot

Use GitHub Copilot as a development aid.

Document meaningful usage such as:

* scaffolding
* tests
* API implementation
* database code
* refactoring
* debugging
* repetitive UI implementation

Do not present Copilot as part of the runtime architecture.

---

# 27. First-stage documentation task

## DO NOT WRITE APPLICATION CODE YET.

Before implementation, create these Markdown files.

### `README.md`

Explain:

* what Between Us is
* the problem
* why it differs from ordinary shared albums
* core user experience
* architecture overview
* setup overview

---

### `PRODUCT.md`

Document:

* product thesis
* target user
* core loop
* Fragment → Moment → Story model
* major user flows
* privacy expectations
* anti-features
* differentiation from Retro-like products

---

### `ARCHITECTURE.md`

Document:

* frontend
* backend
* Gemma
* Backboard
* MongoDB
* Tiger Data
* Render
* Tinker
* data flow
* service responsibilities
* ownership of data
* failure boundaries

Include at least one architecture diagram using Mermaid.

---

### `AI_PIPELINE.md`

Document:

* ingestion
* multimodal analysis
* semantic extraction
* embeddings
* retrieval
* context assembly
* Gemma inference
* structured outputs
* validation
* persistence
* incremental processing

---

### `CONTEXT_ENGINEERING.md`

This is especially important.

Document exactly:

* what context Gemma receives
* what context Gemma does NOT receive
* retrieval strategy
* temporal filtering
* semantic retrieval
* ranking
* context packet structure
* token/latency considerations
* caching strategy
* memory strategy
* hallucination prevention

The goal is:

> **Maximum useful context with minimum unnecessary context.**

---

### `DATA_MODEL.md`

Define initial schemas for:

```text
User
Group
GroupMember
Fragment
Moment
Story
Entity
AIObservation
Permission
ProcessingJob
```

Include relationships and ownership.

---

### `AI_CONTRACTS.md`

Define structured input/output contracts for Gemma.

For example:

```text
FragmentAnalysis
MomentCandidate
MomentUpdate
StoryCandidate
EvidenceLink
Uncertainty
```

Prefer structured JSON outputs over free-form text internally.

---

### `PRIVACY.md`

Define:

* group isolation
* media visibility
* AI processing boundaries
* deletion
* ownership
* consent
* private fragments
* evidence access

---

### `MVP.md`

Define the smallest genuinely working product.

The MVP must prove:

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

Do NOT attempt every future feature.

---

### `ROADMAP.md`

Separate:

```text
MVP
V1
V2
experimental
```

Optional partner technologies should be placed here rather than automatically added to MVP.

---

### `DECISIONS.md`

Record important architecture decisions.

Use an ADR-like format:

```text
Decision
Context
Options considered
Chosen approach
Reason
Trade-offs
```

---

# 28. Documentation-first workflow

Follow this order exactly.

```text
1. Inspect repository
2. Inspect available environment/tools
3. Inspect local Gemma installation/runtime
4. Inspect existing files
5. Create planning Markdown files
6. Cross-check architecture for contradictions
7. Identify unknowns
8. Ask only essential questions
9. Freeze MVP scope
10. THEN begin implementation
```

Do not silently invent APIs for Gemma, Backboard, MongoDB, Tiger Data, Tinker, or Render.

Before implementing integrations, consult current official documentation for the relevant service/API.

---

# 29. Gemma local-runtime requirement

Gemma is already installed locally by the developer.

The implementation must first determine:

* how the local model is being served
* whether it is Ollama, llama.cpp, LM Studio, another local runtime, or another endpoint
* what API endpoint is available
* what multimodal capabilities are exposed
* what context length is exposed
* whether structured JSON output is supported
* whether image input is supported
* whether batching is supported

Do not assume these details.

Create a small adapter:

```text
GemmaProvider
```

so the rest of the application does not depend directly on one runtime.

Example conceptual interface:

```text
analyzeFragment(...)
analyzeCandidates(...)
reconstructMoment(...)
generateStory(...)
```

The implementation may differ depending on the local runtime.

---

# 30. Efficiency requirements

This project should be designed for local AI first.

Avoid unnecessary model calls.

Prefer:

```text
cheap deterministic filtering
        ↓
retrieval
        ↓
small candidate set
        ↓
one focused Gemma call
```

over:

```text
send everything to Gemma
```

Do not repeatedly send the same large context.

Cache stable AI observations.

Store structured intermediate results.

Do not re-analyze unchanged media unless the pipeline/model version changes.

---

# 31. Embedding strategy

Embeddings should be generated for retrieval, not blindly for every possible object.

Consider embeddings for:

* fragment semantic summaries
* moment summaries
* story summaries
* relevant textual observations

If multimodal embeddings are supported by the selected local/cloud embedding system, evaluate them.

Otherwise use text representations derived from the media.

The exact embedding model must be documented and chosen based on:

* local availability
* cost
* latency
* dimensionality
* retrieval quality
* compatibility with Tiger Data

Do not introduce a paid embedding API merely for convenience without documenting the trade-off.

---

# 32. Evidence model

Every AI-derived object should maintain evidence.

Example:

```json
{
  "moment_id": "m_123",

  "summary": "The group left the cafeteria together.",

  "confidence": 0.84,

  "evidence": [
    {
      "fragment_id": "f1",
      "relationship": "temporal"
    },
    {
      "fragment_id": "f2",
      "relationship": "shared_people"
    },
    {
      "fragment_id": "f3",
      "relationship": "semantic_similarity"
    }
  ]
}
```

This enables explainability.

The UI should eventually let users answer:

> “Why does the AI think these belong together?”

---

# 33. Confidence is not truth

Do not treat:

```text
confidence: 0.91
```

as:

> “91% factual.”

It represents model/system confidence in the inference.

Keep the distinction explicit.

Where appropriate, expose human-readable uncertainty:

```text
Confirmed
Likely
Possible
Unknown
```

These labels must be tied to defined evidence rules rather than arbitrary model output.

---

# 34. Anti-hallucination rules

Gemma must follow these principles:

1. Never invent a person.
2. Never invent an event.
3. Never invent a location.
4. Never invent a relationship.
5. Never convert an assumption into a fact.
6. Never infer private information unnecessarily.
7. Always distinguish observed facts from interpretations.
8. Cite source fragments internally.
9. Prefer saying “unknown” over making something up.
10. Never create a narrative that contradicts source evidence.

---

# 35. Evaluation

Before calling the MVP successful, create a small evaluation dataset.

Example:

```text
10 fragments
5 actually belong to one event
5 belong to unrelated events
```

Test:

* clustering accuracy
* false merges
* missed relationships
* hallucinated relationships
* evidence correctness
* latency
* number of Gemma calls
* context size

Also test difficult cases:

### Case A

Two unrelated events happen at the same location.

### Case B

The same people appear in two unrelated events.

### Case C

A fragment has misleading text.

### Case D

Only one person uploads anything.

### Case E

A moment is represented by several media types.

### Case F

There is insufficient evidence.

The system should be comfortable returning:

> **Not enough evidence.**

---

# 36. Product UX principle

Do not overwhelm users with AI explanations.

The interface should feel like a memory product, not an ML dashboard.

The user should primarily see:

```text
YOU FORGOT THIS

[media]

What happened

[short reconstruction]

Captured by:
A · B · C

Why we connected these:
[3 evidence fragments]

[View all]
```

Advanced evidence can be expandable.

---

# 37. What the MVP should NOT contain

Do not build these initially:

* public profiles
* follower system
* likes
* comments
* recommendation feed
* infinite scrolling
* AI image generation
* voice cloning
* web search
* complex analytics
* generic chatbot
* automatic semester movie
* social engagement mechanics

Those distract from the core invention.

---

# 38. The MVP's one magical interaction

The MVP should make this possible:

### Person A uploads a photo.

Later:

### Person B uploads a screenshot.

Later:

### Person C uploads a video.

The system realizes:

> **These are probably the same moment.**

Then it presents:

> **We think these belong together.**

with the supporting evidence.

That is the first “holy shit” moment.

Everything else comes after this works.

---

# 39. Future evolution

Once the basic reconstruction engine works, explore:

### Collective memory

Different people contributed different pieces of the same experience.

### Memory gaps

Identify moments where the evidence suggests something happened but the group has incomplete documentation.

### Recurring stories

Find events/jokes/places/people that repeatedly appear over long periods.

### Perspective reconstruction

Show how different members captured the same moment.

### “You were there” discoveries

Find old fragments that connect to current events.

### Memory archaeology

Search years of fragments to discover forgotten relationships.

### End-of-semester retrospective

Only AFTER the core system works, generate a recap.

And the recap should be built from reconstructed moments and stories rather than directly summarizing raw photos.

---

# 40. Optional partner technologies — future evaluation only

After MVP:

## TabPFN

Consider only if we obtain meaningful structured data that supports a prediction/classification problem.

Possible future experiment:

* predict recurring group activity patterns
* classify event types
* identify anomalous changes in group participation

Do not force this.

---

## Temporal

Consider when processing workflows become long-running and need durable retries.

Possible workflow:

```text
upload
→ media processing
→ embedding
→ candidate retrieval
→ AI analysis
→ validation
→ persistence
→ notification
```

Do not introduce Temporal until this workflow genuinely needs durable orchestration.

---

## Sentry

Use for production observability once the pipeline is running.

Especially useful for:

* model failures
* processing failures
* upload failures
* latency
* malformed AI output

---

## Entire

Potentially use as part of development/reasoning history if it provides a meaningful way to document how the project was developed.

Do not make it part of the runtime architecture without a real use case.

---

## Mastra

Only use if the AI workflow becomes sufficiently complex that a dedicated orchestration layer provides clear value.

Do not introduce it merely because it is a partner.

---

## SerpApi

Probably unnecessary.

Only introduce it if a future feature genuinely requires external web information.

---

## DigitalOcean

Not required if Render satisfies deployment needs.

---

# 41. Engineering quality requirements

The project should have:

* typed interfaces
* environment-variable based secrets
* validation
* structured logging
* tests
* database migrations
* clear service boundaries
* retry handling
* idempotent processing where possible
* background processing for expensive tasks
* graceful AI failures
* deterministic mock data for development

Do not expose API keys in the frontend.

---

# 42. Cost philosophy

Prefer free/local/open-source components wherever practical.

The developer has a local Gemma model.

Therefore:

> **Local Gemma should be the default AI path.**

Cloud AI should not silently become the default.

If a component requires a paid service, document:

```text
Why it is needed
Whether a free/local alternative exists
What breaks without it
```

Do not introduce paid infrastructure merely because it is easier.

---

# 43. Source/reference material

The project has Gemma reference links supplied by the developer.

Use these as initial references:

* MLH Gemma partner page:
  https://www.mlh.com/partners/gemma

* Google Gemma documentation:
  https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api

* Gemma 4 local/Ollama reference:
  https://dev.to/purpledoubled/how-to-run-googles-gemma-4-locally-with-ollama-all-4-model-sizes-compared-2pbh

These references were supplied specifically for the project and should be considered during Gemma integration planning.

For implementation details that may have changed, verify current official documentation before coding.

---

# 44. Definition of success

The project is NOT successful because:

* it uses many partner technologies
* it generates pretty recaps
* it has an AI chatbot
* it stores photos
* it has a polished landing page

The project is successful when:

> **Multiple people independently upload fragments of their lives, and the system can reliably discover that several fragments belong to the same real-world moment, explain why, preserve uncertainty, and turn those fragments into a meaningful shared memory.**

That is the core technical and product challenge.

---

# 45. FIRST TASK — DOCUMENTATION ONLY

Again:

## STOP BEFORE CODING.

Your immediate task is:

### Step 1

Inspect the repository.

### Step 2

Inspect the local Gemma installation and determine what runtime/API is available.

### Step 3

Create:

```text
README.md
PRODUCT.md
ARCHITECTURE.md
AI_PIPELINE.md
CONTEXT_ENGINEERING.md
DATA_MODEL.md
AI_CONTRACTS.md
PRIVACY.md
MVP.md
ROADMAP.md
DECISIONS.md
```

### Step 4

Cross-check those documents for contradictions.

### Step 5

Identify assumptions that need verification.

### Step 6

Only after the documentation is complete should you propose the first implementation milestone.

Do NOT create the full application yet.

Do NOT install unnecessary dependencies yet.

Do NOT add optional partner technologies yet.

Do NOT make architecture decisions silently.

---

# 46. Final engineering principle

Build the smallest system that makes this sentence true:

> **“I uploaded one tiny piece of my day, my friends uploaded different tiny pieces, and months later the system helped us remember the thing none of us actually documented.”**

Everything in the architecture should serve that sentence.
