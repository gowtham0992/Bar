import { Agent } from "agents";

import type { Diagnosis } from "../diagnosis";
import {
  MAX_FOLLOW_UP_CALLS,
  type FollowUpAnswer,
  type FollowUpExchange,
} from "../follow-up";
import type { PrivateEnv } from "../private-env";
import type { ReviewAction } from "../review";
import type { ModelUsage } from "../workers-ai-response";
import {
  assertModelBoundValueSanitized,
  hashPrivatePacket,
  type PrivateEvidencePacket,
} from "./packet";
import {
  derivePrivateFailureKey,
  derivePrivateInvestigationId,
  derivePrivateWorkflowId,
  deriveRepositoryMemoryScope,
  deriveRepositoryScope,
} from "./scopes";
import {
  PRIVATE_DAILY_WINDOW_MS,
  PRIVATE_HOURLY_WINDOW_MS,
  PRIVATE_REPOSITORY_DAILY_LIMIT,
  PRIVATE_REPOSITORY_HOURLY_LIMIT,
  PRIVATE_RUN_INVESTIGATION_LIMIT,
  privateRetryAfter,
  privateWindowStart,
  type PrivateAdmissionInput,
  type PrivateAdmissionResult,
  type PrivateIngestionStore,
  type PrivateInvestigationRecord,
  type PrivateFollowUpReservation,
  type PrivateResolutionReview,
  type PrivateReviewResult,
  type PrivateReviewedMemory,
} from "./store";

export type { PrivateReviewedMemory } from "./store";

