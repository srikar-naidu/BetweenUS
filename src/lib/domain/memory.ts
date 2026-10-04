export type FragmentType =
  | "image"
  | "video"
  | "text"
  | "screenshot"
  | "voice"
  | "location"
  | "other";

export type FragmentVisibility = "private" | "group" | "restricted";
export type FragmentSource = "upload" | "text" | "demo" | "legacy";
export type FragmentStatus = "uploaded" | "processing" | "needs_review" | "processed" | "rejected";
export type FragmentDeletionState = "active" | "pending" | "deleted";
export type MomentStatus = "draft" | "candidate" | "confirmed" | "rejected" | "merged";
export type UncertaintyLabel = "confirmed" | "likely" | "possible" | "unknown";
export type MomentCorrectionType = "person" | "place" | "reference";
export type StoryStatus = "candidate" | "confirmed" | "rejected";
export type StoryRelationship =
  | "shared_people"
  | "same_location"
  | "recurring_theme"
  | "timeline_connection";

export interface StoryEvidence {
  momentId: string;
  momentRevision: number;
  relationship: StoryRelationship;
  fragmentIds: string[];
  fragmentSourceDigests: Array<{ fragmentId: string; sourceContentSha256: string }>;
}

export interface StoryReviewEvent {
  id: string;
  actorUserId: string;
  action: "confirm" | "reject";
  occurredAt: Date;
  beforeStatus: StoryStatus;
  afterStatus: StoryStatus;
}

