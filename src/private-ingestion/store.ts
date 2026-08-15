import type { Diagnosis } from "../diagnosis";
import type { FollowUpExchange } from "../follow-up";
import type { ReviewAction } from "../review";
import type { ModelUsage } from "../workers-ai-response";
import type { PrivateEvidencePacket } from "./packet";

export const PRIVATE_RUN_INVESTIGATION_LIMIT = 4;
export const PRIVATE_REPOSITORY_HOURLY_LIMIT = 10;
export const PRIVATE_REPOSITORY_DAILY_LIMIT = 50;
export const PRIVATE_HOURLY_WINDOW_MS = 60 * 60_000;
export const PRIVATE_DAILY_WINDOW_MS = 24 * 60 * 60_000;

export type PrivateInvestigationStatus =
  | "queued"
  | "collecting"
  | "diagnosing"
  | "complete"
  | "failed";

export type PrivateWorkflowLaunchState =
  | "pending"
  | "starting"
  | "started"
  | "failed";

export type PrivateReviewedMemory = {
  sourceInvestigationId: string;
  resolution: string;
  diagnosisSummary: string;
  reviewedAt: number;
};

export type PrivateResolutionReview = {
  reviewId: string;
  investigationId: string;
  action: ReviewAction;
  resolution: string | null;
  diagnosisSummary: string;
  evidenceIds: string[];
  createdAt: number;
  memorySaved: boolean;
};

export type PrivateFollowUpReservation =
  | { status: "reserved" | "existing"; exchange: FollowUpExchange }
  | { status: "not_ready" | "limit_reached" | "review_complete" };

export type PrivateReviewResult =
  | { status: "created" | "existing"; review: PrivateResolutionReview }
  | { status: "conflict"; review: PrivateResolutionReview };

export type PrivateInvestigationRecord = {
  investigationId: string;
  deliveryId: string;
  payloadHash: string;
  repository: string;
  repositoryScope: string;
  repositoryMemoryScope: string;
  failureKey: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  status: PrivateInvestigationStatus;
  workflowInstanceId: string;
  workflowLaunchState: PrivateWorkflowLaunchState;
  workflowStartAttempts: number;
  packet: PrivateEvidencePacket;
  evidenceIds: string[];
  diagnosis: Diagnosis | null;
  memoryMatch: PrivateReviewedMemory | null;
  modelCalls: number;
  modelUsage: ModelUsage | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PrivateAdmissionInput = {
  record: PrivateInvestigationRecord;
  nowMs: number;
};

export type PrivateAdmissionResult =
  | { status: "created"; record: PrivateInvestigationRecord }
  | { status: "duplicate"; record: PrivateInvestigationRecord }
  | { status: "payload_conflict"; record: PrivateInvestigationRecord }
  | { status: "workflow_unavailable"; record: PrivateInvestigationRecord }
  | { status: "run_quota_exceeded" }
  | { status: "repository_quota_exceeded"; retryAfterSeconds: number };

/**
 * Implemented by one SQLite-backed Agent instance per repository. Admission,
 * quotas, delivery idempotency, Workflow launch, and model-call reservation are
 * serialized at that repository boundary.
 */
export interface PrivateIngestionStore {
  admit(input: PrivateAdmissionInput): Promise<PrivateAdmissionResult>;
  getInvestigation(investigationId: string): Promise<PrivateInvestigationRecord | null>;
}

export function privateWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function privateRetryAfter(
  nowMs: number,
  start: number,
  windowMs: number,
): number {
  return Math.max(1, Math.ceil((start + windowMs - nowMs) / 1_000));
}