type InvestigationRow = {
  investigation_id: string;
  delivery_id: string;
  payload_hash: string;
  repository: string;
  repository_scope: string;
  repository_memory_scope: string;
  failure_key: string;
  run_id: number;
  run_attempt: number;
  job_id: number;
  status: PrivateInvestigationRecord["status"];
  workflow_instance_id: string;
  workflow_launch_state: PrivateInvestigationRecord["workflowLaunchState"];
  workflow_start_attempts: number;
  packet_json: string;
  evidence_ids_json: string;
  diagnosis_json: string | null;
  memory_match_json: string | null;
  model_calls: number;
  model_usage_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type CountRow = { count: number };

type MemoryRow = {
  investigation_id: string;
  resolution: string;
  diagnosis_summary: string;
  reviewed_at: number;
};

type FollowUpRow = {
  follow_up_id: string;
  investigation_id: string;
  question: string;
  status: FollowUpExchange["status"];
  answer: string | null;
  evidence_ids_json: string;
  usage_json: string | null;
  error: string | null;
};

type ReviewRow = {
  review_id: string;
  investigation_id: string;
  action: ReviewAction;
  resolution: string | null;
  diagnosis_summary: string;
  evidence_ids_json: string;
  created_at: number;
  memory_saved: number;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORKFLOW_ID_PATTERN = /^private-[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,80}$/;

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function count(rows: CountRow[]): number {
  return rows.length === 0 ? 0 : Number(rows[0].count);
}

export class PrivateRepositoryAgent
  extends Agent<PrivateEnv, Record<string, never>>
  implements PrivateIngestionStore
{
  initialState: Record<string, never> = {};
  private schemaReady = false;

  async onStart(): Promise<void> {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS private_investigations (
        investigation_id TEXT PRIMARY KEY,
        delivery_id TEXT UNIQUE NOT NULL,
        payload_hash TEXT NOT NULL,
        repository TEXT NOT NULL,
        repository_scope TEXT NOT NULL,
        repository_memory_scope TEXT NOT NULL,
        failure_key TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        run_attempt INTEGER NOT NULL,
        job_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'collecting', 'diagnosing', 'complete', 'failed')
        ),
        workflow_instance_id TEXT UNIQUE NOT NULL,
        workflow_launch_state TEXT NOT NULL DEFAULT 'pending' CHECK (
          workflow_launch_state IN ('pending', 'starting', 'started', 'failed')
        ),
        workflow_start_attempts INTEGER NOT NULL DEFAULT 0,
        packet_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        diagnosis_json TEXT,
        memory_match_json TEXT,
        model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 1),
        model_usage_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS private_run_quota
      ON private_investigations (run_id, run_attempt, created_at)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS private_repository_quota
      ON private_investigations (created_at)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS private_reviewed_resolutions (
        investigation_id TEXT PRIMARY KEY,
        failure_key TEXT NOT NULL,
        resolution TEXT NOT NULL,
        diagnosis_summary TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        FOREIGN KEY (investigation_id)
          REFERENCES private_investigations (investigation_id)
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS private_memory_lookup
      ON private_reviewed_resolutions (failure_key, reviewed_at DESC)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS private_follow_ups (
        follow_up_id TEXT PRIMARY KEY,
        investigation_id TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
        answer TEXT,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (investigation_id)
          REFERENCES private_investigations (investigation_id)
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS private_follow_up_history
      ON private_follow_ups (investigation_id, created_at)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS private_reviews (
        investigation_id TEXT PRIMARY KEY,
        review_id TEXT UNIQUE NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('approve', 'correct_and_approve', 'reject')
        ),
        resolution TEXT,
        diagnosis_summary TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        memory_saved INTEGER NOT NULL CHECK (memory_saved IN (0, 1)),
        FOREIGN KEY (investigation_id)
          REFERENCES private_investigations (investigation_id)
      )
    `;
    this.schemaReady = true;
  }

  async admit(input: PrivateAdmissionInput): Promise<PrivateAdmissionResult> {
    this.ensureSchema();
    await this.validateAdmission(input);
    const existing = this.findByDelivery(input.record.deliveryId);
    if (existing !== null) {
      if (existing.payloadHash !== input.record.payloadHash) {
        return { status: "payload_conflict", record: existing };
      }
      if (existing.workflowLaunchState !== "started") {
        return this.ensureWorkflow(existing, "duplicate");
      }
      return { status: "duplicate", record: existing };
    }

    const { record, nowMs } = input;
    const runAdmissions = count(this.sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM private_investigations
      WHERE run_id = ${record.runId} AND run_attempt = ${record.runAttempt}
    `);
    if (runAdmissions >= PRIVATE_RUN_INVESTIGATION_LIMIT) {
      return { status: "run_quota_exceeded" };
    }

    const hourStart = privateWindowStart(nowMs, PRIVATE_HOURLY_WINDOW_MS);
    const dayStart = privateWindowStart(nowMs, PRIVATE_DAILY_WINDOW_MS);
    const hourlyAdmissions = count(this.sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM private_investigations
      WHERE created_at >= ${hourStart}
    `);
    if (hourlyAdmissions >= PRIVATE_REPOSITORY_HOURLY_LIMIT) {
      return {
        status: "repository_quota_exceeded",
        retryAfterSeconds: privateRetryAfter(
          nowMs,
          hourStart,
          PRIVATE_HOURLY_WINDOW_MS,
        ),
      };
    }
    const dailyAdmissions = count(this.sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM private_investigations
      WHERE created_at >= ${dayStart}
    `);
    if (dailyAdmissions >= PRIVATE_REPOSITORY_DAILY_LIMIT) {
      return {
        status: "repository_quota_exceeded",
        retryAfterSeconds: privateRetryAfter(
          nowMs,
          dayStart,
          PRIVATE_DAILY_WINDOW_MS,
        ),
      };
    }

    this.sql`
      INSERT INTO private_investigations (
        investigation_id,
        delivery_id,
        payload_hash,
        repository,
        repository_scope,
        repository_memory_scope,
        failure_key,
        run_id,
        run_attempt,
        job_id,
        status,
        workflow_instance_id,
        workflow_launch_state,
        workflow_start_attempts,
        packet_json,
        evidence_ids_json,
        diagnosis_json,
        memory_match_json,
        model_calls,
        model_usage_json,
        error,
        created_at,
        updated_at
      ) VALUES (
        ${record.investigationId},
        ${record.deliveryId},
        ${record.payloadHash},
        ${record.repository},
        ${record.repositoryScope},
        ${record.repositoryMemoryScope},
        ${record.failureKey},
        ${record.runId},
        ${record.runAttempt},
        ${record.jobId},
        'queued',
        ${record.workflowInstanceId},
        'pending',
        0,
        ${JSON.stringify(record.packet)},
        ${JSON.stringify(record.evidenceIds)},
        NULL,
        NULL,
        0,
        NULL,
        NULL,
        ${record.createdAt},
        ${record.updatedAt}
      )
    `;
    const inserted = this.findByInvestigation(record.investigationId);
    if (inserted === null) throw new Error("private_investigation_write_failed");
    return this.ensureWorkflow(inserted, "created");
  }

  async getInvestigation(
    investigationId: string,
  ): Promise<PrivateInvestigationRecord | null> {
    this.ensureSchema();
    if (!HASH_PATTERN.test(investigationId)) return null;
    return this.findByInvestigation(investigationId);
  }

  async getFollowUps(investigationId: string): Promise<FollowUpExchange[]> {
    this.ensureSchema();
    if (!HASH_PATTERN.test(investigationId)) return [];
    return this.sql<FollowUpRow>`
      SELECT * FROM private_follow_ups
      WHERE investigation_id = ${investigationId}
      ORDER BY created_at, follow_up_id
    `.map((row) => this.toFollowUp(row));
  }

  async getReview(investigationId: string): Promise<PrivateResolutionReview | null> {
    this.ensureSchema();
    if (!HASH_PATTERN.test(investigationId)) return null;
    const rows = this.sql<ReviewRow>`
      SELECT * FROM private_reviews
      WHERE investigation_id = ${investigationId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toReview(rows[0]);
  }

  async reserveFollowUp(
    investigationId: string,
    followUpId: string,
    question: string,
  ): Promise<PrivateFollowUpReservation> {
    this.ensureSchema();
    if (!HASH_PATTERN.test(investigationId) || !HASH_PATTERN.test(followUpId)) {
      throw new Error("invalid_private_follow_up_identity");
    }
    const record = this.findByInvestigation(investigationId);
    if (record === null || record.status !== "complete" || record.diagnosis === null) {
      return { status: "not_ready" };
    }
    const existing = this.findFollowUp(investigationId, followUpId);
    if (existing !== null) {
      if (existing.question !== question) {
        throw new Error("private_follow_up_conflict");
      }
      return { status: "existing", exchange: existing };
    }
    if (this.findReview(investigationId) !== null) {
      return { status: "review_complete" };
    }
    if (question.trim().length === 0 || question.length > 600) {
      throw new Error("invalid_private_follow_up_question");
    }
    assertModelBoundValueSanitized({ question });
    const calls = count(this.sql<CountRow>`
      SELECT COUNT(*) AS count FROM private_follow_ups
      WHERE investigation_id = ${investigationId}
    `);
    if (calls >= MAX_FOLLOW_UP_CALLS) return { status: "limit_reached" };

    const now = Date.now();
    this.sql`
      INSERT INTO private_follow_ups (
        follow_up_id, investigation_id, question, status, answer,
        evidence_ids_json, usage_json, error, created_at, updated_at
      ) VALUES (
        ${followUpId}, ${investigationId}, ${question.trim()}, 'pending', NULL,
        '[]', NULL, NULL, ${now}, ${now}
      )
    `;
    const exchange = this.findFollowUp(investigationId, followUpId);
    if (exchange === null) throw new Error("private_follow_up_write_failed");
    return { status: "reserved", exchange };
  }

  async completeFollowUp(
    investigationId: string,
    followUpId: string,
    answer: FollowUpAnswer,
    usage: ModelUsage,
  ): Promise<FollowUpExchange> {
    this.ensureSchema();
    const record = this.findByInvestigation(investigationId);
    const existing = this.findFollowUp(investigationId, followUpId);
    if (
      record === null ||
      existing === null ||
      existing.status !== "pending" ||
      answer.evidenceIds.some((id) => !record.evidenceIds.includes(id))
    ) {
      throw new Error("private_follow_up_not_pending");
    }
    assertModelBoundValueSanitized({ answer: answer.answer });
    this.sql`
      UPDATE private_follow_ups
      SET status = 'complete',
          answer = ${answer.answer},
          evidence_ids_json = ${JSON.stringify(answer.evidenceIds)},
          usage_json = ${JSON.stringify(usage)},
          error = NULL,
          updated_at = ${Date.now()}
      WHERE follow_up_id = ${followUpId}
        AND investigation_id = ${investigationId}
        AND status = 'pending'
    `;
    const completed = this.findFollowUp(investigationId, followUpId);
    if (completed === null) throw new Error("private_follow_up_missing");
    return completed;
  }

  async failFollowUp(
    investigationId: string,
    followUpId: string,
  ): Promise<FollowUpExchange> {
    this.ensureSchema();
    const existing = this.findFollowUp(investigationId, followUpId);
    if (existing === null || existing.status !== "pending") {
      throw new Error("private_follow_up_not_pending");
    }
    this.sql`
      UPDATE private_follow_ups
      SET status = 'failed', answer = NULL, evidence_ids_json = '[]',
          usage_json = NULL, error = 'follow_up_failed', updated_at = ${Date.now()}
      WHERE follow_up_id = ${followUpId}
        AND investigation_id = ${investigationId}
        AND status = 'pending'
    `;
    const failed = this.findFollowUp(investigationId, followUpId);
    if (failed === null) throw new Error("private_follow_up_missing");
    return failed;
  }

  async recordReview(input: {
    reviewId: string;
    investigationId: string;
    action: ReviewAction;
    resolution: string | null;
  }): Promise<PrivateReviewResult> {
    this.ensureSchema();
    if (!HASH_PATTERN.test(input.reviewId) || !HASH_PATTERN.test(input.investigationId)) {
      throw new Error("invalid_private_review_identity");
    }
    const record = this.findByInvestigation(input.investigationId);
    if (record === null || record.status !== "complete" || record.diagnosis === null) {
      throw new Error("private_investigation_not_ready");
    }
    const existing = this.findReview(input.investigationId);
    if (existing !== null) {
      return {
        status: existing.reviewId === input.reviewId ? "existing" : "conflict",
        review: existing,
      };
    }
    const pending = count(this.sql<CountRow>`
      SELECT COUNT(*) AS count FROM private_follow_ups
      WHERE investigation_id = ${input.investigationId} AND status = 'pending'
    `);
    if (pending > 0) throw new Error("private_follow_up_pending");
    const memorySaved = input.action !== "reject";
    if (
      (memorySaved &&
        (input.resolution === null ||
          input.resolution.trim().length === 0 ||
          input.resolution.length > 2_000)) ||
      (!memorySaved && input.resolution !== null)
    ) {
      throw new Error("invalid_private_resolution_review");
    }
    if (input.resolution !== null) {
      assertModelBoundValueSanitized({
        resolution: input.resolution,
        diagnosisSummary: record.diagnosis.summary,
      });
      this.saveReviewedResolution(record, input.resolution);
    }
    const now = Date.now();
    this.sql`
      INSERT INTO private_reviews (
        investigation_id, review_id, action, resolution, diagnosis_summary,
        evidence_ids_json, created_at, memory_saved
      ) VALUES (
        ${record.investigationId}, ${input.reviewId}, ${input.action},
        ${input.resolution === null ? null : input.resolution.trim()},
        ${record.diagnosis.summary}, ${JSON.stringify(record.diagnosis.evidenceIds)},
        ${now}, ${memorySaved ? 1 : 0}
      )
    `;
    const review = this.findReview(input.investigationId);
    if (review === null) throw new Error("private_review_write_failed");
    return { status: "created", review };
  }

  async getWorkflowPacket(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<PrivateEvidencePacket> {
    this.ensureSchema();
    const record = this.requireWorkflowRecord(investigationId, workflowInstanceId);
    return record.packet;
  }

  async markCollecting(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<void> {
    this.ensureSchema();
    this.requireWorkflowRecord(investigationId, workflowInstanceId);
    this.sql`
      UPDATE private_investigations
      SET status = CASE
            WHEN status IN ('complete', 'failed') THEN status
            ELSE 'collecting'
          END,
          updated_at = ${Date.now()}
      WHERE investigation_id = ${investigationId}
        AND workflow_instance_id = ${workflowInstanceId}
    `;
  }

  async getReviewedMemory(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<PrivateReviewedMemory | null> {
    this.ensureSchema();
    const record = this.requireWorkflowRecord(investigationId, workflowInstanceId);
    const rows = this.sql<MemoryRow>`
      SELECT investigation_id, resolution, diagnosis_summary, reviewed_at
      FROM private_reviewed_resolutions
      WHERE failure_key = ${record.failureKey}
        AND investigation_id != ${investigationId}
      ORDER BY reviewed_at DESC
      LIMIT 1
    `;
    const memory = rows.length === 0
      ? null
      : {
          sourceInvestigationId: rows[0].investigation_id,
          resolution: rows[0].resolution,
          diagnosisSummary: rows[0].diagnosis_summary,
          reviewedAt: rows[0].reviewed_at,
        };
    this.sql`
      UPDATE private_investigations
      SET memory_match_json = ${memory === null ? null : JSON.stringify(memory)},
          updated_at = ${Date.now()}
      WHERE investigation_id = ${investigationId}
        AND workflow_instance_id = ${workflowInstanceId}
    `;
    return memory;
  }

  async claimModelCall(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<boolean> {
    this.ensureSchema();
    const record = this.requireWorkflowRecord(investigationId, workflowInstanceId);
    if (
      record.modelCalls !== 0 ||
      record.status === "complete" ||
      record.status === "failed"
    ) {
      return false;
    }
    this.sql`
      UPDATE private_investigations
      SET model_calls = 1,
          status = 'diagnosing',
          updated_at = ${Date.now()}
      WHERE investigation_id = ${investigationId}
        AND workflow_instance_id = ${workflowInstanceId}
        AND model_calls = 0
    `;
    return this.findByInvestigation(investigationId)?.modelCalls === 1;
  }

  async completeInvestigation(
    investigationId: string,
    workflowInstanceId: string,
    diagnosis: Diagnosis,
    usage: ModelUsage,
  ): Promise<void> {
    this.ensureSchema();
    const record = this.requireWorkflowRecord(investigationId, workflowInstanceId);
    const allowedEvidence = new Set(record.evidenceIds);
    if (
      record.modelCalls !== 1 ||
      diagnosis.evidenceIds.some((id) => !allowedEvidence.has(id))
    ) {
      throw new Error("invalid_private_diagnosis_completion");
    }
    this.sql`
      UPDATE private_investigations
      SET status = 'complete',
          diagnosis_json = ${JSON.stringify(diagnosis)},
          model_usage_json = ${JSON.stringify(usage)},
          error = NULL,
          updated_at = ${Date.now()}
      WHERE investigation_id = ${investigationId}
        AND workflow_instance_id = ${workflowInstanceId}
    `;
  }

  async failInvestigation(
    investigationId: string,
    workflowInstanceId: string,
    errorCode: string,
  ): Promise<void> {
    this.ensureSchema();
    this.requireWorkflowRecord(investigationId, workflowInstanceId);
    if (!ERROR_CODE_PATTERN.test(errorCode)) {
      throw new Error("invalid_private_workflow_error");
    }
    this.sql`
      UPDATE private_investigations
      SET status = CASE WHEN status = 'complete' THEN status ELSE 'failed' END,
          error = CASE WHEN status = 'complete' THEN error ELSE ${errorCode} END,
          updated_at = ${Date.now()}
      WHERE investigation_id = ${investigationId}
        AND workflow_instance_id = ${workflowInstanceId}
    `;
  }

  async recordApprovedResolution(input: {
    investigationId: string;
    resolution: string;
  }): Promise<void> {
    this.ensureSchema();
    const record = this.findByInvestigation(input.investigationId);
    if (
      record === null ||
      record.status !== "complete" ||
      record.diagnosis === null ||
      input.resolution.trim().length === 0 ||
      input.resolution.length > 2_000
    ) {
      throw new Error("invalid_private_resolution_review");
    }
    assertModelBoundValueSanitized({
      resolution: input.resolution,
      diagnosisSummary: record.diagnosis.summary,
    });
    this.saveReviewedResolution(record, input.resolution);
  }

  private saveReviewedResolution(
    record: PrivateInvestigationRecord,
    resolution: string,
  ): void {
    if (record.diagnosis === null) throw new Error("private_diagnosis_missing");
    this.sql`
      INSERT INTO private_reviewed_resolutions (
        investigation_id,
        failure_key,
        resolution,
        diagnosis_summary,
        reviewed_at
      ) VALUES (
        ${record.investigationId},
        ${record.failureKey},
        ${resolution.trim()},
        ${record.diagnosis.summary},
        ${Date.now()}
      ) ON CONFLICT (investigation_id) DO NOTHING
    `;
  }

  private async validateAdmission(input: PrivateAdmissionInput): Promise<void> {
    const { record } = input;
    const [
      expectedRepositoryScope,
      expectedMemoryScope,
      expectedInvestigationId,
      expectedFailureKey,
      expectedPayloadHash,
    ] = await Promise.all([
      deriveRepositoryScope(record.repository),
      deriveRepositoryMemoryScope(record.repository),
      derivePrivateInvestigationId(record.repository, record.deliveryId),
      derivePrivateFailureKey({
        repository: record.repository,
        workflowPath: record.packet.source.workflow.path,
        jobName: record.packet.focus.job_name,
        failedStep: record.packet.focus.failed_step,
      }),
      hashPrivatePacket(record.packet),
    ]);
    if (
      record.repositoryScope !== this.name ||
      record.repositoryScope !== expectedRepositoryScope ||
      record.repositoryMemoryScope !== expectedMemoryScope ||
      record.investigationId !== expectedInvestigationId ||
      record.failureKey !== expectedFailureKey ||
      record.payloadHash !== expectedPayloadHash ||
      record.workflowInstanceId !== derivePrivateWorkflowId(record.investigationId) ||
      record.packet.source.repository !== record.repository ||
      !HASH_PATTERN.test(record.investigationId) ||
      !HASH_PATTERN.test(record.deliveryId) ||
      !HASH_PATTERN.test(record.payloadHash) ||
      !HASH_PATTERN.test(record.failureKey) ||
      !WORKFLOW_ID_PATTERN.test(record.workflowInstanceId) ||
      record.status !== "queued" ||
      record.workflowLaunchState !== "pending" ||
      record.workflowStartAttempts !== 0 ||
      record.modelCalls !== 0 ||
      record.diagnosis !== null ||
      record.memoryMatch !== null ||
      record.modelUsage !== null ||
      record.error !== null ||
      record.evidenceIds.length < 1 ||
      JSON.stringify(record.evidenceIds) !==
        JSON.stringify(record.packet.evidence.map((item) => item.id))
    ) {
      throw new Error("invalid_private_admission");
    }
  }

  private async ensureWorkflow(
    record: PrivateInvestigationRecord,
    admittedAs: "created" | "duplicate",
  ): Promise<PrivateAdmissionResult> {
    const attempts = record.workflowStartAttempts + 1;
    this.sql`
      UPDATE private_investigations
      SET workflow_start_attempts = ${attempts},
          workflow_launch_state = 'starting',
          status = 'queued',
          error = NULL,
          updated_at = ${Date.now()}
      WHERE investigation_id = ${record.investigationId}
    `;
    try {
      await this.env.PRIVATE_INVESTIGATION_WORKFLOW.create({
        id: record.workflowInstanceId,
        params: {
          investigationId: record.investigationId,
          repositoryScope: record.repositoryScope,
        },
      });
    } catch {
      try {
        const existing = await this.env.PRIVATE_INVESTIGATION_WORKFLOW.get(
          record.workflowInstanceId,
        );
        const status = await existing.status();
        if (status.status === "unknown") throw new Error("workflow_not_found");
      } catch {
        this.sql`
          UPDATE private_investigations
          SET status = 'failed',
              workflow_launch_state = 'failed',
              error = 'workflow_start_unavailable',
              updated_at = ${Date.now()}
          WHERE investigation_id = ${record.investigationId}
        `;
        const failed = this.findByInvestigation(record.investigationId);
        if (failed === null) throw new Error("private_investigation_missing");
        return { status: "workflow_unavailable", record: failed };
      }
    }
    this.sql`
      UPDATE private_investigations
      SET workflow_launch_state = 'started',
          updated_at = ${Date.now()}
      WHERE investigation_id = ${record.investigationId}
    `;
    const started = this.findByInvestigation(record.investigationId);
    if (started === null) throw new Error("private_investigation_missing");
    return { status: admittedAs, record: started };
  }

  private requireWorkflowRecord(
    investigationId: string,
    workflowInstanceId: string,
  ): PrivateInvestigationRecord {
    if (
      !HASH_PATTERN.test(investigationId) ||
      !WORKFLOW_ID_PATTERN.test(workflowInstanceId)
    ) {
      throw new Error("invalid_private_workflow_identity");
    }
    const record = this.findByInvestigation(investigationId);
    if (
      record === null ||
      record.workflowInstanceId !== workflowInstanceId ||
      !["starting", "started"].includes(record.workflowLaunchState)
    ) {
      throw new Error("private_workflow_not_authorized");
    }
    return record;
  }

  private findByDelivery(deliveryId: string): PrivateInvestigationRecord | null {
    const rows = this.sql<InvestigationRow>`
      SELECT * FROM private_investigations
      WHERE delivery_id = ${deliveryId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toRecord(rows[0]);
  }

  private findByInvestigation(
    investigationId: string,
  ): PrivateInvestigationRecord | null {
    const rows = this.sql<InvestigationRow>`
      SELECT * FROM private_investigations
      WHERE investigation_id = ${investigationId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toRecord(rows[0]);
  }

  private findFollowUp(
    investigationId: string,
    followUpId: string,
  ): FollowUpExchange | null {
    const rows = this.sql<FollowUpRow>`
      SELECT * FROM private_follow_ups
      WHERE follow_up_id = ${followUpId}
        AND investigation_id = ${investigationId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toFollowUp(rows[0]);
  }

  private findReview(investigationId: string): PrivateResolutionReview | null {
    const rows = this.sql<ReviewRow>`
      SELECT * FROM private_reviews
      WHERE investigation_id = ${investigationId}
      LIMIT 1
    `;
    return rows.length === 0 ? null : this.toReview(rows[0]);
  }

  private toFollowUp(row: FollowUpRow): FollowUpExchange {
    return {
      id: row.follow_up_id,
      question: row.question,
      status: row.status,
      answer: row.answer,
      evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
      usage: parseJson<ModelUsage>(row.usage_json),
      error: row.error,
    };
  }

  private toReview(row: ReviewRow): PrivateResolutionReview {
    return {
      reviewId: row.review_id,
      investigationId: row.investigation_id,
      action: row.action,
      resolution: row.resolution,
      diagnosisSummary: row.diagnosis_summary,
      evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
      createdAt: row.created_at,
      memorySaved: row.memory_saved === 1,
    };
  }

  private toRecord(row: InvestigationRow): PrivateInvestigationRecord {
    return {
      investigationId: row.investigation_id,
      deliveryId: row.delivery_id,
      payloadHash: row.payload_hash,
      repository: row.repository,
      repositoryScope: row.repository_scope,
      repositoryMemoryScope: row.repository_memory_scope,
      failureKey: row.failure_key,
      runId: row.run_id,
      runAttempt: row.run_attempt,
      jobId: row.job_id,
      status: row.status,
      workflowInstanceId: row.workflow_instance_id,
      workflowLaunchState: row.workflow_launch_state,
      workflowStartAttempts: row.workflow_start_attempts,
      packet: JSON.parse(row.packet_json) as PrivateEvidencePacket,
      evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
      diagnosis: parseJson<Diagnosis>(row.diagnosis_json),
      memoryMatch: parseJson<PrivateReviewedMemory>(row.memory_match_json),
      modelCalls: row.model_calls,
      modelUsage: parseJson<ModelUsage>(row.model_usage_json),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
