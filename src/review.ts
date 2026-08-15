import { getMemoryKey, type FixtureId } from "./fixture-data";

export type ReviewAction = "approve" | "correct_and_approve" | "reject";

export type ResolutionReview = {
  reviewId: string;
  sessionId: string;
  fixtureId: FixtureId;
  action: ReviewAction;
  resolution: string | null;
  diagnosisSummary: string;
  evidenceIds: string[];
  createdAt: number;
  memorySaved: boolean;
};

export type ReviewedMemoryMatch = {
  reviewId: string;
  sourceInvestigationId: string;
  sourceFixtureId: FixtureId;
  action: Extract<ReviewAction, "approve" | "correct_and_approve">;
  resolution: string;
  diagnosisSummary: string;
  reviewedAt: number;
};

export function isMemoryEligible(
  action: ReviewAction,
): action is Extract<ReviewAction, "approve" | "correct_and_approve"> {
  return action === "approve" || action === "correct_and_approve";
}

export function selectReviewedMemoryCandidate(
  reviews: readonly ResolutionReview[],
  currentFixtureId: FixtureId,
): ReviewedMemoryMatch | null {
  const currentMemoryKey = getMemoryKey(currentFixtureId);
  for (const review of reviews) {
    if (
      !isMemoryEligible(review.action) ||
      review.resolution === null ||
      review.fixtureId === currentFixtureId ||
      getMemoryKey(review.fixtureId) !== currentMemoryKey
    ) {
      continue;
    }
    return {
      reviewId: review.reviewId,
      sourceInvestigationId: review.sessionId,
      sourceFixtureId: review.fixtureId,
      action: review.action,
      resolution: review.resolution,
      diagnosisSummary: review.diagnosisSummary,
      reviewedAt: review.createdAt,
    };
  }
  return null;
}
