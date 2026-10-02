export type FragmentType =
  | "image"
  | "video"
  | "text"
  | "screenshot"
  | "voice"
  | "location"
  | "other";

export type FragmentVisibility = "private" | "group" | "restricted";
export type FragmentStatus = "uploaded" | "processing" | "processed" | "rejected";
export type MomentStatus = "draft" | "candidate" | "confirmed" | "rejected";
export type UncertaintyLabel = "confirmed" | "likely" | "possible" | "unknown";

export interface FragmentMetadata {
  width?: number;
  height?: number;
  durationSeconds?: number;
  mimeType?: string;
  location?: { latitude: number; longitude: number };
}

export interface Fragment {
  id: string;
  groupId: string;
  authorUserId: string;
  type: FragmentType;
  storageUri: string;
  caption: string | null;
  capturedAt: Date;
  createdAt: Date;
  metadata: FragmentMetadata;
  visibility: FragmentVisibility;
  status: FragmentStatus;
}

export interface NewFragment {
  groupId: string;
  authorUserId: string;
  type: FragmentType;
  storageUri: string;
  caption?: string | null;
  capturedAt: Date;
  metadata?: FragmentMetadata;
  visibility?: FragmentVisibility;
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
  startAt: Date;
  endAt: Date;
  status: MomentStatus;
  evidence: MomentEvidence[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMoment {
  groupId: string;
  title?: string | null;
  summary: string;
  confidence: number;
  uncertaintyLabel: UncertaintyLabel;
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
  limit?: number;
}

export interface TemporalFragmentCandidate {
  fragmentId: string;
  capturedAt: Date;
  semanticSummary: string;
  entityKeys: string[];
}