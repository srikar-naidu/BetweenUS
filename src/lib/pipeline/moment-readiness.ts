import { hasApprovedTextSource, type Fragment } from "@/lib/domain/memory";

const MOMENT_RECONSTRUCTION_WINDOW_MS = 20 * 60_000;

export type MomentReadinessFragment = Pick<
  Fragment,
  | "id"
  | "authorUserId"
  | "capturedAt"
  | "visibility"
  | "aiProcessingConsent"
  | "deletionState"
  | "status"
  | "type"
  | "source"
  | "checksumSha256"
  | "metadata"
  | "textContent"
  | "transcriptReviewedAt"
> & {
  mediaStorageAvailable?: boolean;
};

export function fragmentCanJoinMomentReconstruction(
  fragment: MomentReadinessFragment,
): boolean {
  const hasSource = hasApprovedTextSource(fragment) ||
    ((fragment.type === "image" || fragment.type === "video") &&
      fragment.source === "upload" &&
      typeof fragment.checksumSha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(fragment.checksumSha256) &&
      typeof fragment.metadata.mimeType === "string" &&
      fragment.mediaStorageAvailable === true);
  return fragment.visibility === "group" &&
    fragment.aiProcessingConsent &&
    fragment.deletionState === "active" &&
    (fragment.status === "processed" || fragment.status === "needs_review") &&
    hasSource;
}

export function hasIndependentMomentPeer(
  fragment: MomentReadinessFragment,
  fragments: readonly MomentReadinessFragment[],
): boolean {
  if (!fragmentCanJoinMomentReconstruction(fragment)) return false;
  const capturedAt = fragment.capturedAt.getTime();
  return fragments.some((peer) =>
    peer.id !== fragment.id &&
    peer.authorUserId !== fragment.authorUserId &&
    fragmentCanJoinMomentReconstruction(peer) &&
    Math.abs(peer.capturedAt.getTime() - capturedAt) <= MOMENT_RECONSTRUCTION_WINDOW_MS,
  );
}

export function momentReconstructionReadyFragments(
  fragments: readonly MomentReadinessFragment[],
): MomentReadinessFragment[] {
  return fragments.filter((fragment) => hasIndependentMomentPeer(fragment, fragments));
}
