import { createHash } from "node:crypto";
import type { Fragment } from "@/lib/domain/memory";
import {
  OllamaGemmaProvider,
  type StructuredGenerationInput,
} from "@/lib/ai/gemma-provider";

export const FRAGMENT_ANALYSIS_VERSION = "fragment-analysis-v1";
export const MAX_FRAGMENT_FACTS = 20;

export type FragmentFactType = "person" | "place" | "object" | "activity" | "tone" | "reference";

export interface FragmentObservationFact {
  type: FragmentFactType;
  value: string;
  confidence: number;
  source: "text";
  evidence: string;
}

export interface FragmentAnalysis {
  id: string;
  groupId: string;
  fragmentId: string;
  authorUserId: string;
  analysisVersion: string;
  modelVersion: string;
  sourceTextSha256: string;
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
  analyzedAt: Date;
}

export interface FragmentAnalysisGenerator {
  readonly modelVersion: string;
  generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
}

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

export function fragmentAnalysisResponseSchema(fragmentId: string): Record<string, unknown> {
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
            type: { type: "string", enum: ["person", "place", "object", "activity", "tone", "reference"] },
            value: { type: "string", minLength: 1, maxLength: 240 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            source: { type: "string", const: "text" },
            evidence: { type: "string", minLength: 1, maxLength: 240 },
          },
          required: ["type", "value", "confidence", "source", "evidence"],
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

export function validateFragmentAnalysisOutput(
  result: Record<string, unknown>,
  fragmentId: string,
  sourceText: string,
): Omit<FragmentAnalysis, "id" | "groupId" | "authorUserId" | "modelVersion" | "sourceTextSha256" | "analyzedAt"> {
  if (result.fragment_id !== fragmentId) {
    throw new FragmentAnalysisValidationError("Gemma cited a different source fragment");
  }
  const summary = typeof result.summary === "string" && result.summary.length <= 500
    ? result.summary.trim()
    : (() => { throw new FragmentAnalysisValidationError("Gemma returned an invalid summary"); })();
  if (summary && !sourceText.includes(summary)) {
    throw new FragmentAnalysisValidationError("Gemma returned a summary that is not present in the source text");
  }
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1
  ) {
    throw new FragmentAnalysisValidationError("Gemma returned an invalid confidence value");
  }
  if (!Array.isArray(result.observed_facts) || result.observed_facts.length > MAX_FRAGMENT_FACTS) {
    throw new FragmentAnalysisValidationError("Gemma returned invalid observed facts");
  }
  const observedFacts = result.observed_facts.map((item): FragmentObservationFact => {
    const fact = recordValue(item, "observed fact");
    const allowedTypes: readonly FragmentFactType[] = ["person", "place", "object", "activity", "tone", "reference"];
    if (typeof fact.type !== "string" || !allowedTypes.includes(fact.type as FragmentFactType)) {
      throw new FragmentAnalysisValidationError("Gemma returned an unsupported fact type");
    }
    const value = validateText(fact.value, "fact value", 240);
    const evidence = validateText(fact.evidence, "fact evidence", 240);
    if (!sourceText.includes(evidence)) {
      throw new FragmentAnalysisValidationError("Gemma cited text that is not present in the source fragment");
    }
    if (!evidence.includes(value)) {
      throw new FragmentAnalysisValidationError("Gemma returned a fact value that is not supported by its evidence");
    }
    if (typeof fact.confidence !== "number" || !Number.isFinite(fact.confidence) ||
        fact.confidence < 0 || fact.confidence > 1 || fact.source !== "text") {
      throw new FragmentAnalysisValidationError("Gemma returned invalid fact provenance or confidence");
    }
    return {
      type: fact.type as FragmentFactType,
      value,
      confidence: fact.confidence,
      source: "text",
      evidence,
    };
  });
  if (observedFacts.length && !summary) {
    throw new FragmentAnalysisValidationError("Gemma omitted the summary for observed facts");
  }

  const people = validateTextArray(result.people, "people", 20, sourceText);
  const entities = validateTextArray(result.entities, "entities", 30, sourceText);
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
  };
}

export async function generateFragmentAnalysis(
  fragment: Fragment,
  provider: FragmentAnalysisGenerator = new OllamaGemmaProvider(),
): Promise<FragmentAnalysis> {
  if (
    fragment.type !== "text" ||
    fragment.source !== "text" ||
    typeof fragment.textContent !== "string" ||
    !fragment.textContent.trim()
  ) {
    throw new FragmentAnalysisValidationError("Only text fragments can be analyzed by the current pipeline");
  }
  if (fragment.deletionState !== "active" || !fragment.aiProcessingConsent) {
    throw new FragmentAnalysisValidationError("Fragment is not eligible for AI processing");
  }

  const result = await provider.generateStructured({
    task: "analyze_text_fragment",
    contextPacket: {
      fragment_id: fragment.id,
      captured_at: fragment.capturedAt.toISOString(),
      captured_timezone: fragment.capturedTimeZone,
      text_content: fragment.textContent,
      constraints: [
        "Use only the supplied text as evidence.",
        "Do not infer a person's identity or appearance.",
        "For each fact, quote a short exact evidence span from the source text that contains the literal fact value.",
        "The summary must be a short exact excerpt from the source text, not a paraphrase.",
        "People and entities must be literal phrases in the source text.",
        "Use uncertainty status possible when there is extracted evidence, otherwise unknown. Never use likely or confirmed.",
      ],
    },
    responseSchema: fragmentAnalysisResponseSchema(fragment.id),
  });
  const validated = validateFragmentAnalysisOutput(result, fragment.id, fragment.textContent);
  return {
    ...validated,
    id: `${fragment.groupId}:${fragment.id}:${FRAGMENT_ANALYSIS_VERSION}`,
    groupId: fragment.groupId,
    authorUserId: fragment.authorUserId,
    modelVersion: provider.modelVersion,
    sourceTextSha256: createHash("sha256").update(fragment.textContent).digest("hex"),
    analyzedAt: new Date(),
  };
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
