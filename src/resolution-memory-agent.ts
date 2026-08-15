import { Agent } from "agents";

import type { Env } from "./env";
import { isFixtureId } from "./fixture-data";
import {
  isMemoryEligible,
  selectReviewedMemoryCandidate,
  type ResolutionReview,
  type ReviewedMemoryMatch,
  type ReviewAction,
} from "./review";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

type ReviewRow = {
  review_id: string;
  session_id: string;
  fixture_id: string;
  action: string;
  resolution: string | null;
  diagnosis_summary: string;
  evidence_ids: string;
  created_at: number;
};

export type RecordReviewInput = Omit<
  ResolutionReview,
  "createdAt" | "memorySaved"
>;

export type RecordReviewResult =
  | { status: "created" | "duplicate"; review: ResolutionReview }
  | { status: "conflict"; review: ResolutionReview };

export class ResolutionMemoryAgent extends Agent<Env, Record<string, never>> {
  initialState: Record<string, never> = {};

  async onStart(): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS resolution_reviews (
        session_id TEXT PRIMARY KEY,
        review_id TEXT UNIQUE NOT NULL,
        fixture_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('approve', 'correct_and_approve', 'reject')
        ),
        resolution TEXT,
        diagnosis_summary TEXT NOT NULL,
        evidence_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK (
          (action = 'reject' AND resolution IS NULL) OR
          (action != 'reject' AND resolution IS NOT NULL)
        )
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS approved_resolution_lookup
      ON resolution_reviews (fixture_id, created_at DESC)
      WHERE action IN ('approve', 'correct_and_approve')
    `;
  }

  async recordReview(input: RecordReviewInput): Promise<RecordReviewResult> {
    this.validate(input);
    const existing = this.findBySession(input.sessionId);
    if (existing !== null) {
      return {
        status: existing.reviewId === input.reviewId ? "duplicate" : "conflict",
        review: existing,
      };
    }

    const createdAt = Date.now();
    this.sql`
      INSERT INTO resolution_reviews (
        session_id,
        review_id,
        fixture_id,
        action,
        resolution,
        diagnosis_summary,
        evidence_ids,
        created_at
      ) VALUES (
        ${input.sessionId},
        ${input.reviewId},
        ${input.fixtureId},
        ${input.action},
        ${input.resolution},
        ${input.diagnosisSummary},
        ${JSON.stringify(input.evidenceIds)},
        ${createdAt}
      )
    `;
    const review = this.findBySession(input.sessionId);
    if (review === null) throw new Error("review_write_failed");
    return { status: "created", review };
  }

  async getReview(sessionId: string): Promise<ResolutionReview | null> {
    if (!HASH_PATTERN.test(sessionId)) return null;
    return this.findBySession(sessionId);
  }

  async getLatestApprovedForFixture(
    fixtureId: string,
  ): Promise<ReviewedMemoryMatch | null> {
    if (!isFixtureId(fixtureId)) return null;
    const rows = this.sql<ReviewRow>`
      SELECT *
      FROM resolution_reviews
      WHERE action IN ('approve', 'correct_and_approve')
        AND fixture_id != ${fixtureId}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const reviews = rows
      .filter((row) => isFixtureId(row.fixture_id))
      .map((row) => this.toReview(row));
    return selectReviewedMemoryCandidate(reviews, fixtureId);
  }

  private findBySession(sessionId: string): ResolutionReview | null {
    const rows = this.sql<ReviewRow>`
      SELECT *
      FROM resolution_reviews
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toReview(rows[0]);
  }

  private toReview(row: ReviewRow): ResolutionReview {
    const action = row.action as ReviewAction;
    return {
      reviewId: row.review_id,
      sessionId: row.session_id,
      fixtureId: row.fixture_id as ResolutionReview["fixtureId"],
      action,
      resolution: row.resolution,
      diagnosisSummary: row.diagnosis_summary,
      evidenceIds: JSON.parse(row.evidence_ids) as string[],
      createdAt: row.created_at,
      memorySaved: isMemoryEligible(action),
    };
  }

  private validate(input: RecordReviewInput): void {
    if (!HASH_PATTERN.test(input.reviewId)) throw new Error("invalid_review_id");
    if (!HASH_PATTERN.test(input.sessionId)) throw new Error("invalid_session_id");
    if (!isFixtureId(input.fixtureId)) throw new Error("invalid_fixture_id");
    if (!(["approve", "correct_and_approve", "reject"] as string[]).includes(input.action)) {
      throw new Error("invalid_review_action");
    }
    if (
      input.diagnosisSummary.length < 1 ||
      input.diagnosisSummary.length > 500 ||
      input.evidenceIds.length < 1 ||
      input.evidenceIds.length > 8
    ) {
      throw new Error("invalid_review_evidence");
    }
    const shouldHaveResolution = isMemoryEligible(input.action);
    if (
      shouldHaveResolution !== (input.resolution !== null) ||
      (input.resolution !== null &&
        (input.resolution.length < 1 || input.resolution.length > 2_000))
    ) {
      throw new Error("invalid_review_resolution");
    }
  }
}
