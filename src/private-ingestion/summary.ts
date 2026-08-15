import type { Diagnosis } from "../diagnosis";
import type { AccessJwtVerifier, VerifiedAccessClaims } from "./access";
import {
  AccessAuthenticationError,
  AccessAuthenticationUnavailableError,
} from "./access";
import type {
  PrivateIngestionStore,
  PrivateInvestigationRecord,
} from "./store";

export const PRIVATE_SUMMARY_RESPONSE_MAX_BYTES = 8 * 1024;

const INVESTIGATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const SUMMARY_PATH_PATTERN =
  /^\/api\/v1\/github\/investigations\/([^/]+)\/summary$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const EVIDENCE_ID_PATTERN = /^E-[A-Z0-9][A-Z0-9-]{0,62}$/;

export type PrivateSummaryDependencies = {
  access: () => AccessJwtVerifier;
  expectedRepository: string;
  expectedRepositoryScope: string;
  repositoryStore: () => Promise<Pick<PrivateIngestionStore, "getInvestigation">>;
};

type SummaryDiagnosis = Pick<
  Diagnosis,
  "outcome" | "summary" | "confidence" | "uncertainty" | "evidenceIds"
>;

type PrivateInvestigationSummary = {
  schemaVersion: 1;
  investigation: {
    id: string;
    repository: string;
    status: PrivateInvestigationRecord["status"];
    terminal: boolean;
    source: {
      runId: number;
      runAttempt: number;
      headSha: string;
      pullRequestNumber: number | null;
    };
    check: {
      jobName: string;
      failedStep: string;
    };
    diagnosis: SummaryDiagnosis | null;
    error: { code: "investigation_failed" } | null;
    url: string;
  };
};

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function jsonError(
  code: string,
  status: number,
  message: string,
  currentRequestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { code, message, request_id: currentRequestId } },
    {
      status,
      headers: { "cache-control": "private, no-store", ...headers },
    },
  );
}

