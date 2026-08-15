import {
  ApiInputError,
  deriveActionId,
  parseFollowUpRequest,
  parseIdempotencyKey,
  parseReviewRequest,
} from "./api";
import {
  MAX_FOLLOW_UP_CALLS,
  parseFollowUpAnswer,
  type FollowUpAnswer,
  type FollowUpExchange,
} from "./follow-up";
import {
  buildPrivateFollowUpMessages,
} from "./private-ingestion/model-input";
import { assertModelBoundValueSanitized } from "./private-ingestion/packet";
import type {
  PrivateFollowUpReservation,
  PrivateInvestigationRecord,
  PrivateResolutionReview,
  PrivateReviewResult,
} from "./private-ingestion/store";
import {
  FOLLOW_UP_RESPONSE_FORMAT,
  MODEL_ID,
} from "./prompt";
import { parsePublicJsonBody } from "./public-request-body";
import { normalizeWorkersAiResponse } from "./workers-ai-response";
import type { ModelUsage } from "./workers-ai-response";
import type { ReviewAction } from "./review";

const INVESTIGATION_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface PrivateApiDependencies {
  repositoryAgent(): Promise<PrivateRepositoryApi>;
  ai: Ai;
  now?: () => number;
}

export interface PrivateRepositoryApi {
  getInvestigation(investigationId: string): Promise<PrivateInvestigationRecord | null>;
  getFollowUps(investigationId: string): Promise<FollowUpExchange[]>;
  getReview(investigationId: string): Promise<PrivateResolutionReview | null>;
  reserveFollowUp(
    investigationId: string,
    followUpId: string,
    question: string,
  ): Promise<PrivateFollowUpReservation>;
  completeFollowUp(
    investigationId: string,
    followUpId: string,
    answer: FollowUpAnswer,
    usage: ModelUsage,
  ): Promise<FollowUpExchange>;
  failFollowUp(
    investigationId: string,
    followUpId: string,
  ): Promise<FollowUpExchange>;
  recordReview(input: {
    reviewId: string;
    investigationId: string;
    action: ReviewAction;
    resolution: string | null;
  }): Promise<PrivateReviewResult>;
}

function requireInvestigationId(investigationId: string): void {
  if (!INVESTIGATION_ID_PATTERN.test(investigationId)) {
    throw new ApiInputError("investigation_not_found", 404, "Investigation not found.");
  }
}

function milestones(status: PrivateInvestigationRecord["status"]) {
  const completed = (stage: string) => ({ stage, status: "complete" as const });
  const pending = (stage: string) => ({ stage, status: "pending" as const });
  return [
    status === "queued" ? pending("load_evidence") : completed("load_evidence"),
    ["queued", "collecting"].includes(status)
      ? pending("recall_memory")
      : completed("recall_memory"),
    status === "complete" ? completed("diagnose") : pending("diagnose"),
  ];
}

async function requireInvestigation(
  agent: PrivateRepositoryApi,
  investigationId: string,
): Promise<PrivateInvestigationRecord> {
  requireInvestigationId(investigationId);
  const record = await agent.getInvestigation(investigationId);
  if (record === null) {
    throw new ApiInputError("investigation_not_found", 404, "Investigation not found.");
  }
  return record;
}

function requireComplete(
  record: PrivateInvestigationRecord,
): asserts record is PrivateInvestigationRecord & {
  diagnosis: NonNullable<PrivateInvestigationRecord["diagnosis"]>;
} {
  if (record.status !== "complete" || record.diagnosis === null) {
    throw new ApiInputError(
      "investigation_not_ready",
      409,
      "The investigation is not ready for this action.",
    );
  }
}

function requireSanitizedModelInput(value: unknown, code: string): void {
  try {
    assertModelBoundValueSanitized(value);
  } catch {
    throw new ApiInputError(
      code,
      422,
      "Remove credentials or other sensitive values before submitting this text.",
    );
  }
}

