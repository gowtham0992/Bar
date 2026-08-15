import { describe, expect, it } from "vitest";

import evidenceJson from "../fixtures/public/link-pr-60-package-v1/evidence.json";
import fixtureJson from "../fixtures/public/link-pr-60-package-v1/fixture.json";
import type { Diagnosis } from "./diagnosis";
import type { FollowUpAnswer, FollowUpExchange } from "./follow-up";
import {
  handlePrivateApiRequest,
  type PrivateRepositoryApi,
} from "./private-api";
import type {
  PrivateEvidenceItem,
  PrivateEvidencePacket,
} from "./private-ingestion/packet";
import type {
  PrivateFollowUpReservation,
  PrivateInvestigationRecord,
  PrivateResolutionReview,
  PrivateReviewResult,
} from "./private-ingestion/store";
import type { ReviewAction } from "./review";
import type { ModelUsage } from "./workers-ai-response";

const INVESTIGATION_ID = "a".repeat(64);
const WORKFLOW_ID = `private-${INVESTIGATION_ID}`;
const USAGE = { promptTokens: 100, completionTokens: 30, totalTokens: 130 };
const diagnosis: Diagnosis = {
  outcome: "diagnosed",
  summary: "The package build cannot find .linkignore.",
  explanation: "The forced include references a file absent from the build context.",
  confidence: 0.91,
  evidenceIds: ["E-PKG-001", "E-PKG-002"],
  uncertainty: "The repair has not been executed.",
  proposedResolution: "Include .linkignore in the source distribution.",
  memoryAssessment: "not_available",
  memoryExplanation: "No reviewed memory was supplied.",
};

function packet(): PrivateEvidencePacket {
  return {
    schema_version: 1,
    capture: {
      code_repository: "gowtham0992/link",
      code_ref: "refs/heads/main",
      code_sha: "b".repeat(40),
      workflow_path: ".github/workflows/bar-investigate.yml",
    },
    delivery: {
      id: "c".repeat(64),
      producer: "link-bar-action/v1",
      sent_at: "2026-08-14T20:00:00Z",
    },
    source: {
      repository: "gowtham0992/link",
      workflow: { id: 99, name: "CI", path: ".github/workflows/ci.yml" },
      run: {
        id: 600060001,
        attempt: 1,
        event: "pull_request",
        head_sha: fixtureJson.run.head_sha,
        html_url: "https://github.com/gowtham0992/link/actions/runs/600060001",
      },
      pull_request: {
        number: 60,
        base_sha: fixtureJson.run.base_sha,
        head_sha: fixtureJson.run.head_sha,
      },
    },
    focus: {
      job_id: 600060002,
      job_name: fixtureJson.focus.job,
      failed_step: fixtureJson.focus.failed_step,
    },
    job_summary: fixtureJson.job_summary,
    change_summary: fixtureJson.change_summary,
    evidence: structuredClone(evidenceJson) as PrivateEvidenceItem[],
    missing_evidence: [],
    sanitization: {
      version: 1,
      truncated: false,
      redaction_counts: { credential: 0, email: 0, environment: 0, path: 10, url: 0 },
    },
  };
}

