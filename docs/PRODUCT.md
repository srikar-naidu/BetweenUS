# Product specification

## Product thesis

Between Us is not a photo app with AI features. It is a private memory reconstruction system for groups of friends who each captured only fragments of a shared experience.

The emotional reward is not “here is your recap.” It is “you forgot this happened.”

## Target user

The initial target user is a small friend group with repeated shared experiences over time:

- classmates
- colleagues
- roommates
- travel groups
- social circles with recurring events

This user group values private memory recall, not public sharing.

## Core loop

The product loop is:

1. A user uploads a fragment
2. The system understands the fragment
3. Nearby and semantically relevant fragments are retrieved
4. The system compares those fragments against candidate moments
5. The system identifies whether the fragments likely belong to the same moment
6. The system surfaces a possible moment with evidence and uncertainty
7. Over time, the system detects recurring stories and forgotten connections

## Fragment → Moment → Story model

### Fragment

A single captured item, such as:

- photo
- video
- screenshot
- text message
- voice note
- geotagged location
- timestamped caption
- uploaded media with metadata

### Moment

A real-world event reconstructed from multiple fragments. The moment is the primary object of the product.

### Story

A larger pattern made from multiple related moments over time. Stories connect repeated experiences, recurring jokes, or repeated group activity.

## Major user flows

### Upload and understanding

A user uploads media or text. The system extracts metadata, identifies likely entities, and creates a structured observation set.

### Moment candidate creation

The system searches nearby and semantically related fragments and checks whether a moment can be reconstructed from them.

### Evidence-backed explanation

The user sees a candidate moment and a concise statement of why the system connected the fragments.

### Pattern discovery

Over time, the product identifies recurring stories and hidden connections that users did not explicitly record.

### Correction loop

Users can correct the system when the interpretation is wrong. Corrections become lasting memory input and are treated as structured knowledge.

## Privacy expectations

Between Us is a private group memory product. It must enforce clear boundaries around:

- group membership
- media visibility
- ownership
- who can see which evidence
- AI-generated interpretations
- deletion and correction rights
- consent to use specific fragments in group reconstruction

The system must not expose private uploads to the whole group simply because the model thinks they fit a shared event.

## Anti-features

The MVP should avoid:

- public profiles
- like/comment systems
- endless social feed behavior
- generic chatbot persona
- AI slideshow generation
- public memory feed
- automated summary generation as the primary product experience

## Differentiation from Retro-like products

Retro-style products focus on capturing and sharing memories after the fact.

Between Us focuses on understanding relationships between captured fragments and reconstructing moments that were never fully documented.

The product behavior is:

- capture fragments
- understand them
- find relationships
- reconstruct moments
- connect moments across time
- surface forgotten stories

## Non-goals for MVP

The initial scope excludes:

- broad public memory sharing
- social engagement loops
- multi-tenant social networking features
- voice cloning or synthetic recreation
- generic conversational memory chat
- long-form automatic recap generation as the primary product

## Product principle

The system must distinguish evidence-backed discovery from speculation. It must never invent an event or convert uncertainty into fact.

When evidence is weak, the system should say “possible,” “likely,” or “not enough evidence,” rather than fabricate a memory.
