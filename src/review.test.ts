import { describe, expect, it } from "vitest";

import {
  isMemoryEligible,
  selectReviewedMemoryCandidate,
  type ResolutionReview,
} from "./review";

describe("resolution memory eligibility", () => {
  it("includes only approved review outcomes", () => {
    expect(isMemoryEligible("approve")).toBe(true);
    expect(isMemoryEligible("correct_and_approve")).toBe(true);
    expect(isMemoryEligible("reject")).toBe(false);
  });
});

describe("reviewed memory retrieval", () => {
  const baseReview: ResolutionReview = {
    reviewId: "a".repeat(64),
    sessionId: "b".repeat(64),
    fixtureId: "link-pr-60-package-v1",
    action: "correct_and_approve",
    resolution: "Include .linkignore in the source distribution.",
    diagnosisSummary: "The source distribution omitted a forced include.",
    evidenceIds: ["E-PKG-001"],
    createdAt: 1_786_662_000_000,
    memorySaved: true,
  };

  it("reuses an approved resolution for a separate fixture in the same failure family", () => {
    const match = selectReviewedMemoryCandidate(
      [baseReview],
      "link-pr-60-package-regression-v1",
    );

    expect(match).toMatchObject({
      sourceFixtureId: "link-pr-60-package-v1",
      sourceInvestigationId: "b".repeat(64),
      action: "correct_and_approve",
    });
  });

  it("never retrieves a rejected Windows diagnosis as memory", () => {
    const rejectedWindows: ResolutionReview = {
      ...baseReview,
      fixtureId: "link-pr-60-windows-smoke-v1",
      action: "reject",
      resolution: null,
      memorySaved: false,
    };

    expect(
      selectReviewedMemoryCandidate(
        [rejectedWindows],
        "link-pr-60-package-regression-v1",
      ),
    ).toBeNull();
  });

  it("does not retrieve a review from the current fixture itself", () => {
    expect(
      selectReviewedMemoryCandidate([baseReview], "link-pr-60-package-v1"),
    ).toBeNull();
  });
});