function record(): PrivateInvestigationRecord {
  return {
    investigationId: INVESTIGATION_ID,
    deliveryId: "c".repeat(64),
    payloadHash: "d".repeat(64),
    repository: "gowtham0992/link",
    repositoryScope: "e".repeat(64),
    repositoryMemoryScope: "f".repeat(64),
    failureKey: "1".repeat(64),
    runId: 600060001,
    runAttempt: 1,
    jobId: 600060002,
    status: "complete",
    workflowInstanceId: WORKFLOW_ID,
    workflowLaunchState: "started",
    workflowStartAttempts: 1,
    packet: packet(),
    evidenceIds: ["E-PKG-001", "E-PKG-002", "E-PKG-003", "E-PKG-004"],
    diagnosis,
    memoryMatch: null,
    modelCalls: 1,
    modelUsage: USAGE,
    error: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

class FakePrivateAgent implements PrivateRepositoryApi {
  readonly followUps: FollowUpExchange[] = [];
  review: PrivateResolutionReview | null = null;

  async getInvestigation(id: string) {
    return id === INVESTIGATION_ID ? record() : null;
  }

  async getFollowUps() {
    return structuredClone(this.followUps);
  }

  async getReview() {
    return structuredClone(this.review);
  }

  async reserveFollowUp(
    _investigationId: string,
    followUpId: string,
    question: string,
  ): Promise<PrivateFollowUpReservation> {
    const existing = this.followUps.find((item) => item.id === followUpId);
    if (existing) return { status: "existing", exchange: structuredClone(existing) };
    if (this.review) return { status: "review_complete" };
    const exchange: FollowUpExchange = {
      id: followUpId,
      question,
      status: "pending",
      answer: null,
      evidenceIds: [],
      usage: null,
      error: null,
    };
    this.followUps.push(exchange);
    return { status: "reserved", exchange: structuredClone(exchange) };
  }

  async completeFollowUp(
    _investigationId: string,
    followUpId: string,
    answer: FollowUpAnswer,
    usage: ModelUsage,
  ) {
    const exchange = this.followUps.find((item) => item.id === followUpId);
    if (!exchange) throw new Error("missing follow-up");
    Object.assign(exchange, {
      status: "complete",
      answer: answer.answer,
      evidenceIds: answer.evidenceIds,
      usage,
    });
    return structuredClone(exchange);
  }

  async failFollowUp(_investigationId: string, followUpId: string) {
    const exchange = this.followUps.find((item) => item.id === followUpId);
    if (!exchange) throw new Error("missing follow-up");
    exchange.status = "failed";
    exchange.error = "follow_up_failed";
    return structuredClone(exchange);
  }

  async recordReview(input: {
    reviewId: string;
    investigationId: string;
    action: ReviewAction;
    resolution: string | null;
  }): Promise<PrivateReviewResult> {
    if (this.review) {
      return {
        status: this.review.reviewId === input.reviewId ? "existing" : "conflict",
        review: structuredClone(this.review),
      };
    }
    this.review = {
      reviewId: input.reviewId,
      investigationId: input.investigationId,
      action: input.action,
      resolution: input.resolution,
      diagnosisSummary: diagnosis.summary,
      evidenceIds: diagnosis.evidenceIds,
      createdAt: 3,
      memorySaved: input.action !== "reject",
    };
    return { status: "created", review: structuredClone(this.review) };
  }
}

function dependencies(agent: FakePrivateAgent, onAiCall: () => void) {
  return {
    repositoryAgent: async () => agent,
    ai: {
      async run() {
        onAiCall();
        return {
          response: JSON.stringify({
            answer: "The log and packaging diff identify the missing forced include.",
            evidenceIds: ["E-PKG-001", "E-PKG-002"],
          }),
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        };
      },
    } as unknown as Ai,
  };
}

function request(path: string, body: unknown, key = "k".repeat(32)) {
  return new Request(`https://bar-private.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

describe("private investigation API", () => {
  it("returns progress, diagnosis, evidence, citations, and model usage", async () => {
    const agent = new FakePrivateAgent();
    const response = await handlePrivateApiRequest(
      new Request(`https://bar-private.example/api/v1/private/investigations/${INVESTIGATION_ID}`),
      dependencies(agent, () => undefined),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json() as any;
    expect(body.investigation).toMatchObject({
      id: INVESTIGATION_ID,
      status: "complete",
      modelCalls: 1,
      modelUsage: USAGE,
      diagnosis: { evidenceIds: ["E-PKG-001", "E-PKG-002"] },
    });
    expect(body.investigation.evidence).toHaveLength(4);
    expect(body.investigation.milestones.every((item: any) => item.status === "complete"))
      .toBe(true);
  });

  it("uses one AI call for an idempotent follow-up and closes chat after review", async () => {
    const agent = new FakePrivateAgent();
    let aiCalls = 0;
    const deps = dependencies(agent, () => { aiCalls += 1; });
    const path = `/api/v1/private/investigations/${INVESTIGATION_ID}/follow-ups`;
    const first = await handlePrivateApiRequest(
      request(path, { question: "What supports this resolution?" }),
      deps,
    );
    const duplicate = await handlePrivateApiRequest(
      request(path, { question: "What supports this resolution?" }),
      deps,
    );
    expect(first?.status).toBe(201);
    expect(duplicate?.status).toBe(200);
    expect(aiCalls).toBe(1);
    expect((await first?.json() as any).followUp.evidenceIds).toEqual([
      "E-PKG-001",
      "E-PKG-002",
    ]);

    const reviewPath = `/api/v1/private/investigations/${INVESTIGATION_ID}/review`;
    const reviewed = await handlePrivateApiRequest(
      request(reviewPath, { action: "approve" }, "r".repeat(32)),
      deps,
    );
    expect(reviewed?.status).toBe(201);
    expect((await reviewed?.json() as any).review.memorySaved).toBe(true);

    await expect(
      handlePrivateApiRequest(
        request(path, { question: "Can I ask again?" }, "q".repeat(32)),
        deps,
      ),
    ).rejects.toMatchObject({ code: "review_complete", status: 409 });
    expect(aiCalls).toBe(1);
  });
});
