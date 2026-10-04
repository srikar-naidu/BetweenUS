import { fragmentSourceDigest, type FragmentAnalysis } from "@/lib/ai/fragment-analysis";
import { hasApprovedTextSource, type Fragment, type Moment } from "@/lib/domain/memory";
import type { StructuredGenerationInput } from "@/lib/ai/gemma-provider";

export const MAX_EVENT_STORY_MOMENTS = 12;
export const MAX_EVENT_STORY_FRAGMENTS = 16;

export interface EventStoryContextPacket {
  version: "event-story-context-v1";
  moments: Array<{
    moment_id: string;
    captured_at: string;
    title: string | null;
    summary: string;
    sources: Array<{
      fragment_id: string;
      media_type: string;
      observation: string;
      facts: Array<{
        type: string;
        value: string;
        confidence: number;
        modality: string;
        locator: string | null;
      }>;
    }>;
  }>;
}

export interface EventStoryEvidenceReference {
  claim: string;
  fragmentIds: string[];
  uncertainty: "grounded" | "uncertain";
}

export interface ValidatedEventStory {
  title: string;
  narrative: string;
  momentIds: string[];
  evidenceReferences: EventStoryEvidenceReference[];
}

export class EventStoryGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStoryGenerationError";
  }
}

export function buildEventStoryContextPacket(input: {
  groupId: string;
  moments: readonly Moment[];
  fragments: readonly Fragment[];
  analyses: readonly FragmentAnalysis[];
}): EventStoryContextPacket {
  if (input.moments.length === 0 || input.moments.length > MAX_EVENT_STORY_MOMENTS) {
    throw new EventStoryGenerationError(
      `Choose between 1 and ${MAX_EVENT_STORY_MOMENTS} confirmed Moments for one event story.`,
    );
  }

  const eligibleFragments = new Map(input.fragments
    .filter((fragment) =>
      fragment.groupId === input.groupId &&
      fragment.visibility === "group" &&
      fragment.aiProcessingConsent &&
      fragment.deletionState === "active",
    )
    .map((fragment) => [fragment.id, fragment]));
  const analyses = new Map(input.analyses
    .filter((analysis) => analysis.groupId === input.groupId)
    .map((analysis) => [analysis.fragmentId, analysis]));
  const seenFragmentIds = new Set<string>();

  const moments = [...input.moments]
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())
    .map((moment) => {
      if (
        moment.groupId !== input.groupId ||
        moment.status !== "confirmed" ||
        moment.evidence.length === 0
      ) {
        throw new EventStoryGenerationError("Only confirmed Moments with evidence can be used.");
      }
      const sources = moment.evidence.map(({ fragmentId }) => {
        const fragment = eligibleFragments.get(fragmentId);
        const analysis = analyses.get(fragmentId);
        if (
          !fragment ||
          !analysis ||
          (fragment.type === "voice" && !hasApprovedTextSource(fragment)) ||
          analysis.sourceContentSha256 !== fragmentSourceDigest(fragment) ||
          !analysis.evidenceFragmentIds.includes(fragmentId)
        ) {
          throw new EventStoryGenerationError(
            "Every selected Moment needs current, consented Gemma observations for all of its evidence.",
          );
        }
        seenFragmentIds.add(fragmentId);
        return {
          fragment_id: fragmentId,
          media_type: fragment.type,
          observation: analysis.summary.slice(0, 180),
          facts: analysis.observedFacts.slice(0, 2).map((fact) => ({
            type: fact.type,
            value: fact.value.slice(0, 80),
            confidence: fact.confidence,
            modality: fact.evidence.modality,
            locator: fact.evidence.locator,
          })),
        };
      });
      return {
        moment_id: moment.id,
        captured_at: moment.startAt.toISOString(),
        title: moment.title,
        summary: moment.summary.slice(0, 180),
        sources,
      };
    });

  if (seenFragmentIds.size > MAX_EVENT_STORY_FRAGMENTS) {
    throw new EventStoryGenerationError(
      `This story has more than ${MAX_EVENT_STORY_FRAGMENTS} evidence fragments. Select fewer Moments and generate the story in smaller sections.`,
    );
  }
  return { version: "event-story-context-v1", moments };
}

export function eventStoryResponseSchema(
  packet: EventStoryContextPacket,
): Record<string, unknown> {
  const fragmentIds = [...new Set(packet.moments.flatMap((moment) =>
    moment.sources.map((source) => source.fragment_id),
  ))];
  return {
    type: "object",
    properties: {
      title: { type: "string", minLength: 2, maxLength: 120 },
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            evidence_fragment_ids: {
              type: "array",
              minItems: 1,
              maxItems: fragmentIds.length,
              items: { type: "string", enum: fragmentIds },
            },
            uncertainty: { type: "string", enum: ["grounded", "uncertain"] },
          },
          required: ["text", "evidence_fragment_ids", "uncertainty"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "sections"],
    additionalProperties: false,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateEventStoryResponse(
  value: Record<string, unknown>,
  packet: EventStoryContextPacket,
): ValidatedEventStory {
  const title = value.title;
  const sections = value.sections;
  const availableFragmentIds = new Set(packet.moments.flatMap((moment) =>
    moment.sources.map((source) => source.fragment_id),
  ));
  if (
    typeof title !== "string" ||
    title.trim().length < 2 ||
    title.trim().length > 120 ||
    !Array.isArray(sections) ||
    sections.length === 0 ||
    sections.length > 12
  ) {
    throw new EventStoryGenerationError("Gemma returned an invalid event-story structure.");
  }

  const evidenceReferences = sections.map((item) => {
    const section = record(item);
    if (
      !section ||
      typeof section.text !== "string" ||
      !section.text.trim() ||
      section.text.length > 500 ||
      !Array.isArray(section.evidence_fragment_ids) ||
      section.evidence_fragment_ids.length === 0 ||
      !section.evidence_fragment_ids.every((id) =>
        typeof id === "string" && availableFragmentIds.has(id),
      ) ||
      !["grounded", "uncertain"].includes(String(section.uncertainty))
    ) {
      throw new EventStoryGenerationError("Gemma returned a story claim without valid supporting evidence.");
    }
    return {
      claim: section.text.trim(),
      fragmentIds: [...new Set(section.evidence_fragment_ids as string[])],
      uncertainty: section.uncertainty as "grounded" | "uncertain",
    };
  });
  return {
    title: title.trim(),
    narrative: evidenceReferences.map((reference) => reference.claim).join("\n\n"),
    momentIds: packet.moments.map((moment) => moment.moment_id),
    evidenceReferences,
  };
}

export async function generateEventStory(input: {
  groupId: string;
  moments: readonly Moment[];
  fragments: readonly Fragment[];
  analyses: readonly FragmentAnalysis[];
  generator: {
    generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
  };
}): Promise<ValidatedEventStory> {
  const packet = buildEventStoryContextPacket(input);
  const result = await input.generator.generateStructured({
    task: "reconstruct_event_story",
    contextPacket: {
      event: packet,
      constraints: [
        "Write an editable, concise, chronological recap of this one event.",
        "Use only the supplied confirmed Moments and Gemma observations. Do not invent identities, exact locations, dialogue, emotions, or causes.",
        "Every section must cite one or more supplied evidence fragment IDs.",
        "Mark a section uncertain when the evidence is incomplete or tentative.",
        "Visual observations describe visible details only; voice content is only an author-reviewed transcript.",
      ],
    },
    responseSchema: eventStoryResponseSchema(packet),
    think: false,
  });
  return validateEventStoryResponse(result, packet);
}
