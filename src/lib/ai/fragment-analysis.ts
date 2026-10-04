import { createHash } from "node:crypto";
import {
  hasAnalyzableFragmentSource,
  hasApprovedTextSource,
  type Fragment,
} from "@/lib/domain/memory";
import {
  createGemmaService,
  type StructuredGenerationInput,
} from "@/lib/ai/gemma-provider";

export const FRAGMENT_ANALYSIS_VERSION = "fragment-analysis-v2";
export const MAX_FRAGMENT_FACTS = 20;
export const MAX_VIDEO_ANALYSIS_FRAMES = 6;

export type FragmentFactType =
  | "person"
  | "place"
  | "object"
  | "activity"
  | "tone"
  | "reference"
  | "visible_text";
export type ObservationModality = "text" | "voice_transcript" | "image" | "video_frame";

export interface EvidenceReference {
  fragmentId: string;
  modality: ObservationModality;
  locator: string | null;
  evidence: string;
}

export interface FragmentObservationFact {
  type: FragmentFactType;
  value: string;
  confidence: number;
  evidence: EvidenceReference;
}

export interface FragmentAnalysis {
  id: string;
  groupId: string;
  fragmentId: string;
  authorUserId: string;
  analysisVersion: string;
  modelVersion: string;
  sourceContentSha256: string;
  summary: string;
  observedFacts: FragmentObservationFact[];
  people: string[];
  entities: string[];
  locationHint: string | null;
  activityHint: string | null;
  toneHint: string | null;
  confidence: number;
  uncertainty: {
    status: "possible" | "unknown";
    reason: string;
  };
  evidenceFragmentIds: string[];
  requiresReview: boolean;
  analyzedAt: Date;
}

export interface FragmentAnalysisGenerator {
  readonly modelVersion: string;
  generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
}

export type MemoryObservation = Omit<
  FragmentAnalysis,
  "id" | "groupId" | "authorUserId" | "modelVersion" | "sourceContentSha256" | "analyzedAt"
>;

export class FragmentAnalysisValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FragmentAnalysisValidationError";
  }
}

function textArraySchema(maxItems: number) {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength: 120 },
  };
}