function requireVerifiedServiceClaims(
  claims: VerifiedAccessClaims,
): VerifiedAccessClaims {
  if (
    claims.authenticationType !== "service_token" ||
    claims.serviceTokenClientId.length < 16 ||
    claims.issuer.length < 8 ||
    claims.audiences.length === 0 ||
    !Number.isFinite(claims.expiresAt)
  ) {
    throw new AccessAuthenticationError();
  }
  return claims;
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validDiagnosis(
  diagnosis: Diagnosis,
  evidenceIds: ReadonlySet<string>,
): boolean {
  return (
    ["diagnosed", "insufficient_evidence"].includes(diagnosis.outcome) &&
    boundedText(diagnosis.summary, 500) &&
    Number.isFinite(diagnosis.confidence) &&
    diagnosis.confidence >= 0 &&
    diagnosis.confidence <= 1 &&
    boundedText(diagnosis.uncertainty, 1_000) &&
    Array.isArray(diagnosis.evidenceIds) &&
    diagnosis.evidenceIds.length >= 1 &&
    diagnosis.evidenceIds.length <= 8 &&
    new Set(diagnosis.evidenceIds).size === diagnosis.evidenceIds.length &&
    diagnosis.evidenceIds.every(
      (id) => EVIDENCE_ID_PATTERN.test(id) && evidenceIds.has(id),
    )
  );
}

function validRecordIdentity(record: PrivateInvestigationRecord): boolean {
  const pullRequestNumber = record.packet.source.pull_request?.number ?? null;
  return (
    INVESTIGATION_ID_PATTERN.test(record.investigationId) &&
    Number.isSafeInteger(record.runId) &&
    record.runId > 0 &&
    record.runId === record.packet.source.run.id &&
    Number.isSafeInteger(record.runAttempt) &&
    record.runAttempt > 0 &&
    record.runAttempt === record.packet.source.run.attempt &&
    record.jobId === record.packet.focus.job_id &&
    SHA_PATTERN.test(record.packet.source.run.head_sha) &&
    (pullRequestNumber === null ||
      (Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0)) &&
    boundedText(record.packet.focus.job_name, 160) &&
    boundedText(record.packet.focus.failed_step, 160)
  );
}

function buildSummary(
  record: PrivateInvestigationRecord,
): PrivateInvestigationSummary | null {
  if (!validRecordIdentity(record)) return null;
  const nonterminal = ["queued", "collecting", "diagnosing"].includes(
    record.status,
  );
  if (nonterminal && record.diagnosis !== null) {
    return null;
  }
  if (
    (["queued", "collecting"].includes(record.status) && record.modelCalls !== 0) ||
    (record.status === "diagnosing" && record.modelCalls !== 1)
  ) {
    return null;
  }
  if (
    record.status === "complete" &&
    (record.diagnosis === null ||
      record.modelCalls !== 1 ||
      !validDiagnosis(record.diagnosis, new Set(record.evidenceIds)))
  ) {
    return null;
  }
  if (
    record.status === "failed" &&
    (record.diagnosis !== null || ![0, 1].includes(record.modelCalls))
  ) {
    return null;
  }
  if (!nonterminal && !["complete", "failed"].includes(record.status)) {
    return null;
  }
  const diagnosis = record.status === "complete" && record.diagnosis !== null
    ? {
        outcome: record.diagnosis.outcome,
        summary: record.diagnosis.summary,
        confidence: record.diagnosis.confidence,
        uncertainty: record.diagnosis.uncertainty,
        evidenceIds: record.diagnosis.evidenceIds,
      }
    : null;
  return {
    schemaVersion: 1,
    investigation: {
      id: record.investigationId,
      repository: record.repository,
      status: record.status,
      terminal: !nonterminal,
      source: {
        runId: record.runId,
        runAttempt: record.runAttempt,
        headSha: record.packet.source.run.head_sha,
        pullRequestNumber: record.packet.source.pull_request?.number ?? null,
      },
      check: {
        jobName: record.packet.focus.job_name,
        failedStep: record.packet.focus.failed_step,
      },
      diagnosis,
      error: record.status === "failed" ? { code: "investigation_failed" } : null,
      url: `/private/investigations/${record.investigationId}`,
    },
  };
}

function boundedJsonResponse(
  body: PrivateInvestigationSummary,
  status: 200 | 202,
  currentRequestId: string,
): Response {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > PRIVATE_SUMMARY_RESPONSE_MAX_BYTES) {
    return jsonError(
      "summary_response_too_large",
      500,
      "The investigation summary could not be returned safely.",
      currentRequestId,
    );
  }
  return new Response(encoded, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function isPrivateInvestigationSummaryPath(pathname: string): boolean {
  return SUMMARY_PATH_PATTERN.test(pathname);
}

export function createPrivateInvestigationSummaryHandler(
  dependencies: PrivateSummaryDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const currentRequestId = requestId(request);
    const url = new URL(request.url);
    const match = url.pathname.match(SUMMARY_PATH_PATTERN);
    if (match === null || url.search !== "") {
      return jsonError("not_found", 404, "Route not found.", currentRequestId);
    }
    if (request.method !== "GET") {
      return jsonError(
        "method_not_allowed",
        405,
        "Only GET is accepted.",
        currentRequestId,
        { allow: "GET" },
      );
    }
    const investigationId = match[1];
    if (!INVESTIGATION_ID_PATTERN.test(investigationId)) {
      return jsonError(
        "investigation_not_found",
        404,
        "Investigation not found.",
        currentRequestId,
      );
    }

    try {
      requireVerifiedServiceClaims(await dependencies.access().verify(request));
    } catch (error) {
      if (error instanceof AccessAuthenticationUnavailableError) {
        return jsonError(
          "access_verification_unavailable",
          503,
          "Cloudflare Access verification is temporarily unavailable.",
          currentRequestId,
          { "retry-after": "30" },
        );
      }
      if (error instanceof AccessAuthenticationError) {
        return jsonError(
          "access_authentication_failed",
          401,
          "Cloudflare Access service authentication is required.",
          currentRequestId,
        );
      }
      return jsonError(
        "access_verifier_misconfigured",
        500,
        "Cloudflare Access verification is not configured for this route.",
        currentRequestId,
      );
    }

    try {
      const record = await (
        await dependencies.repositoryStore()
      ).getInvestigation(investigationId);
      if (
        record === null ||
        record.investigationId !== investigationId ||
        record.repository !== dependencies.expectedRepository ||
        record.repositoryScope !== dependencies.expectedRepositoryScope ||
        record.packet.source.repository !== dependencies.expectedRepository
      ) {
        return jsonError(
          "investigation_not_found",
          404,
          "Investigation not found.",
          currentRequestId,
        );
      }
      const summary = buildSummary(record);
      if (summary === null) {
        return jsonError(
          "summary_state_invalid",
          500,
          "The investigation summary could not be returned safely.",
          currentRequestId,
        );
      }
      return boundedJsonResponse(
        summary,
        summary.investigation.terminal ? 200 : 202,
        currentRequestId,
      );
    } catch {
      return jsonError(
        "summary_unavailable",
        500,
        "The investigation summary could not be returned.",
        currentRequestId,
      );
    }
  };
}
