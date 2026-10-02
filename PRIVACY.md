# Privacy and governance

## Goal

Between Us is a private memory system. Privacy is not a product feature layered on later; it is part of the product’s architecture.

## Group isolation

Each group has a private memory boundary. Fragments and AI interpretations should be segregated by group.

Rules:

- no cross-group reuse of fragments without explicit membership
- no shared moment inference across groups unless membership is explicitly shared
- group IDs must be used in retrieval and visibility checks

## Media visibility

Users may upload content that is private to them or visible within a group.

The system must enforce:

- author ownership
- group visibility rules
- consent for shared interpretation
- explicit boundaries for private evidence

A private fragment must not be exposed to the rest of the group merely because the AI thinks it belongs to a shared moment.

## AI processing boundaries

AI processing should occur within the group context and with explicit ownership checks.

Rules:

- AI may analyze only authorized fragments
- AI observations must carry evidence references
- AI-generated interpretations must not bypass visibility rules
- private fragments must remain private unless explicitly allowed

## Deletion and correction

Users must be able to delete content and associated AI observations where appropriate.

The system must handle:

- deletion of the raw fragment
- invalidation of dependent AI observations
- notification of impacted moments or stories
- retention rules for evidence references

## Ownership

Ownership is explicit:

- the original uploader owns the raw fragment
- the group owns the shared memory space
- AI-generated interpretations do not replace ownership claims
- any group-level insight must still trace back to source evidence and permissions

## Consent

The system should require consent for non-trivial AI use cases involving personal material.

Examples:

- a fragment is used in shared memory reconstruction
- an upload is included in group-level evidence or discovery
- a correction or memory interpretation is merged into shared context

## Private fragments

Private fragments are treated as sensitive records. They may:

- be analyzed for local understanding
- be used only when the user’s access scope permits it
- contribute to shared moment reconstruction only under explicit rules

The system should default to privacy-preserving behavior and require a clear policy for when private data can be used in group-level inference.

## Evidence access

Users should be able to inspect why a moment or story was inferred.

The system should support:

- fragment-level evidence visibility
- confidence and uncertainty display
- explicit user controls over what can be shown within the group

## Privacy-by-default principle

If the system is uncertain whether a fragment should be used in a shared inference, it should default to “do not include” rather than “assume it belongs.”
