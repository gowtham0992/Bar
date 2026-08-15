import { describe, expect, it } from "vitest";

import packageEvidenceJson from "../../fixtures/public/link-pr-60-package-v1/evidence.json";
import packageFixtureJson from "../../fixtures/public/link-pr-60-package-v1/fixture.json";
import type { Diagnosis } from "../diagnosis";
import type { ModelUsage } from "../workers-ai-response";
import {
  executePrivateInvestigation,
  type PrivateDiagnosisWorkflowAgent,
  type PrivateWorkflowStep,
} from "./private-workflow-execution";
import type {
  PrivateEvidenceItem,
  PrivateEvidencePacket,
  RedactionCounts,
} from "./packet";
import type { PrivateReviewedMemory } from "./repository-agent";

function addRedactions(items: PrivateEvidenceItem[]): RedactionCounts {
  return items.reduce<RedactionCounts>(
    (total, item) => ({
      credential: total.credential + item.redactions.credential,
      email: total.email + item.redactions.email,
      environment: total.environment + item.redactions.environment,
      path: total.path + item.redactions.path,
      url: total.url + item.redactions.url,
    }),
    { credential: 0, email: 0, environment: 0, path: 0, url: 0 },
  );
}

function packet(): PrivateEvidencePacket {
  const fixture = structuredClone(packageFixtureJson);
  const evidence = structuredClone(packageEvidenceJson) as PrivateEvidenceItem[];
  return {
    schema_version: 1,
    capture: {
      code_repository: "gowtham0992/link",
      code_ref: "refs/heads/main",
      code_sha: "a".repeat(40),
      workflow_path: ".github/workflows/bar-investigate.yml",
    },
    delivery: {
      id: "b".repeat(64),
      producer: "link-bar-action/v1",
      sent_at: "2026-08-13T18:00:00Z",
    },
    source: {
      repository: "gowtham0992/link",
      workflow: { id: 99, name: "CI", path: ".github/workflows/ci.yml" },
      run: {
        id: 100_060,
        attempt: 1,
        event: "pull_request",
        head_sha: fixture.run.head_sha,
        html_url: "https://github.com/gowtham0992/link/actions/runs/100060",
      },
      pull_request: {
        number: fixture.source.pull_request,
        base_sha: fixture.run.base_sha,
        head_sha: fixture.run.head_sha,
      },
    },
    focus: {
      job_id: 200_060,
      job_name: fixture.focus.job,
      failed_step: fixture.focus.failed_step,
    },
    job_summary: fixture.job_summary,
    change_summary: fixture.change_summary,
    evidence,
    missing_evidence: fixture.missing_evidence,
    sanitization: {
      version: 1,
      truncated: false,
      redaction_counts: addRedactions(evidence),
    },
  };
}

const diagnosis: Diagnosis = {
  outcome: "diagnosed",
  summary: "The sdist omits a required file.",
  explanation: "The package configuration requires the missing file.",
  confidence: 0.93,
  evidenceIds: ["E-PKG-001", "E-PKG-002"],
  uncertainty: "The repair has not yet been executed.",
  proposedResolution: "Include .linkignore in the sdist and rebuild the wheel.",
  memoryAssessment: "not_available",
  memoryExplanation: "No reviewed repository memory was supplied.",
};

class RetryingStep implements PrivateWorkflowStep {
  readonly attempts = new Map<string, number>();

