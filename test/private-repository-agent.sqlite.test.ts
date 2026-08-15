import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import packageEvidenceJson from "../fixtures/public/link-pr-60-package-v1/evidence.json";
import packageFixtureJson from "../fixtures/public/link-pr-60-package-v1/fixture.json";
import type { Diagnosis } from "../src/diagnosis";
import type { PrivateRepositoryAgent } from "../src/private-ingestion/repository-agent";
import {
  deriveExpectedDeliveryId,
  hashPrivatePacket,
  type PrivateEvidenceItem,
  type PrivateEvidencePacket,
  type RedactionCounts,
} from "../src/private-ingestion/packet";
import {
  derivePrivateFailureKey,
  derivePrivateInvestigationId,
  derivePrivateWorkflowId,
  deriveRepositoryMemoryScope,
  deriveRepositoryScope,
} from "../src/private-ingestion/scopes";
import {
  MAX_FOLLOW_UP_CALLS,
  type FollowUpAnswer,
} from "../src/follow-up";
import {
  PRIVATE_REPOSITORY_HOURLY_LIMIT,
  PRIVATE_RUN_INVESTIGATION_LIMIT,
  type PrivateAdmissionInput,
} from "../src/private-ingestion/store";

type TestEnv = {
  PrivateRepositoryAgent: DurableObjectNamespace<PrivateRepositoryAgent>;
};

const NOW_MS = Date.parse("2026-08-13T18:00:00Z");

