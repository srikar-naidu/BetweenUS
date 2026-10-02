# Architecture decisions

This document records the major product and engineering choices in ADR-style format.

## Decision 1: Use local Gemma as the default reasoning layer

### Context

The challenge requires local-first reasoning and explicit constraints around privacy, efficiency, and local runtime integration.

### Options considered

- Use a cloud-only AI provider
- Use a local model runtime without a formal adapter
- Use Gemma through a local runtime like Ollama

### Chosen approach

Use Gemma through a local adapter over Ollama.

### Reason

This matches the requirement for local AI first, avoids unnecessary paid infrastructure, and gives the project a clear runtime boundary for future abstraction.

### Trade-offs

- Pros: local control, lower cost, privacy alignment, supported model choice
- Cons: hardware constraints, less raw scale than large cloud models, possible latency on heavier reasoning

## Decision 2: Treat the moment as the primary product object

### Context

The project is not a photo-sharing product or a gallery. The challenge demands a system focused on event reconstruction rather than uploaded media as the primary artifact.

### Options considered

- Photo-first product experience
- Event-first reconstruction architecture
- Hybrid gallery plus AI summary

### Chosen approach

Event-first architecture with fragments feeding into moments and moments feeding into stories.

### Reason

This matches the product thesis and makes the system meaningfully different from normal shared-album products.

### Trade-offs

- Pros: stronger differentiation, more relevant AI work, better user value
- Cons: harder to explain to users at first, less obvious than “photo album” UX

## Decision 3: Use MongoDB for canonical app state and Tiger Data for retrieval

### Context

The system needs both operational state storage and temporal/vector retrieval.

### Options considered

- Single database for everything
- MongoDB plus a separate retrieval index
- Use only one retrieval-oriented database

### Chosen approach

MongoDB Atlas for canonical application state; Tiger Data for time-aware vector and temporal retrieval.

### Reason

This keeps operational state and retrieval concerns separated while respecting the requirement that temporal retrieval is a first-class concern.

### Trade-offs

- Pros: clear separation of concerns, strong retrieval fit, simpler mental model
- Cons: more operational complexity than a single database

## Decision 4: Build context packets rather than sending broad historical context to Gemma

### Context

The system must avoid overloading the model with unnecessary historical data.

### Options considered

- Send everything to Gemma each time
- Send broad historical context on every task
- Send a compact, task-specific Context Packet

### Chosen approach

Use dynamically assembled Context Packets built from retrieved candidates and relevant memory.

### Reason

This minimizes cost, improves latency, and reduces the chance of mistakes caused by irrelevant context.

### Trade-offs

- Pros: efficiency, better reasoning quality, lower cost
- Cons: more development effort and retrieval pipeline complexity

## Decision 5: Require evidence and uncertainty for every AI-generated conclusion

### Context

The project explicitly requires evidence-based conclusions and forbids hallucinations.

### Options considered

- Produce free-form narrative without constraints
- Produce narrative but skip evidence
- Produce structured evidence-linked outputs with uncertainty labels

### Chosen approach

Use structured outputs with evidence references and explicit uncertainty labels.

### Reason

This makes the product safer and more explainable. It is a direct response to hallucination risk.

### Trade-offs

- Pros: trustworthiness, explainability, better UX
- Cons: more engineering effort, less narrative freedom for the model

## Decision 6: Keep optional technologies out of the MVP

### Context

The challenge includes many optional technologies, but the initial product must stay narrow and focused.

### Options considered

- Add every partner to satisfy a broad architecture checklist
- Keep only the required stack and defer optional tools
- Add a few small extras for convenience

### Chosen approach

Keep the initial implementation narrowly scoped to Gemma, MongoDB, Tiger Data, Backboard, Render, and a small supporting backend/frontend.

### Reason

The product’s first value is proving that events can be reconstructed from fragments, not integrating a large technology stack.

### Trade-offs

- Pros: faster MVP, clearer focus, lower complexity
- Cons: more deliberate future work is needed for advanced features