async function investigationResponse(
  agent: PrivateRepositoryApi,
  record: PrivateInvestigationRecord,
): Promise<Response> {
  const [followUps, review] = await Promise.all([
    agent.getFollowUps(record.investigationId),
    agent.getReview(record.investigationId),
  ]);
  return Response.json(
    {
      investigation: {
        id: record.investigationId,
        repository: record.repository,
        status: record.status,
        workflowInstanceId: record.workflowInstanceId,
        workflowLaunchState: record.workflowLaunchState,
        milestones: milestones(record.status),
        source: {
          workflow: record.packet.source.workflow,
          run: record.packet.source.run,
          pullRequest: record.packet.source.pull_request,
          focus: record.packet.focus,
          missingEvidence: record.packet.missing_evidence,
        },
        diagnosis: record.diagnosis,
        memoryMatch: record.memoryMatch,
        modelCalls: record.modelCalls,
        modelUsage: record.modelUsage,
        followUpCalls: followUps.length,
        followUpLimit: MAX_FOLLOW_UP_CALLS,
        followUps,
        review,
        evidence: record.packet.evidence,
        error: record.error,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

async function getInvestigation(
  investigationId: string,
  dependencies: PrivateApiDependencies,
): Promise<Response> {
  const agent = await dependencies.repositoryAgent();
  return investigationResponse(
    agent,
    await requireInvestigation(agent, investigationId),
  );
}

async function followUp(
  request: Request,
  investigationId: string,
  dependencies: PrivateApiDependencies,
): Promise<Response> {
  requireInvestigationId(investigationId);
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const { question } = parseFollowUpRequest(await parsePublicJsonBody(request));
  requireSanitizedModelInput({ question }, "unsanitized_follow_up");
  const followUpId = await deriveActionId([
    "private-follow-up-v1",
    investigationId,
    idempotencyKey,
    question,
  ]);
  const agent = await dependencies.repositoryAgent();
  const record = await requireInvestigation(agent, investigationId);
  requireComplete(record);
  const reservation = await agent.reserveFollowUp(
    investigationId,
    followUpId,
    question,
  );
  if (reservation.status === "not_ready") {
    throw new ApiInputError(
      "investigation_not_ready",
      409,
      "The diagnosis is not ready for follow-up questions.",
    );
  }
  if (reservation.status === "review_complete") {
    throw new ApiInputError(
      "review_complete",
      409,
      "Follow-up chat is closed after review.",
    );
  }
  if (reservation.status === "limit_reached") {
    throw new ApiInputError(
      "follow_up_limit_reached",
      409,
      `This investigation has used its ${MAX_FOLLOW_UP_CALLS} follow-up calls.`,
    );
  }
  if (reservation.status === "existing") {
    return Response.json(
      {
        followUp: reservation.exchange,
        remainingCalls: Math.max(
          0,
          MAX_FOLLOW_UP_CALLS - (await agent.getFollowUps(investigationId)).length,
        ),
      },
      {
        status: reservation.exchange.status === "pending" ? 202 : 200,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }

  const history = (await agent.getFollowUps(investigationId))
    .filter(
      (item): item is typeof item & { answer: string } =>
        item.id !== followUpId && item.status === "complete" && item.answer !== null,
    )
    .map((item) => ({
      question: item.question,
      answer: item.answer,
      evidenceIds: item.evidenceIds,
    }));
  try {
    const response = await dependencies.ai.run(MODEL_ID, {
      messages: buildPrivateFollowUpMessages({
        packet: record.packet,
        diagnosis: record.diagnosis,
        history,
        question,
      }),
      temperature: 0.1,
      max_tokens: 800,
      response_format: FOLLOW_UP_RESPONSE_FORMAT,
    });
    const normalized = normalizeWorkersAiResponse(response, ["answer", "evidenceIds"]);
    const answer = parseFollowUpAnswer(
      normalized.text,
      new Set(record.evidenceIds),
    );
    requireSanitizedModelInput({ answer: answer.answer }, "unsanitized_follow_up_answer");
    const exchange = await agent.completeFollowUp(
      investigationId,
      followUpId,
      answer,
      normalized.usage,
    );
    return Response.json(
      {
        followUp: exchange,
        remainingCalls: Math.max(
          0,
          MAX_FOLLOW_UP_CALLS - (await agent.getFollowUps(investigationId)).length,
        ),
      },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    await agent.failFollowUp(investigationId, followUpId);
    if (error instanceof ApiInputError) throw error;
    throw new ApiInputError(
      "follow_up_failed",
      502,
      "The follow-up answer could not be completed. The call was not retried.",
    );
  }
}

async function review(
  request: Request,
  investigationId: string,
  dependencies: PrivateApiDependencies,
): Promise<Response> {
  requireInvestigationId(investigationId);
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const input = parseReviewRequest(await parsePublicJsonBody(request));
  const agent = await dependencies.repositoryAgent();
  const record = await requireInvestigation(agent, investigationId);
  requireComplete(record);
  const resolution =
    input.action === "correct_and_approve"
      ? input.resolution
      : input.action === "approve"
        ? record.diagnosis.proposedResolution
        : null;
  if (input.action === "approve" && !resolution) {
    throw new ApiInputError(
      "resolution_unavailable",
      409,
      "This diagnosis needs a corrected resolution before it can be approved.",
    );
  }
  if (resolution !== null) {
    requireSanitizedModelInput({ resolution }, "unsanitized_resolution");
  }
  const reviewId = await deriveActionId([
    "private-review-v1",
    investigationId,
    idempotencyKey,
    input.action,
    resolution ?? "",
  ]);
  let result;
  try {
    result = await agent.recordReview({
      reviewId,
      investigationId,
      action: input.action,
      resolution,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "private_follow_up_pending") {
      throw new ApiInputError(
        "follow_up_pending",
        409,
        "Wait for the pending follow-up answer before reviewing.",
      );
    }
    throw error;
  }
  if (result.status === "conflict") {
    throw new ApiInputError(
      "review_already_recorded",
      409,
      "This investigation already has a final review.",
    );
  }
  return Response.json(
    { review: result.review },
    {
      status: result.status === "created" ? 201 : 200,
      headers: { "cache-control": "private, no-store" },
    },
  );
}

export async function handlePrivateApiRequest(
  request: Request,
  dependencies: PrivateApiDependencies,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const statusMatch = pathname.match(
    /^\/api\/v1\/private\/investigations\/([^/]+)$/,
  );
  if (request.method === "GET" && statusMatch) {
    return getInvestigation(statusMatch[1], dependencies);
  }
  const followUpMatch = pathname.match(
    /^\/api\/v1\/private\/investigations\/([^/]+)\/follow-ups$/,
  );
  if (request.method === "POST" && followUpMatch) {
    return followUp(request, followUpMatch[1], dependencies);
  }
  const reviewMatch = pathname.match(
    /^\/api\/v1\/private\/investigations\/([^/]+)\/review$/,
  );
  if (request.method === "POST" && reviewMatch) {
    return review(request, reviewMatch[1], dependencies);
  }
  return null;
}
