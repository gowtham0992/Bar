import { describe, expect, it, vi } from "vitest";

import evidenceJson from "../../fixtures/public/link-pr-60-package-v1/evidence.json";
import fixtureJson from "../../fixtures/public/link-pr-60-package-v1/fixture.json";
import type { Diagnosis } from "../diagnosis";
import {
  AccessAuthenticationError,
  AccessAuthenticationUnavailableError,
  type AccessJwtVerifier,
} from "./access";
import type {
  PrivateEvidenceItem,
  PrivateEvidencePacket,
} from "./packet";
import type { PrivateInvestigationRecord } from "./store";
import {
  createPrivateInvestigationSummaryHandler,
  PRIVATE_SUMMARY_RESPONSE_MAX_BYTES,
} from "./summary";

const INVESTIGATION_ID = "a".repeat(64);
const LINK_REPOSITORY = "gowtham0992/link";
const LINK_SCOPE = "b".repeat(64);

const diagnosis: Diagnosis = {
  outcome: "diagnosed",
  summary: "The package build cannot find .linkignore.",
  explanation: "This long explanation must not enter the summary response.",
  confidence: 0.91,
  evidenceIds: ["E-PKG-001", "E-PKG-002"],
  uncertainty: "The repair has not been executed.",
  proposedResolution: "This proposed resolution must not enter the response.",
  memoryAssessment: "applies",
  memoryExplanation: "This memory detail must not enter the response.",
};

function packet(): PrivateEvidencePacket {
  return {
    schema_version: 1,
    capture: {
      code_repository: LINK_REPOSITORY,
      code_ref: "refs/heads/main",
      code_sha: "c".repeat(40),
      workflow_path: ".github/workflows/bar-investigate.yml",
    },
    delivery: {
      id: "d".repeat(64),
      producer: "link-bar-action/v1",
      sent_at: "2026-08-15T18:00:00Z",
    },
    source: {
      repository: LINK_REPOSITORY,
      workflow: { id: 99, name: "CI", path: ".github/workflows/ci.yml" },
      run: {
        id: 319_008_437,
        attempt: 2,
        event: "pull_request",
        head_sha: fixtureJson.run.head_sha,
        html_url: "https://github.com/gowtham0992/link/actions/runs/319008437",
      },
      pull_request: {
        number: 60,
        base_sha: fixtureJson.run.base_sha,
        head_sha: fixtureJson.run.head_sha,
      },
    },
    focus: {
      job_id: 700_060_002,
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
      redaction_counts: {
        credential: 0,
        email: 0,
        environment: 0,
        path: 0,
        url: 0,
      },
    },
  };
}