export interface Story {
  id: string;
  groupId: string;
  title: string;
  summary: string;
  confidence: number;
  uncertaintyLabel: UncertaintyLabel;
  uncertaintyReason: string;
  startAt: Date;
  endAt: Date;
  momentIds: string[];
  evidence: StoryEvidence[];
  status: StoryStatus;
  modelVersion: string;
  reconstructionVersion: string;
  sourceKey: string;
  contextKey: string;
  reviewHistory: StoryReviewEvent[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export type MemberStory = Omit<
  Story,
  "reviewHistory" | "sourceKey" | "contextKey" | "modelVersion" | "reconstructionVersion" | "evidence"
> & {
  evidence: Array<Omit<StoryEvidence, "fragmentSourceDigests">>;
};

export interface StoryReconstructionJob {
  id: string;
  groupId: string;
  requesterUserId: string;
  requestId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  workflowId: string | null;
  storyId: string | null;
  outcome: "candidate" | "insufficient_evidence" | null;
  errorCategory: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MomentCorrection {
  id: string;
  type: MomentCorrectionType;
  fragmentId: string;
  value: string;
}

export interface MomentReviewSnapshot {
  title: string | null;
  summary: string;
  status: MomentStatus;
  uncertaintyLabel: UncertaintyLabel;
  uncertaintyReason: string;
  evidence: MomentEvidence[];
  corrections: MomentCorrection[];
  mergedIntoMomentId: string | null;
}

export interface MomentReviewEvent {
  id: string;
  actorUserId: string;
  action: "confirm" | "reject" | "correct" | "undo_correction" | "remove_evidence" | "merge";
  occurredAt: Date;
  before: MomentReviewSnapshot;
  after: MomentReviewSnapshot;
  details?: {
    correctionType?: MomentCorrectionType;
    fragmentId?: string;
    correctionId?: string;
    value?: string;
    targetMomentId?: string;
    eventId?: string;
  };
}

export interface MomentReconstructionProvenance {
  modelVersion: string;
  retrievalVersion: string;
  validationOutcome: "validated" | "insufficient_evidence";
  contradictions: Array<{
    summary: string;
    evidence: Array<{ fragmentId: string; quote: string }>;
  }>;
  missingEvidence: string[];
  uncertaintyNotes: string[];
  inferenceNotes: string[];
}

export interface FragmentMetadata {
  width?: number;
  height?: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
  mimeType?: string;
  location?: { latitude: number; longitude: number };
}

export interface Fragment {
  id: string;
  groupId: string;
  authorUserId: string;
  type: FragmentType;
  storageUri: string | null;
  caption: string | null;
  textContent: string | null;
  source: FragmentSource;
  capturedTimeZone: string | null;
  checksumSha256: string | null;
  processingVersion: string;
  capturedAt: Date;
  createdAt: Date;
  metadata: FragmentMetadata;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
  aiProcessingConsentAt: Date | null;
  aiProcessingConsentRevokedAt: Date | null;
  transcriptionConsent?: boolean;
  transcriptionConsentAt?: Date | null;
  transcriptionConsentRevokedAt?: Date | null;
  transcriptReviewedAt?: Date | null;
  deletionState: FragmentDeletionState;
  deletionRequestedAt: Date | null;
  deletionRequestedByUserId: string | null;
  status: FragmentStatus;
}

export function hasApprovedTextSource(
  fragment: {
    type: Fragment["type"];
    source: Fragment["source"];
    textContent: string | null;
    transcriptReviewedAt?: Date | string | null;
  },
): boolean {
  if (fragment.type === "text" && fragment.source === "text") {
    return typeof fragment.textContent === "string" && fragment.textContent.trim().length > 0;
  }
  const reviewed = fragment.transcriptReviewedAt instanceof Date
    ? Number.isFinite(fragment.transcriptReviewedAt.getTime())
    : typeof fragment.transcriptReviewedAt === "string" &&
      Number.isFinite(Date.parse(fragment.transcriptReviewedAt));
  return fragment.type === "voice" &&
    fragment.source === "upload" &&
    reviewed &&
    typeof fragment.textContent === "string" &&
    fragment.textContent.trim().length > 0;
}

export function hasAnalyzableFragmentSource(
  fragment: Pick<Fragment, "type" | "source" | "storageUri" | "checksumSha256" | "metadata"> &
    Pick<Fragment, "textContent" | "transcriptReviewedAt">,
): boolean {
  if (hasApprovedTextSource(fragment)) return true;
  return (fragment.type === "image" || fragment.type === "video") &&
    fragment.source === "upload" &&
    typeof fragment.storageUri === "string" &&
    typeof fragment.checksumSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(fragment.checksumSha256) &&
    typeof fragment.metadata.mimeType === "string";
}

export interface NewFragment {
  id?: string;
  groupId: string;
  authorUserId: string;
  type: FragmentType;
  storageUri?: string | null;
  caption?: string | null;
  textContent?: string | null;
  source?: FragmentSource;
  capturedTimeZone?: string | null;
  checksumSha256?: string | null;
  processingVersion?: string;
  capturedAt: Date;
  metadata?: FragmentMetadata;
  visibility?: FragmentVisibility;
  aiProcessingConsent?: boolean;
  transcriptionConsent?: boolean;
}

export interface MomentEvidence {
  fragmentId: string;
  relationship: "temporal" | "shared_people" | "shared_location" | "semantic_similarity" | "entity_overlap";
}

export interface Moment {
  id: string;
  groupId: string;
  title: string | null;
  summary: string;
  confidence: number;
  uncertaintyLabel: UncertaintyLabel;
  uncertaintyReason: string;
  startAt: Date;
  endAt: Date;
  status: MomentStatus;
  evidence: MomentEvidence[];
  reconstruction?: MomentReconstructionProvenance;
  reviewHistory?: MomentReviewEvent[];
  corrections?: MomentCorrection[];
  revision?: number;
  mergedIntoMomentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MemberMoment = Omit<Moment, "reviewHistory"> & {
  canUndoCorrection: boolean;
};

export interface NewMoment {
  groupId: string;
  title?: string | null;
  summary: string;
  confidence: number;
  uncertaintyLabel: UncertaintyLabel;
  uncertaintyReason: string;
  startAt: Date;
  endAt: Date;
  status?: MomentStatus;
  evidence: MomentEvidence[];
}

export interface TemporalFragmentQuery {
  groupId: string;
  startAt: Date;
  endAt: Date;
  excludeFragmentId?: string;
  searchText?: string;
  entityKeys?: string[];
  knownMomentIds?: string[];
  limit?: number;
}

export interface TemporalFragmentCandidate {
  fragmentId: string;
  capturedAt: Date;
  semanticSummary: string;
  entityKeys: string[];
  momentIds: string[];
  retrievalScore: number;
  matchedSignals: Array<"temporal" | "lexical" | "entity_overlap" | "known_moment">;
}