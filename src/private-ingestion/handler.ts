import { ApiInputError, errorResponse } from "../api";
import type { AccessJwtVerifier, VerifiedAccessClaims } from "./access";
import {
  AccessAuthenticationError,
  AccessAuthenticationUnavailableError,
} from "./access";
import {
  deriveExpectedDeliveryId,
  hashPrivatePacket,
  MAX_PRIVATE_PACKET_BYTES,
  parsePrivateEvidencePacket,
} from "./packet";
import {
  derivePrivateFailureKey,
  derivePrivateInvestigationId,
  derivePrivateWorkflowId,
  deriveRepositoryMemoryScope,
  deriveRepositoryScope,
} from "./scopes";
import type {
  PrivateIngestionStore,
  PrivateInvestigationRecord,
} from "./store";

const INGESTION_PATH = "/api/v1/github/investigations";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type PrivateIngestionDependencies = {
  access: () => AccessJwtVerifier;
  repositoryStore: (
    repositoryScope: string,
  ) => Promise<PrivateIngestionStore>;
  allowedRepositories: ReadonlyMap<
    string,
    { workflowName: string; workflowPath: string }
  >;
  now?: () => number;
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
      headers: { "cache-control": "no-store", ...headers },
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

async function readPacketBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new ApiInputError(
      "unsupported_media_type",
      415,
      "Content-Type must be application/json with optional UTF-8 charset.",
    );
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new ApiInputError(
      "unsupported_content_encoding",
      415,
      "Compressed request bodies are not accepted.",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new ApiInputError("invalid_content_length", 400, "Content-Length is invalid.");
    }
    if (parsed > MAX_PRIVATE_PACKET_BYTES) {
      throw new ApiInputError("request_too_large", 413, "Request body exceeds 128 KiB.");
    }
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader !== undefined) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PRIVATE_PACKET_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApiInputError(
          "request_too_large",
          413,
          "Request body exceeds 128 KiB.",
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiInputError("invalid_utf8", 400, "Request body must be valid UTF-8.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiInputError("invalid_json", 400, "Request body is not valid JSON.");
  }
}

function investigationResponse(
  record: PrivateInvestigationRecord,
  status: 200 | 202,
): Response {
  const url = `/private/investigations/${record.investigationId}`;
  return Response.json(
    {
      investigation: {
        id: record.investigationId,
        deliveryId: record.deliveryId,
        repository: record.repository,
        repositoryScope: record.repositoryScope,
        repositoryMemoryScope: record.repositoryMemoryScope,
        status: record.status,
        workflowInstanceId: record.workflowInstanceId,
        workflowLaunchState: record.workflowLaunchState,
        workflowStartAttempts: record.workflowStartAttempts,
        modelCalls: record.modelCalls,
        error: record.error,
        url,
      },
    },
    {
      status,
      headers: { "cache-control": "no-store", location: url },
    },
  );
}

export function createPrivateIngestionHandler(
  dependencies: PrivateIngestionDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const currentRequestId = requestId(request);
    const url = new URL(request.url);
    if (url.pathname !== INGESTION_PATH) {
      return jsonError("not_found", 404, "Route not found.", currentRequestId);
    }
    if (request.method !== "POST") {
      return jsonError(
        "method_not_allowed",
        405,
        "Only POST is accepted.",
        currentRequestId,
        { allow: "POST" },
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
      return jsonError(
        "access_authentication_failed",
        401,
        "Cloudflare Access service authentication is required.",
        currentRequestId,
      );
    }

    try {
      const packet = parsePrivateEvidencePacket(await readPacketBody(request));
      const allowedWorkflow = dependencies.allowedRepositories.get(
        packet.source.repository,
      );
      if (allowedWorkflow === undefined) {
        return jsonError(
          "repository_not_allowed",
          403,
          "The source repository is not allowed.",
          currentRequestId,
        );
      }
      if (
        packet.source.workflow.name !== allowedWorkflow.workflowName ||
        packet.source.workflow.path !== allowedWorkflow.workflowPath
      ) {
        return jsonError(
          "workflow_not_allowed",
          403,
          "The source workflow is not allowed.",
          currentRequestId,
        );
      }

      const idempotencyKey = request.headers.get("idempotency-key");
      if (idempotencyKey === null || !HASH_PATTERN.test(idempotencyKey)) {
        throw new ApiInputError(
          "invalid_idempotency_key",
          400,
          "Idempotency-Key must be the packet's lowercase SHA-256 delivery ID.",
        );
      }
      const expectedDeliveryId = await deriveExpectedDeliveryId(packet);
      if (
        packet.delivery.id !== expectedDeliveryId ||
        idempotencyKey !== packet.delivery.id
      ) {
        throw new ApiInputError(
          "invalid_delivery_id",
          422,
          "Delivery ID must match the packet source identity and Idempotency-Key.",
        );
      }

      const [payloadHash, investigationId, repositoryScope, repositoryMemoryScope, failureKey] =
        await Promise.all([
          hashPrivatePacket(packet),
          derivePrivateInvestigationId(packet.source.repository, packet.delivery.id),
          deriveRepositoryScope(packet.source.repository),
          deriveRepositoryMemoryScope(packet.source.repository),
          derivePrivateFailureKey({
            repository: packet.source.repository,
            workflowPath: packet.source.workflow.path,
            jobName: packet.focus.job_name,
            failedStep: packet.focus.failed_step,
          }),
        ]);
      const nowMs = dependencies.now?.() ?? Date.now();
      const result = await (
        await dependencies.repositoryStore(repositoryScope)
      ).admit({
        nowMs,
        record: {
          investigationId,
          deliveryId: packet.delivery.id,
          payloadHash,
          repository: packet.source.repository,
          repositoryScope,
          repositoryMemoryScope,
          failureKey,
          runId: packet.source.run.id,
          runAttempt: packet.source.run.attempt,
          jobId: packet.focus.job_id,
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
      });
      if (result.status === "created") return investigationResponse(result.record, 202);
      if (result.status === "duplicate") return investigationResponse(result.record, 200);
      if (result.status === "payload_conflict") {
        return jsonError(
          "delivery_payload_conflict",
          409,
          "This delivery ID was already used for a different evidence packet.",
          currentRequestId,
        );
      }
      if (result.status === "run_quota_exceeded") {
        return jsonError(
          "run_investigation_limit_reached",
          422,
          "This workflow run already created the maximum number of investigations.",
          currentRequestId,
        );
      }
      if (result.status === "workflow_unavailable") {
        return jsonError(
          "private_workflow_unavailable",
          503,
          "The investigation was saved, but its Workflow could not be started.",
          currentRequestId,
          { "retry-after": "30" },
        );
      }
      return jsonError(
        "repository_rate_limited",
        429,
        "The repository investigation quota is exhausted.",
        currentRequestId,
        { "retry-after": String(result.retryAfterSeconds) },
      );
    } catch (error) {
      if (error instanceof ApiInputError) return errorResponse(error, currentRequestId);
      return jsonError(
        "internal_error",
        500,
        "The request could not be completed.",
        currentRequestId,
      );
    }
  };
}
