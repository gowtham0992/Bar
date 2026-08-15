import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => ({
  configs: [] as Array<Record<string, string>>,
  verify: vi.fn(async (_request: Request) => ({
    authenticationType: "service_token" as const,
    issuer: "https://bar.cloudflareaccess.com",
    audiences: ["summary-audience-value"],
    serviceTokenClientId: "bar-link-ingestion-v2.access",
    expiresAt: 1_800_000_000,
  })),
}));

vi.mock("agents", () => ({ getAgentByName: vi.fn() }));
vi.mock("./private-ingestion/access", () => ({
  CloudflareAccessJwtVerifier: class {
    constructor(config: Record<string, string>) {
      accessMock.configs.push(config);
    }

    verify(request: Request) {
      return accessMock.verify(request);
    }
  },
}));
vi.mock("./private-ingestion/private-workflow", () => ({
  PrivateInvestigationWorkflow: class {},
}));
vi.mock("./private-ingestion/repository-agent", () => ({
  PrivateRepositoryAgent: class {},
}));

import { getAgentByName } from "agents";

import type { PrivateEnv } from "./private-env";
import privateWorker from "./private-worker";
import { deriveRepositoryScope } from "./private-ingestion/scopes";
import type { PrivateInvestigationRecord } from "./private-ingestion/store";
import { SECURITY_HEADERS } from "./security-headers";

describe("private Worker routing", () => {
  beforeEach(() => {
    accessMock.configs.length = 0;
    accessMock.verify.mockClear();
    vi.mocked(getAgentByName).mockReset();
  });

  it("returns 404 for a non-ingestion route before the service-token Client ID is configured", async () => {
    const response = await privateWorker.fetch(
      new Request("https://bar-private.example/"),
      {
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        ACCESS_AUDIENCE: "a".repeat(64),
        ACCESS_SERVICE_TOKEN_CLIENT_ID: "",
      } as PrivateEnv,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found", message: "Route not found." },
    });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("serves a private investigation deep link without constructing the service verifier", async () => {
    const investigationId = "a".repeat(64);
    const assetFetch = vi.fn(async () =>
      new Response("<!doctype html><title>Private investigation</title>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const response = await privateWorker.fetch(
      new Request(`https://bar-private.example/private/investigations/${investigationId}`),
      {
        ASSETS: { fetch: assetFetch },
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        ACCESS_AUDIENCE: "a".repeat(64),
        ACCESS_SERVICE_TOKEN_CLIENT_ID: "",
      } as unknown as PrivateEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Private investigation");
    expect(assetFetch).toHaveBeenCalledOnce();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("uses the separate summary audience without invoking Workflow or Workers AI", async () => {
    const investigationId = "a".repeat(64);
    const repositoryScope = await deriveRepositoryScope("gowtham0992/link");
    const aiRun = vi.fn(() => {
      throw new Error("summary route must not invoke Workers AI");
    });
    const workflowCreate = vi.fn(() => {
      throw new Error("summary route must not start a Workflow");
    });
    const storedRecord = {
      investigationId,
      repository: "gowtham0992/link",
      repositoryScope,
      runId: 319_008_437,
      runAttempt: 2,
      jobId: 700_060_002,
      status: "complete",
      packet: {
        source: {
          repository: "gowtham0992/link",
          run: {
            id: 319_008_437,
            attempt: 2,
            head_sha: "b".repeat(40),
          },
          pull_request: { number: 60 },
        },
        focus: {
          job_id: 700_060_002,
          job_name: "package",
          failed_step: "Build link-mcp",
        },
      },
      evidenceIds: ["E-PKG-001"],
      diagnosis: {
        outcome: "diagnosed",
        summary: "The package build cannot find .linkignore.",
        confidence: 0.91,
        uncertainty: "The repair has not been executed.",
        evidenceIds: ["E-PKG-001"],
      },
      modelCalls: 1,
    } as unknown as PrivateInvestigationRecord;
    vi.mocked(getAgentByName).mockResolvedValue({
      getInvestigation: vi.fn(async () => storedRecord),
    } as never);

    const response = await privateWorker.fetch(
      new Request(
        `https://bar-private.example/api/v1/github/investigations/${investigationId}/summary`,
      ),
      {
        AI: { run: aiRun },
        PRIVATE_INVESTIGATION_WORKFLOW: { create: workflowCreate },
        PrivateRepositoryAgent: {},
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        ACCESS_AUDIENCE: "ingestion-audience-value",
        ACCESS_SUMMARY_AUDIENCE: "summary-audience-value",
        ACCESS_SERVICE_TOKEN_CLIENT_ID: "bar-link-ingestion-v2.access",
      } as unknown as PrivateEnv,
    );

    expect(response.status).toBe(200);
    expect(accessMock.configs).toEqual([
      expect.objectContaining({
        audience: "summary-audience-value",
        serviceTokenClientId: "bar-link-ingestion-v2.access",
      }),
    ]);
    expect(accessMock.configs[0]?.audience).not.toBe("ingestion-audience-value");
    expect(aiRun).not.toHaveBeenCalled();
    expect(workflowCreate).not.toHaveBeenCalled();
  });
});
