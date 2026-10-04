import type { FragmentVisibility } from "@/lib/domain/memory";

export const MAX_TEXT_CHARACTERS = 10_000;

export class FragmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FragmentInputError";
  }
}

interface ValidatedFragmentMetadata {
  capturedAt: Date;
  capturedTimeZone: string;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
}

function validateFragmentMetadata(input: unknown): ValidatedFragmentMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FragmentInputError("Invalid fragment details");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.capturedAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(value.capturedAt)) {
    throw new FragmentInputError("Capture time must include a timezone offset");
  }
  const capturedAt = new Date(value.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new FragmentInputError("Capture time is invalid");
  }
  if (typeof value.capturedTimeZone !== "string" || value.capturedTimeZone.length > 80) {
    throw new FragmentInputError("A valid capture timezone is required");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.capturedTimeZone }).format(capturedAt);
  } catch {
    throw new FragmentInputError("Capture timezone is invalid");
  }
  const visibility = value.visibility ?? "private";
  if (visibility !== "private" && visibility !== "group" && visibility !== "restricted") {
    throw new FragmentInputError("Invalid fragment visibility");
  }
  const aiProcessingConsent = value.aiProcessingConsent ?? false;
  if (typeof aiProcessingConsent !== "boolean") {
    throw new FragmentInputError("AI processing consent must be explicit");
  }
  return {
    capturedAt,
    capturedTimeZone: value.capturedTimeZone,
    visibility,
    aiProcessingConsent,
  };
}

export function validateTextFragment(input: unknown): {
  textContent: string;
  capturedAt: Date;
  capturedTimeZone: string;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FragmentInputError("Invalid text fragment");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.textContent !== "string" || !value.textContent.trim() || value.textContent.length > MAX_TEXT_CHARACTERS) {
    throw new FragmentInputError("Text must contain 1 to 10,000 characters");
  }
  const common = validateFragmentMetadata({
    capturedAt: value.capturedAt,
    capturedTimeZone: value.capturedTimeZone,
    visibility: value.visibility,
    aiProcessingConsent: value.aiProcessingConsent,
  });
  return {
    textContent: value.textContent.trim(),
    capturedAt: common.capturedAt,
    capturedTimeZone: common.capturedTimeZone,
    visibility: common.visibility,
    aiProcessingConsent: common.aiProcessingConsent,
  };
}