function record(
  overrides: Partial<PrivateInvestigationRecord> = {},
): PrivateInvestigationRecord {
  return {
    investigationId: INVESTIGATION_ID,
    deliveryId: "d".repeat(64),
    payloadHash: "e".repeat(64),
    repository: LINK_REPOSITORY,
    repositoryScope: LINK_SCOPE,
    repositoryMemoryScope: "f".repeat(64),
    failureKey: "1".repeat(64),
    runId: 319_008_437,
    runAttempt: 2,
    jobId: 700_060_002,
    status: "complete",
    workflowInstanceId: `private-${INVESTIGATION_ID}`,
    workflowLaunchState: "started",
    workflowStartAttempts: 1,
    packet: packet(),
    evidenceIds: ["E-PKG-001", "E-PKG-002", "E-PKG-003", "E-PKG-004"],
    diagnosis,
    memoryMatch: {
      sourceInvestigationId: "2".repeat(64),
      resolution: "Private reviewed memory must not enter the response.",
      diagnosisSummary: "Private memory summary.",
      reviewedAt: 1,
    },
    modelCalls: 1,
    modelUsage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    error: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const verifiedAccess: AccessJwtVerifier = {
  async verify() {
    return {
      authenticationType: "service_token",
      issuer: "https://bar.cloudflareaccess.com",
      audiences: ["private-summary-audience"],
      serviceTokenClientId: "bar-link-ingestion-v2.access",
      expiresAt: 1_800_000_000,
    };
  },
};

function request(id = INVESTIGATION_ID): Request {
  return new Request(
    `https://bar-private.example.com/api/v1/github/investigations/${id}/summary`,
  );
}

function handler(
  storedRecord: PrivateInvestigationRecord | null,
  access: AccessJwtVerifier = verifiedAccess,
  expectedRepository = LINK_REPOSITORY,
) {
  const getInvestigation = vi.fn(async () => storedRecord);
  return {
    getInvestigation,
    fetch: createPrivateInvestigationSummaryHandler({
      access: () => access,
      expectedRepository,
      expectedRepositoryScope: LINK_SCOPE,
      repositoryStore: async () => ({ getInvestigation }),
    }),
  };
}

describe("private investigation machine summary", () => {
  it("requires verified service authentication before reading repository state", async () => {
    const authFailure: AccessJwtVerifier = {
      async verify() {
        throw new AccessAuthenticationError();
      },
    };
    const route = handler(record(), authFailure);

    const response = await route.fetch(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "access_authentication_failed" },
    });
    expect(route.getInvestigation).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when Access verification is unavailable", async () => {
    const unavailable: AccessJwtVerifier = {
      async verify() {
        throw new AccessAuthenticationUnavailableError();
      },
    };

    const response = await handler(record(), unavailable).fetch(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toMatchObject({
      error: { code: "access_verification_unavailable" },
    });
  });

  it("returns a safe 500 when the route verifier is not configured", async () => {
    const getInvestigation = vi.fn(async () => record());
    const fetch = createPrivateInvestigationSummaryHandler({
      access: () => {
        throw new Error("missing_summary_audience");
      },
      expectedRepository: LINK_REPOSITORY,
      expectedRepositoryScope: LINK_SCOPE,
      repositoryStore: async () => ({ getInvestigation }),
    });

    const response = await fetch(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "access_verifier_misconfigured" },
    });
    expect(getInvestigation).not.toHaveBeenCalled();
  });

  it("does not reveal an investigation owned by another repository scope", async () => {
    const wrongRepository = record({ repository: "someone/else" });
    const wrongScope = record({ repositoryScope: "9".repeat(64) });

    for (const candidate of [wrongRepository, wrongScope]) {
      const response = await handler(candidate).fetch(request());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "investigation_not_found" },
      });
    }
  });

  it("returns only the bounded terminal diagnosis projection", async () => {
    const response = await handler(record()).fetch(request());
    const encoded = new Uint8Array(await response.clone().arrayBuffer());
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    const keys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectKeys);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          collectKeys(child);
        }
      }
    };
    collectKeys(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(encoded.byteLength).toBeLessThanOrEqual(PRIVATE_SUMMARY_RESPONSE_MAX_BYTES);
    expect(body).toEqual({
      schemaVersion: 1,
      investigation: {
        id: INVESTIGATION_ID,
        repository: LINK_REPOSITORY,
        status: "complete",
        terminal: true,
        source: {
          runId: 319_008_437,
          runAttempt: 2,
          headSha: fixtureJson.run.head_sha,
          pullRequestNumber: 60,
        },
        check: {
          jobName: fixtureJson.focus.job,
          failedStep: fixtureJson.focus.failed_step,
        },
        diagnosis: {
          outcome: "diagnosed",
          summary: diagnosis.summary,
          confidence: diagnosis.confidence,
          uncertainty: diagnosis.uncertainty,
          evidenceIds: diagnosis.evidenceIds,
        },
        error: null,
        url: `/private/investigations/${INVESTIGATION_ID}`,
      },
    });
    for (const forbiddenKey of [
      "evidence",
      "memoryMatch",
      "review",
      "followUps",
      "modelUsage",
      "modelCalls",
      "explanation",
      "proposedResolution",
      "workflowInstanceId",
    ]) {
      expect(keys).not.toContain(forbiddenKey);
    }
    expect(serialized).not.toContain(
      (evidenceJson as Array<{ content: string }>)[0].content.slice(0, 80),
    );
  });

  it.each(["queued", "collecting", "diagnosing"] as const)(
    "returns a minimal 202 polling projection for %s state",
    async (status) => {
      const response = await handler(record({
        status,
        diagnosis: null,
        modelCalls: status === "diagnosing" ? 1 : 0,
        modelUsage: null,
      })).fetch(request());
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(202);
      expect(body.investigation).toMatchObject({
        status,
        terminal: false,
        diagnosis: null,
        error: null,
      });
    },
  );

  it("returns a terminal failed projection without exposing the stored error", async () => {
    const response = await handler(
      record({
        status: "failed",
        diagnosis: null,
        modelCalls: 0,
        modelUsage: null,
        error: "private internal failure detail",
      }),
    ).fetch(request());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"code":"investigation_failed"');
    expect(text).not.toContain("private internal failure detail");
  });

  it("fails closed on an inconsistent terminal state", async () => {
    const response = await handler(record({ modelCalls: 0 })).fetch(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "summary_state_invalid" },
    });
  });

  it("fails closed before returning a response larger than 8 KiB", async () => {
    const oversizedRepository = `${"a".repeat(9_000)}/link`;
    const oversizedPacket = packet();
    oversizedPacket.source.repository = oversizedRepository;
    const response = await handler(
      record({ repository: oversizedRepository, packet: oversizedPacket }),
      verifiedAccess,
      oversizedRepository,
    ).fetch(request());
    const bytes = new Uint8Array(await response.clone().arrayBuffer());

    expect(response.status).toBe(500);
    expect(bytes.byteLength).toBeLessThanOrEqual(PRIVATE_SUMMARY_RESPONSE_MAX_BYTES);
    expect(await response.json()).toMatchObject({
      error: { code: "summary_response_too_large" },
    });
  });

  it("uses only the read method on repository storage", async () => {
    const admit = vi.fn(() => {
      throw new Error("must not start or retry a Workflow");
    });
    const getInvestigation = vi.fn(async () => record());
    const fetch = createPrivateInvestigationSummaryHandler({
      access: () => verifiedAccess,
      expectedRepository: LINK_REPOSITORY,
      expectedRepositoryScope: LINK_SCOPE,
      repositoryStore: async () => ({ getInvestigation, admit } as never),
    });

    const response = await fetch(request());

    expect(response.status).toBe(200);
    expect(getInvestigation).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
  });
});
