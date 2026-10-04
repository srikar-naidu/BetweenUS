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
export type FragmentStatus = "uploaded" | "processing" | "processed" | "rejected";
export type FragmentDeletionState = "active" | "pending" | "deleted";
export type MomentStatus = "draft" | "candidate" | "confirmed" | "rejected" | "merged";
export type UncertaintyLabel = "confirmed" | "likely" | "possible" | "unknown";
export type MomentCorrectionType = "person" | "place" | "reference";

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
  deletionState: FragmentDeletionState;
  deletionRequestedAt: Date | null;
  deletionRequestedByUserId: string | null;
  status: FragmentStatus;
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