  async do<T>(
    name: string,
    configOrCallback: unknown,
    maybeCallback?: () => Promise<T>,
  ): Promise<T> {
    const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
    const callback = (typeof configOrCallback === "function"
      ? configOrCallback
      : maybeCallback) as () => Promise<T>;
    const limit =
      typeof config === "object" && config !== null && "retries" in config
        ? Number((config as { retries: { limit: number } }).retries.limit)
        : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      this.attempts.set(name, attempt);
      try {
        return await callback();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

function workflowAgent(options: {
  loadFailures?: number;
  failedStateSaveFailures?: number;
  claim?: boolean;
  memory?: PrivateReviewedMemory | null;
} = {}) {
  let remainingLoadFailures = options.loadFailures ?? 0;
  let remainingFailedStateSaveFailures = options.failedStateSaveFailures ?? 0;
  const calls = {
    load: 0,
    memory: 0,
    claim: 0,
    complete: 0,
    fail: [] as string[],
  };
  const agent: PrivateDiagnosisWorkflowAgent = {
    async getWorkflowPacket() {
      calls.load += 1;
      if (remainingLoadFailures > 0) {
        remainingLoadFailures -= 1;
        throw new Error("transient_agent_read");
      }
      return packet();
    },
    async markCollecting() {},
    async getReviewedMemory() {
      calls.memory += 1;
      return options.memory ?? null;
    },
    async claimModelCall() {
      calls.claim += 1;
      return options.claim ?? true;
    },
    async completeInvestigation(
      _investigationId: string,
      _workflowInstanceId: string,
      _diagnosis: Diagnosis,
      _usage: ModelUsage,
    ) {
      calls.complete += 1;
    },
    async failInvestigation(
      _investigationId: string,
      _workflowInstanceId: string,
      errorCode: string,
    ) {
      if (remainingFailedStateSaveFailures > 0) {
        remainingFailedStateSaveFailures -= 1;
        throw new Error("transient_agent_write");
      }
      calls.fail.push(errorCode);
    },
  };
  return { agent, calls };
}

function ai(response: unknown, onRun: () => void = () => {}) {
  return {
    async run() {
      onRun();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe("private diagnosis Workflow", () => {
  it("retries a transient durable read but makes one diagnosis call", async () => {
    const { agent, calls } = workflowAgent({ loadFailures: 1 });
    const step = new RetryingStep();
    let modelCalls = 0;

    const result = await executePrivateInvestigation(
      {
        investigationId: "c".repeat(64),
        workflowInstanceId: `private-${"c".repeat(64)}`,
        agent,
        ai: ai({
          response: JSON.stringify(diagnosis),
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        }, () => {
          modelCalls += 1;
        }),
      },
      step,
    );

    expect(calls.load).toBe(2);
    expect(step.attempts.get("load-private-evidence")).toBe(2);
    expect(calls.claim).toBe(1);
    expect(modelCalls).toBe(1);
    expect(calls.complete).toBe(1);
    expect(calls.fail).toEqual([]);
    expect(result).toEqual(diagnosis);
  });

  it("records a terminal failure without retrying a failed AI call", async () => {
    const { agent, calls } = workflowAgent();
    const step = new RetryingStep();
    let modelCalls = 0;

    await expect(
      executePrivateInvestigation(
        {
          investigationId: "d".repeat(64),
          workflowInstanceId: `private-${"d".repeat(64)}`,
          agent,
          ai: ai(new Error("provider unavailable"), () => {
            modelCalls += 1;
          }),
        },
        step,
      ),
    ).rejects.toThrow("workers_ai_diagnosis_failed");

    expect(modelCalls).toBe(1);
    expect(step.attempts.get("diagnose-with-workers-ai")).toBe(1);
    expect(calls.complete).toBe(0);
    expect(calls.fail).toEqual(["workers_ai_diagnosis_failed"]);
  });

  it("retries saving terminal failure state when the Agent is temporarily unavailable", async () => {
    const { agent, calls } = workflowAgent({ failedStateSaveFailures: 1 });
    const step = new RetryingStep();

    await expect(
      executePrivateInvestigation(
        {
          investigationId: "9".repeat(64),
          workflowInstanceId: `private-${"9".repeat(64)}`,
          agent,
          ai: ai(new Error("provider unavailable")),
        },
        step,
      ),
    ).rejects.toThrow("workers_ai_diagnosis_failed");

    expect(step.attempts.get("save-private-failure")).toBe(2);
    expect(calls.fail).toEqual(["workers_ai_diagnosis_failed"]);
  });

  it("does not call AI when the durable model-call reservation is already used", async () => {
    const { agent, calls } = workflowAgent({ claim: false });
    let modelCalls = 0;

    await expect(
      executePrivateInvestigation(
        {
          investigationId: "e".repeat(64),
          workflowInstanceId: `private-${"e".repeat(64)}`,
          agent,
          ai: ai(JSON.stringify(diagnosis), () => {
            modelCalls += 1;
          }),
        },
        new RetryingStep(),
      ),
    ).rejects.toThrow("model_call_limit_exceeded");

    expect(calls.claim).toBe(1);
    expect(modelCalls).toBe(0);
    expect(calls.fail).toEqual(["model_call_limit_exceeded"]);
  });

  it("evaluates repository memory while citing only current evidence", async () => {
    const memory: PrivateReviewedMemory = {
      sourceInvestigationId: "f".repeat(64),
      resolution: "Include .linkignore in the source distribution.",
      diagnosisSummary: "A reviewed package failure omitted .linkignore.",
      reviewedAt: Date.parse("2026-08-12T18:00:00Z"),
    };
    const { agent, calls } = workflowAgent({ memory });
    const modelInputs: Record<string, unknown>[] = [];
    const memoryDiagnosis: Diagnosis = {
      ...diagnosis,
      memoryAssessment: "applies",
      memoryExplanation: "The current package evidence independently supports it.",
    };

    const result = await executePrivateInvestigation(
      {
        investigationId: "a".repeat(64),
        workflowInstanceId: `private-${"a".repeat(64)}`,
        agent,
        ai: {
          async run(_model, input) {
            modelInputs.push(input);
            return JSON.stringify(memoryDiagnosis);
          },
        },
      },
      new RetryingStep(),
    );

    const messages = modelInputs[0].messages as Array<{ role: string; content: string }>;
    const userInput = JSON.parse(messages[1].content) as Record<string, unknown>;
    expect(calls.memory).toBe(1);
    expect(userInput.reviewedMemory).toEqual(memory);
    expect(result.memoryAssessment).toBe("applies");
    expect(result.evidenceIds).toEqual(["E-PKG-001", "E-PKG-002"]);
  });
});