function redactionTotals(items: PrivateEvidenceItem[]): RedactionCounts {
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

async function admission(input: {
  repository: string;
  runId: number;
  jobId: number;
  nowMs?: number;
}): Promise<PrivateAdmissionInput> {
  const fixture = structuredClone(packageFixtureJson);
  const evidence = structuredClone(packageEvidenceJson) as PrivateEvidenceItem[];
  const packet: PrivateEvidencePacket = {
    schema_version: 1,
    capture: {
      code_repository: input.repository,
      code_ref: "refs/heads/main",
      code_sha: "a".repeat(40),
      workflow_path: ".github/workflows/bar-investigate.yml",
    },
    delivery: {
      id: "0".repeat(64),
      producer: "link-bar-action/v1",
      sent_at: "2026-08-13T18:00:00Z",
    },
    source: {
      repository: input.repository,
      workflow: { id: 99, name: "CI", path: ".github/workflows/ci.yml" },
      run: {
        id: input.runId,
        attempt: 1,
        event: "pull_request",
        head_sha: fixture.run.head_sha,
        html_url: `https://github.com/${input.repository}/actions/runs/${input.runId}`,
      },
      pull_request: {
        number: fixture.source.pull_request,
        base_sha: fixture.run.base_sha,
        head_sha: fixture.run.head_sha,
      },
    },
    focus: {
      job_id: input.jobId,
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
      redaction_counts: redactionTotals(evidence),
    },
  };
  packet.delivery.id = await deriveExpectedDeliveryId(packet);
  const [
    payloadHash,
    investigationId,
    repositoryScope,
    repositoryMemoryScope,
    failureKey,
  ] = await Promise.all([
    hashPrivatePacket(packet),
    derivePrivateInvestigationId(input.repository, packet.delivery.id),
    deriveRepositoryScope(input.repository),
    deriveRepositoryMemoryScope(input.repository),
    derivePrivateFailureKey({
      repository: input.repository,
      workflowPath: packet.source.workflow.path,
      jobName: packet.focus.job_name,
      failedStep: packet.focus.failed_step,
    }),
  ]);
  const nowMs = input.nowMs ?? NOW_MS;
  return {
    nowMs,
    record: {
      investigationId,
      deliveryId: packet.delivery.id,
      payloadHash,
      repository: input.repository,
      repositoryScope,
      repositoryMemoryScope,
      failureKey,
      runId: input.runId,
      runAttempt: 1,
      jobId: input.jobId,
      status: "queued",
      workflowInstanceId: derivePrivateWorkflowId(investigationId),
      workflowLaunchState: "pending",
      workflowStartAttempts: 0,
      packet,
      evidenceIds: packet.evidence.map((item) => item.id),
      diagnosis: null,
      memoryMatch: null,
      modelCalls: 0,
      modelUsage: null,
      error: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
  };
}

async function repositoryAgent(repository: string) {
  const scope = await deriveRepositoryScope(repository);
  return (env as unknown as TestEnv).PrivateRepositoryAgent.getByName(scope);
}

const diagnosis: Diagnosis = {
  outcome: "diagnosed",
  summary: "The source distribution omitted .linkignore.",
  explanation: "Current package evidence shows the required file was absent.",
  confidence: 0.93,
  evidenceIds: ["E-PKG-001", "E-PKG-002"],
  uncertainty: "The repair has not yet been executed.",
  proposedResolution: "Include .linkignore and rebuild the package.",
  memoryAssessment: "not_available",
  memoryExplanation: "No reviewed resolution was available.",
};

async function complete(
  agent: DurableObjectStub<PrivateRepositoryAgent>,
  input: PrivateAdmissionInput,
) {
  const admitted = await agent.admit(input);
  if (!("record" in admitted)) throw new Error("expected admitted investigation");
  expect(
    await agent.claimModelCall(
      admitted.record.investigationId,
      admitted.record.workflowInstanceId,
    ),
  ).toBe(true);
  await agent.completeInvestigation(
    admitted.record.investigationId,
    admitted.record.workflowInstanceId,
    diagnosis,
    { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
  );
  return admitted.record;
}

it("enforces private invariants with real per-repository Agent SQLite storage", async () => {
  const repository = "gowtham0992/link";
  const agent = await repositoryAgent(repository);
  const firstInput = await admission({ repository, runId: 1_000, jobId: 2_000 });

  const created = await agent.admit(firstInput);
  const duplicate = await agent.admit(firstInput);
  expect(created.status).toBe("created");
  expect(duplicate.status).toBe("duplicate");
  if (!("record" in created) || !("record" in duplicate)) {
    throw new Error("expected durable investigation records");
  }
  expect(duplicate.record.investigationId).toBe(created.record.investigationId);
  expect(duplicate.record.workflowInstanceId).toBe(created.record.workflowInstanceId);
  expect(duplicate.record.workflowStartAttempts).toBe(1);

  await runInDurableObject(agent, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE private_investigations SET workflow_launch_state = 'starting' WHERE investigation_id = ?",
      created.record.investigationId,
    );
  });
  const recovered = await agent.admit(firstInput);
  expect(recovered.status).toBe("duplicate");
  if (!("record" in recovered)) throw new Error("expected recovered record");
  expect(recovered.record.workflowInstanceId).toBe(created.record.workflowInstanceId);
  expect(recovered.record.workflowLaunchState).toBe("started");
  expect(recovered.record.workflowStartAttempts).toBe(2);

  expect(
    await agent.claimModelCall(
      created.record.investigationId,
      created.record.workflowInstanceId,
    ),
  ).toBe(true);
  expect(
    await agent.claimModelCall(
      created.record.investigationId,
      created.record.workflowInstanceId,
    ),
  ).toBe(false);
  await agent.completeInvestigation(
    created.record.investigationId,
    created.record.workflowInstanceId,
    diagnosis,
    { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
  );
  await agent.recordApprovedResolution({
    investigationId: created.record.investigationId,
    resolution: "Include .linkignore in the source distribution.",
  });

  const similarInput = await admission({ repository, runId: 1_001, jobId: 2_001 });
  const similar = await agent.admit(similarInput);
  if (!("record" in similar)) throw new Error("expected similar record");
  const sameRepositoryMemory = await agent.getReviewedMemory(
    similar.record.investigationId,
    similar.record.workflowInstanceId,
  );
  expect(sameRepositoryMemory?.sourceInvestigationId).toBe(
    created.record.investigationId,
  );

  const otherRepository = "gowtham0992/link-fork";
  const otherAgent = await repositoryAgent(otherRepository);
  const otherInput = await admission({
    repository: otherRepository,
    runId: 1_002,
    jobId: 2_002,
  });
  const other = await otherAgent.admit(otherInput);
  if (!("record" in other)) throw new Error("expected other repository record");
  expect(
    await otherAgent.getReviewedMemory(
      other.record.investigationId,
      other.record.workflowInstanceId,
    ),
  ).toBeNull();

  const runQuotaRepository = "quota/run";
  const runQuotaAgent = await repositoryAgent(runQuotaRepository);
  for (let index = 0; index < PRIVATE_RUN_INVESTIGATION_LIMIT; index += 1) {
    expect(
      (
        await runQuotaAgent.admit(
          await admission({
            repository: runQuotaRepository,
            runId: 3_000,
            jobId: 4_000 + index,
          }),
        )
      ).status,
    ).toBe("created");
  }
  expect(
    (
      await runQuotaAgent.admit(
        await admission({
          repository: runQuotaRepository,
          runId: 3_000,
          jobId: 4_999,
        }),
      )
    ).status,
  ).toBe("run_quota_exceeded");

  const hourlyQuotaRepository = "quota/hourly";
  const hourlyQuotaAgent = await repositoryAgent(hourlyQuotaRepository);
  for (let index = 0; index < PRIVATE_REPOSITORY_HOURLY_LIMIT; index += 1) {
    expect(
      (
        await hourlyQuotaAgent.admit(
          await admission({
            repository: hourlyQuotaRepository,
            runId: 5_000 + index,
            jobId: 6_000 + index,
          }),
        )
      ).status,
    ).toBe("created");
  }
  expect(
    (
      await hourlyQuotaAgent.admit(
        await admission({
          repository: hourlyQuotaRepository,
          runId: 9_999,
          jobId: 9_999,
        }),
      )
    ).status,
  ).toBe("repository_quota_exceeded");
});

it("persists private follow-ups with a hard call limit and closes chat after review", async () => {
  const repository = "private/follow-ups";
  const agent = await repositoryAgent(repository);
  const record = await complete(
    agent,
    await admission({ repository, runId: 20_000, jobId: 21_000 }),
  );
  const answer: FollowUpAnswer = {
    answer: "The log and configuration show the missing forced include.",
    evidenceIds: ["E-PKG-001", "E-PKG-002"],
  };

  for (let index = 0; index < MAX_FOLLOW_UP_CALLS; index += 1) {
    const id = String(index + 1).repeat(64);
    const reserved = await agent.reserveFollowUp(
      record.investigationId,
      id,
      `Question ${index + 1}`,
    );
    expect(reserved.status).toBe("reserved");
    if (index === 0) {
      await agent.completeFollowUp(
        record.investigationId,
        id,
        answer,
        { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
      );
    } else {
      await agent.failFollowUp(record.investigationId, id);
    }
  }
  expect(
    (
      await agent.reserveFollowUp(
        record.investigationId,
        "9".repeat(64),
        "One question too many",
      )
    ).status,
  ).toBe("limit_reached");
  expect(await agent.getFollowUps(record.investigationId)).toHaveLength(
    MAX_FOLLOW_UP_CALLS,
  );

  const reviewed = await agent.recordReview({
    reviewId: "a".repeat(64),
    investigationId: record.investigationId,
    action: "approve",
    resolution: diagnosis.proposedResolution,
  });
  expect(reviewed.status).toBe("created");
  if (!("review" in reviewed)) throw new Error("expected private review");
  expect(reviewed.review.memorySaved).toBe(true);
  expect(
    (
      await agent.reserveFollowUp(
        record.investigationId,
        "8".repeat(64),
        "Question after review",
      )
    ).status,
  ).toBe("review_complete");
});

it("saves approved corrections, excludes rejections, and isolates memory by repository", async () => {
  const correctedRepository = "private/corrected";
  const correctedAgent = await repositoryAgent(correctedRepository);
  const correctedSource = await complete(
    correctedAgent,
    await admission({
      repository: correctedRepository,
      runId: 30_000,
      jobId: 31_000,
    }),
  );
  const correctedResolution = "Include .linkignore before constructing the source distribution.";
  const correctedReview = await correctedAgent.recordReview({
    reviewId: "b".repeat(64),
    investigationId: correctedSource.investigationId,
    action: "correct_and_approve",
    resolution: correctedResolution,
  });
  expect(correctedReview.status).toBe("created");
  expect((await correctedAgent.getReview(correctedSource.investigationId))?.resolution)
    .toBe(correctedResolution);

  const correctedSimilar = await correctedAgent.admit(
    await admission({
      repository: correctedRepository,
      runId: 30_001,
      jobId: 31_001,
    }),
  );
  if (!("record" in correctedSimilar)) throw new Error("expected similar investigation");
  expect(
    await correctedAgent.getReviewedMemory(
      correctedSimilar.record.investigationId,
      correctedSimilar.record.workflowInstanceId,
    ),
  ).toMatchObject({
    sourceInvestigationId: correctedSource.investigationId,
    resolution: correctedResolution,
  });

  const isolatedAgent = await repositoryAgent("private/isolated");
  const isolated = await isolatedAgent.admit(
    await admission({
      repository: "private/isolated",
      runId: 30_002,
      jobId: 31_002,
    }),
  );
  if (!("record" in isolated)) throw new Error("expected isolated investigation");
  expect(
    await isolatedAgent.getReviewedMemory(
      isolated.record.investigationId,
      isolated.record.workflowInstanceId,
    ),
  ).toBeNull();

  const rejectedRepository = "private/rejected";
  const rejectedAgent = await repositoryAgent(rejectedRepository);
  const rejectedSource = await complete(
    rejectedAgent,
    await admission({
      repository: rejectedRepository,
      runId: 40_000,
      jobId: 41_000,
    }),
  );
  const rejectedReview = await rejectedAgent.recordReview({
    reviewId: "c".repeat(64),
    investigationId: rejectedSource.investigationId,
    action: "reject",
    resolution: null,
  });
  expect(rejectedReview.status).toBe("created");
  if (!("review" in rejectedReview)) throw new Error("expected rejected review");
  expect(rejectedReview.review.memorySaved).toBe(false);

  const afterRejection = await rejectedAgent.admit(
    await admission({
      repository: rejectedRepository,
      runId: 40_001,
      jobId: 41_001,
    }),
  );
  if (!("record" in afterRejection)) throw new Error("expected post-rejection investigation");
  expect(
    await rejectedAgent.getReviewedMemory(
      afterRejection.record.investigationId,
      afterRejection.record.workflowInstanceId,
    ),
  ).toBeNull();
});