export function fragmentAnalysisResponseSchema(
  fragmentId: string,
  evidenceSource: ObservationModality = "text",
  evidenceLocators: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      fragment_id: { type: "string", enum: [fragmentId] },
      summary: { type: "string", maxLength: 500 },
      observed_facts: {
        type: "array",
        maxItems: MAX_FRAGMENT_FACTS,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["person", "place", "object", "activity", "tone", "reference", "visible_text"],
            },
            value: { type: "string", minLength: 1, maxLength: 240 },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: evidenceSource === "image" || evidenceSource === "video_frame" ? 0.7 : 1,
            },
            evidence: {
              type: "object",
              properties: {
                fragment_id: { type: "string", const: fragmentId },
                modality: { type: "string", const: evidenceSource },
                locator: {
                  type: ["string", "null"],
                  ...(evidenceLocators.length
                    ? { enum: [...evidenceLocators] }
                    : { const: null }),
                },
                evidence: { type: "string", minLength: 1, maxLength: 240 },
              },
              required: ["fragment_id", "modality", "locator", "evidence"],
              additionalProperties: false,
            },
          },
          required: ["type", "value", "confidence", "evidence"],
          additionalProperties: false,
        },
      },
      people: textArraySchema(20),
      entities: textArraySchema(30),
      location_hint: { type: ["string", "null"], maxLength: 240 },
      activity_hint: { type: ["string", "null"], maxLength: 240 },
      tone_hint: { type: ["string", "null"], maxLength: 240 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      uncertainty: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["possible", "unknown"] },
          reason: { type: "string", minLength: 1, maxLength: 300 },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      },
      evidence_fragment_ids: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: { type: "string", enum: [fragmentId] },
      },
    },
    required: [
      "fragment_id",
      "summary",
      "observed_facts",
      "people",
      "entities",
      "location_hint",
      "activity_hint",
      "tone_hint",
      "confidence",
      "uncertainty",
      "evidence_fragment_ids",
    ],
    additionalProperties: false,
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FragmentAnalysisValidationError(`Gemma returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function validateText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new FragmentAnalysisValidationError(`Gemma returned invalid ${label}`);
  }
  return value.trim();
}

function validateOptionalHint(value: unknown, label: string): string | null {
  if (value === null) return null;
  return validateText(value, label, 240);
}

function validateTextArray(value: unknown, label: string, maxItems: number, sourceText: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new FragmentAnalysisValidationError(`Gemma returned invalid ${label}`);
  }
  const values = value.map((item) => validateText(item, label, 120));
  if (values.some((item) => !sourceText.includes(item))) {
    throw new FragmentAnalysisValidationError(`Gemma returned ${label} that is not present in the source text`);
  }
  return [...new Set(values)];
}

function validateObservationList(
  value: unknown,
  label: string,
  maxItems: number,
  observedFacts: readonly FragmentObservationFact[],
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new FragmentAnalysisValidationError(`Gemma returned invalid ${label}`);
  }
  const values = value.map((item) => validateText(item, label, 120));
  const supported = new Set(observedFacts.map((fact) => fact.value));
  if (values.some((item) => !supported.has(item))) {
    throw new FragmentAnalysisValidationError(`Gemma returned ${label} without matching evidence`);
  }
  return [...new Set(values)];
}

export function validateFragmentAnalysisOutput(
  result: Record<string, unknown>,
  fragmentId: string,
  sourceText: string,
  evidenceSource: ObservationModality = "text",
  evidenceLocators: readonly string[] = [],
): MemoryObservation {
  const isTextual = evidenceSource === "text" || evidenceSource === "voice_transcript";
  if (result.fragment_id !== fragmentId) {
    throw new FragmentAnalysisValidationError("Gemma cited a different source fragment");
  }
  const proposedSummary = typeof result.summary === "string" && result.summary.length <= 500
    ? result.summary.trim()
    : (() => { throw new FragmentAnalysisValidationError("Gemma returned an invalid summary"); })();
  if (isTextual && proposedSummary && !sourceText.includes(proposedSummary)) {
    throw new FragmentAnalysisValidationError("Gemma returned a summary that is not present in the source text");
  }
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > (isTextual ? 1 : 0.7)
  ) {
    throw new FragmentAnalysisValidationError("Gemma returned an invalid confidence value");
  }
  if (!Array.isArray(result.observed_facts) || result.observed_facts.length > MAX_FRAGMENT_FACTS) {
    throw new FragmentAnalysisValidationError("Gemma returned invalid observed facts");
  }
  const observedFacts = result.observed_facts.map((item): FragmentObservationFact => {
    const fact = recordValue(item, "observed fact");
    const allowedTypes: readonly FragmentFactType[] = [
      "person",
      "place",
      "object",
      "activity",
      "tone",
      "reference",
      "visible_text",
    ];
    if (typeof fact.type !== "string" || !allowedTypes.includes(fact.type as FragmentFactType)) {
      throw new FragmentAnalysisValidationError("Gemma returned an unsupported fact type");
    }
    const value = validateText(fact.value, "fact value", 240);
    const reference = recordValue(fact.evidence, "evidence reference");
    const evidence = validateText(reference.evidence, "evidence description", 240);
    const locator = reference.locator === null
      ? null
      : validateText(reference.locator, "evidence locator", 80);
    if (reference.fragment_id !== fragmentId || reference.modality !== evidenceSource) {
      throw new FragmentAnalysisValidationError("Gemma returned evidence for a different fragment or modality");
    }
    if (isTextual) {
      if (
        locator !== null ||
        !sourceText.includes(evidence) ||
        !evidence.includes(value)
      ) {
        throw new FragmentAnalysisValidationError("Gemma cited text that is not present in the source fragment");
      }
    } else if (
      !locator ||
      !evidenceLocators.includes(locator) ||
      !evidence.toLocaleLowerCase().includes(value.toLocaleLowerCase())
    ) {
      throw new FragmentAnalysisValidationError("Gemma returned an ungrounded visual observation");
    }
    if (
      typeof fact.confidence !== "number" ||
      !Number.isFinite(fact.confidence) ||
      fact.confidence < 0 ||
      fact.confidence > (isTextual ? 1 : 0.7)
    ) {
      throw new FragmentAnalysisValidationError("Gemma returned invalid fact provenance or confidence");
    }
    return {
      type: fact.type as FragmentFactType,
      value,
      confidence: fact.confidence,
      evidence: {
        fragmentId,
        modality: evidenceSource,
        locator,
        evidence,
      },
    };
  });
  const summary = isTextual
    ? proposedSummary
    : observedFacts.slice(0, 5).map((fact) => fact.value).join("; ");
  if (observedFacts.length && !summary) {
    throw new FragmentAnalysisValidationError("Gemma omitted the summary for observed facts");
  }

  const people = isTextual
    ? validateTextArray(result.people, "people", 20, sourceText)
    : validateObservationList(result.people, "people", 20, observedFacts);
  const entities = isTextual
    ? validateTextArray(result.entities, "entities", 30, sourceText)
    : validateObservationList(
        result.entities,
        "entities",
        30,
        observedFacts.filter((fact) => fact.type !== "person"),
      );
  const locationHint = validateOptionalHint(result.location_hint, "location hint");
  const activityHint = validateOptionalHint(result.activity_hint, "activity hint");
  const toneHint = validateOptionalHint(result.tone_hint, "tone hint");
  for (const [hint, factType, label] of [
    [locationHint, "place", "location"],
    [activityHint, "activity", "activity"],
    [toneHint, "tone", "tone"],
  ] as const) {
    if (hint && !observedFacts.some((fact) => fact.type === factType && fact.value === hint)) {
      throw new FragmentAnalysisValidationError(`Gemma returned an unsupported ${label} hint`);
    }
  }

  const uncertainty = recordValue(result.uncertainty, "uncertainty");
  const expectedStatus = observedFacts.length ? "possible" : "unknown";
  if (uncertainty.status !== expectedStatus) {
    throw new FragmentAnalysisValidationError("Gemma returned an uncertainty status inconsistent with its evidence");
  }
  const reason = validateText(uncertainty.reason, "uncertainty reason", 300);
  if (!Array.isArray(result.evidence_fragment_ids) ||
      result.evidence_fragment_ids.length !== 1 ||
      result.evidence_fragment_ids[0] !== fragmentId) {
    throw new FragmentAnalysisValidationError("Gemma returned invalid source evidence IDs");
  }

  return {
    fragmentId,
    analysisVersion: FRAGMENT_ANALYSIS_VERSION,
    summary,
    observedFacts,
    people,
    entities,
    locationHint,
    activityHint,
    toneHint,
    confidence: result.confidence,
    uncertainty: { status: expectedStatus, reason },
    evidenceFragmentIds: [fragmentId],
    requiresReview: !isTextual,
  };
}

export function fragmentSourceDigest(fragment: Fragment): string {
  const digest = createHash("sha256");
  for (const value of [
    fragment.type,
    fragment.textContent ?? "",
    fragment.checksumSha256 ?? "",
    fragment.caption ?? "",
    fragment.capturedAt.toISOString(),
    fragment.capturedTimeZone ?? "",
    fragment.metadata.mimeType ?? "",
    "video-frames-v1",
  ]) {
    digest.update(value).update("\0");
  }
  return digest.digest("hex");
}

export interface FragmentAnalysisMediaInput {
  images: readonly Uint8Array[];
  evidenceLocators: readonly string[];
}

export function canReuseFragmentAnalysis(
  fragment: Fragment,
  analysis: FragmentAnalysis | null,
  modelVersion: string,
): analysis is FragmentAnalysis {
  return analysis !== null &&
    analysis.analysisVersion === FRAGMENT_ANALYSIS_VERSION &&
    analysis.modelVersion === modelVersion &&
    analysis.sourceContentSha256 === fragmentSourceDigest(fragment);
}

export async function generateFragmentAnalysis(
  fragment: Fragment,
  provider: FragmentAnalysisGenerator = createGemmaService(),
  mediaInput?: FragmentAnalysisMediaInput,
): Promise<FragmentAnalysis> {
  if (fragment.deletionState !== "active" || !fragment.aiProcessingConsent ||
      !hasAnalyzableFragmentSource(fragment)) {
    throw new FragmentAnalysisValidationError("Fragment is not eligible for AI processing");
  }

  const isTextual = hasApprovedTextSource(fragment);
  const evidenceSource: ObservationModality = isTextual
    ? fragment.type === "voice" ? "voice_transcript" : "text"
    : fragment.type === "video" ? "video_frame" : "image";
  const evidenceLocators = evidenceSource === "image"
    ? ["whole_image"]
    : evidenceSource === "video_frame"
      ? [...(mediaInput?.evidenceLocators ?? [])]
      : [];
  if (
    evidenceSource === "image" && mediaInput?.images.length !== 1 ||
    evidenceSource === "video_frame" &&
      (!mediaInput?.images.length ||
        mediaInput.images.length !== evidenceLocators.length ||
        mediaInput.images.length > MAX_VIDEO_ANALYSIS_FRAMES)
  ) {
    throw new FragmentAnalysisValidationError("Media analysis requires bounded, matching image evidence");
  }
  if (isTextual && !fragment.textContent?.trim()) {
    throw new FragmentAnalysisValidationError("Text analysis requires an approved source transcript");
  }
  if (!isTextual && (!mediaInput || !mediaInput.images.length)) {
    throw new FragmentAnalysisValidationError("Media analysis requires locally prepared image evidence");
  }

  const textSource = fragment.textContent ?? "";
  const visualConstraints = [
    "Describe only observable details. Do not identify people, infer relationships, sensitive traits, or exact locations.",
    "Every fact must have evidence with this fragment ID, the supplied modality, a supplied image/frame locator, and a short description that includes the fact value.",
    "Treat visual observations as tentative and never present them as verified facts. Keep confidence at or below 0.7.",
    "Use visible_text only for legible text shown in the supplied image/frame. Do not invent OCR.",
    "Do not infer dates or event context from appearance. Use the provided capture timestamp only as metadata.",
    "Return unknown uncertainty when no directly observable evidence supports an observation.",
  ];
  const result = await provider.generateStructured({
    task: isTextual ? "analyze_text_fragment" : "analyze_visual_fragment",
    contextPacket: {
      fragment_id: fragment.id,
      captured_at: fragment.capturedAt.toISOString(),
      captured_timezone: fragment.capturedTimeZone,
      fragment_type: fragment.type,
      ...(isTextual
        ? { text_content: textSource }
        : {
            caption_context: fragment.caption,
            image_evidence: evidenceLocators,
          }),
      constraints: isTextual
        ? [
            "Use only the supplied text as evidence.",
            "Do not infer a person's identity or appearance.",
            "For each fact, cite an exact source span that contains the literal fact value and reference this fragment ID.",
            "The summary must be a short exact excerpt from the source text, not a paraphrase.",
            "People and entities must be literal phrases in the source text.",
            "Use uncertainty status possible when there is extracted evidence, otherwise unknown. Never use likely or confirmed.",
          ]
        : visualConstraints,
    },
    responseSchema: fragmentAnalysisResponseSchema(fragment.id, evidenceSource, evidenceLocators),
    ...(mediaInput ? { images: [...mediaInput.images] } : {}),
  });
  const validated = validateFragmentAnalysisOutput(
    result,
    fragment.id,
    textSource,
    evidenceSource,
    evidenceLocators,
  );
  return {
    ...validated,
    id: `${fragment.groupId}:${fragment.id}:${FRAGMENT_ANALYSIS_VERSION}`,
    groupId: fragment.groupId,
    authorUserId: fragment.authorUserId,
    modelVersion: provider.modelVersion,
    sourceContentSha256: fragmentSourceDigest(fragment),
    analyzedAt: new Date(),
  };
}

export async function generateOrReuseFragmentAnalysis(input: {
  fragment: Fragment;
  existingAnalysis: FragmentAnalysis | null;
  provider: FragmentAnalysisGenerator;
  loadMedia?: () => Promise<FragmentAnalysisMediaInput>;
}): Promise<FragmentAnalysis> {
  if (canReuseFragmentAnalysis(input.fragment, input.existingAnalysis, input.provider.modelVersion)) {
    return input.existingAnalysis;
  }
  const mediaInput = input.fragment.type === "image" || input.fragment.type === "video"
    ? await input.loadMedia?.()
    : undefined;
  return generateFragmentAnalysis(input.fragment, input.provider, mediaInput);
}

export function fragmentAnalysisSearchText(analysis: FragmentAnalysis): string {
  return [
    analysis.summary,
    ...analysis.observedFacts.map((fact) => fact.value),
    analysis.locationHint,
    analysis.activityHint,
    analysis.toneHint,
  ].filter((value): value is string => Boolean(value)).join(" ");
}
