import { getAgentByName } from "agents";

import {
  ApiInputError,
  deriveActionId,
  deriveSessionId,
  errorResponse,
  parseFollowUpRequest,
  parseIdempotencyKey,
  parseReviewRequest,
  parseStartRequest,
} from "./api";
import type { Env } from "./env";
import {
  getFixture,
  getInvestigationEvidence,
  listFixtures,
} from "./fixture-data";
import { MAX_FOLLOW_UP_CALLS, parseFollowUpAnswer } from "./follow-up";
import type { InvestigationState } from "./investigation-agent";
import {
  buildFollowUpMessages,
  FOLLOW_UP_RESPONSE_FORMAT,
  MODEL_ID,
} from "./prompt";
import { PublicRateLimitAgent } from "./public-rate-limit-agent";
import { normalizeWorkersAiResponse } from "./workers-ai-response";
import {
  canMutateInvestigation,
  createDemoSession,
  demoMemoryAgentName,
  readDemoSession,
  type DemoSession,
} from "./demo-session";
import { withSecurityHeaders } from "./security-headers";
import { parsePublicJsonBody } from "./public-request-body";

export { InvestigationAgent } from "./investigation-agent";
export { InvestigationWorkflow } from "./investigation-workflow";
export { PublicRateLimitAgent } from "./public-rate-limit-agent";
export { ResolutionMemoryAgent } from "./resolution-memory-agent";

const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;
const RATE_LIMIT_AGENT_NAME = "public-api-v1";
const LEGACY_MEMORY_AGENT_NAME = "resolution-memory-v1";

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

async function clientRateKey(request: Request): Promise<string> {
  const clientIdentity = request.headers.get("cf-connecting-ip") ?? "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientIdentity),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function rateLimiter(env: Env) {
  return getAgentByName(env.PublicRateLimitAgent, RATE_LIMIT_AGENT_NAME);
}

async function resolutionMemory(env: Env, agentName: string) {
  return getAgentByName(env.ResolutionMemoryAgent, agentName);
}

function requireMutationAccess(
  ownerScopeId: string | null,
  callerScopeId: string | null,
): asserts ownerScopeId is string {
  if (!canMutateInvestigation(ownerScopeId, callerScopeId)) {
    throw new ApiInputError(
      "investigation_read_only",
      403,
      "This investigation is read-only in this demo session.",
    );
  }
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ApiInputError("investigation_not_found", 404, "Investigation not found.");
  }
}

function requireCompleteInvestigation(state: InvestigationState): asserts state is InvestigationState & {
  fixtureId: NonNullable<InvestigationState["fixtureId"]>;
  diagnosis: NonNullable<InvestigationState["diagnosis"]>;
} {
  if (state.status !== "complete" || state.fixtureId === null || state.diagnosis === null) {
    throw new ApiInputError(
      "investigation_not_ready",
      409,
      "The investigation is not ready for review.",
    );
  }
}

function rateLimitedResponse(requestId: string, retryAfterSeconds: number) {
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
        request_id: requestId,
      },
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}

async function startInvestigation(
  request: Request,
  env: Env,
  currentRequestId: string,
  demoSession: DemoSession,
): Promise<Response> {
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const { fixtureId } = parseStartRequest(await parsePublicJsonBody(request));
  const sessionId = await deriveSessionId(
    fixtureId,
    idempotencyKey,
    demoSession.scopeId,
  );
  const limiter = await rateLimiter(env);
  const admission = await limiter.admitInvestigation(
    await clientRateKey(request),
    sessionId,
  );
  if (!admission.allowed) {
    return rateLimitedResponse(currentRequestId, admission.retryAfterSeconds);
  }
  const agent = await getAgentByName(env.InvestigationAgent, sessionId);
  const state = await agent.startInvestigation(fixtureId, demoSession.scopeId);
  return Response.json(
    {
      investigation: {
        sessionId,
        fixtureId,
        status: state.status,
        workflowInstanceId: state.workflowInstanceId,
        canMutate: true,
      },
    },
    {
      status: 202,
      headers: {
        "cache-control": "no-store",
        location: `/api/investigations/${sessionId}`,
      },
    },
  );
}

async function getInvestigation(
  request: Request,
  sessionId: string,
  env: Env,
  currentRequestId: string,
  callerScopeId: string | null,
): Promise<Response> {
  const limiter = await rateLimiter(env);
  const admission = await limiter.admitRead(await clientRateKey(request));
  if (!admission.allowed) {
    return rateLimitedResponse(currentRequestId, admission.retryAfterSeconds);
  }
  requireSessionId(sessionId);
  const agent = await getAgentByName(env.InvestigationAgent, sessionId);
  const [state, ownerScopeId] = await Promise.all([
    agent.getPublicState(),
    agent.getOwnerScopeId(),
  ]);
  if (state.status === "idle") {
    throw new ApiInputError("investigation_not_found", 404, "Investigation not found.");
  }
  const memory = await resolutionMemory(
    env,
    ownerScopeId === null
      ? LEGACY_MEMORY_AGENT_NAME
      : demoMemoryAgentName(ownerScopeId),
  );
  const review = await memory.getReview(sessionId);
  return Response.json(
    {
      investigation: {
        sessionId,
        ...state,
        canMutate: canMutateInvestigation(ownerScopeId, callerScopeId),
        review,
        evidence:
          state.fixtureId === null
            ? []
            : getInvestigationEvidence(state.fixtureId, state.evidenceIds),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function followUpInvestigation(
  request: Request,
  sessionId: string,
  env: Env,
  currentRequestId: string,
  callerScopeId: string | null,
): Promise<Response> {
  requireSessionId(sessionId);
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const { question } = parseFollowUpRequest(await parsePublicJsonBody(request));
  const messageId = await deriveActionId([sessionId, idempotencyKey, question]);
  const agent = await getAgentByName(env.InvestigationAgent, sessionId);
  const ownerScopeId = await agent.getOwnerScopeId();
  requireMutationAccess(ownerScopeId, callerScopeId);
  const memory = await resolutionMemory(env, demoMemoryAgentName(ownerScopeId));
  if ((await memory.getReview(sessionId)) !== null) {
    throw new ApiInputError(
      "review_complete",
      409,
      "Follow-up chat is closed after review.",
    );
  }
  const stateBeforeAdmission = await agent.getPublicState();
  requireCompleteInvestigation(stateBeforeAdmission);
  const existingBeforeAdmission = stateBeforeAdmission.followUps.find(
    (item) => item.id === messageId,
  );
  if (
    existingBeforeAdmission === undefined &&
    stateBeforeAdmission.followUpCalls >= MAX_FOLLOW_UP_CALLS
  ) {
    throw new ApiInputError(
      "follow_up_limit_reached",
      409,
      `This investigation has used its ${MAX_FOLLOW_UP_CALLS} follow-up calls.`,
    );
  }

  const limiter = await rateLimiter(env);
  const admission = await limiter.admitFollowUp(
    await clientRateKey(request),
    messageId,
  );
  if (!admission.allowed) {
    return rateLimitedResponse(currentRequestId, admission.retryAfterSeconds);
  }
  const reservation = await agent.reserveFollowUp(messageId, question);
  if (reservation.status === "not_ready") {
    throw new ApiInputError(
      "investigation_not_ready",
      409,
      "The diagnosis is not ready for follow-up questions.",
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
          MAX_FOLLOW_UP_CALLS - (await agent.getPublicState()).followUpCalls,
        ),
      },
      {
        status: reservation.exchange.status === "pending" ? 202 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  const state = await agent.getPublicState();
  requireCompleteInvestigation(state);
  const bundle = getFixture(state.fixtureId);
  const history = state.followUps
    .filter(
      (item): item is typeof item & { answer: string } =>
        item.id !== messageId && item.status === "complete" && item.answer !== null,
    )
    .map((item) => ({
      question: item.question,
      answer: item.answer,
      evidenceIds: item.evidenceIds,
    }));
  try {
    const response = await env.AI.run(MODEL_ID, {
      messages: buildFollowUpMessages({
        bundle,
        diagnosis: state.diagnosis,
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
      new Set(bundle.fixture.evidence_ids),
    );
    const followUp = await agent.completeFollowUp(messageId, answer, normalized.usage);
    return Response.json(
      {
        followUp,
        remainingCalls: MAX_FOLLOW_UP_CALLS - state.followUpCalls,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch {
    await agent.failFollowUp(messageId);
    console.error("follow_up_failed", { requestId: currentRequestId, sessionId });
    throw new ApiInputError(
      "follow_up_failed",
      502,
      "The follow-up answer could not be completed. The call was not retried.",
    );
  }
}

async function reviewInvestigation(
  request: Request,
  sessionId: string,
  env: Env,
  callerScopeId: string | null,
): Promise<Response> {
  requireSessionId(sessionId);
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const input = parseReviewRequest(await parsePublicJsonBody(request));
  const limiter = await rateLimiter(env);
  const admission = await limiter.admitRead(await clientRateKey(request));
  if (!admission.allowed) {
    return rateLimitedResponse(requestId(request), admission.retryAfterSeconds);
  }

  const agent = await getAgentByName(env.InvestigationAgent, sessionId);
  const ownerScopeId = await agent.getOwnerScopeId();
  requireMutationAccess(ownerScopeId, callerScopeId);
  const state = await agent.getPublicState();
  requireCompleteInvestigation(state);
  const resolution =
    input.action === "correct_and_approve"
      ? input.resolution
      : input.action === "approve"
        ? state.diagnosis.proposedResolution
        : null;
  if (input.action === "approve" && !resolution) {
    throw new ApiInputError(
      "resolution_unavailable",
      409,
      "This diagnosis needs a corrected resolution before it can be approved.",
    );
  }
  const reviewId = await deriveActionId([
    sessionId,
    idempotencyKey,
    input.action,
    resolution ?? "",
  ]);
  const memory = await resolutionMemory(env, demoMemoryAgentName(ownerScopeId));
  const result = await memory.recordReview({
    reviewId,
    sessionId,
    fixtureId: state.fixtureId,
    action: input.action,
    resolution,
    diagnosisSummary: state.diagnosis.summary,
    evidenceIds: state.diagnosis.evidenceIds,
  });
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
      headers: { "cache-control": "no-store" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const currentRequestId = requestId(request);
    let demoSession = await readDemoSession(request);
    let setCookie: string | null = null;
    const ensureDemoSession = async (): Promise<DemoSession> => {
      if (demoSession === null) {
        demoSession = await createDemoSession(request);
        setCookie = demoSession.setCookie;
      }
      return demoSession;
    };

    const response = await (async (): Promise<Response> => {
      try {
        if (request.method === "GET" && url.pathname === "/api/fixtures") {
          const limiter = await rateLimiter(env);
          const admission = await limiter.admitRead(await clientRateKey(request));
          if (!admission.allowed) {
            return rateLimitedResponse(
              currentRequestId,
              admission.retryAfterSeconds,
            );
          }
          await ensureDemoSession();
          return Response.json(
            { fixtures: listFixtures() },
            { headers: { "cache-control": "private, no-store" } },
          );
        }
        if (request.method === "POST" && url.pathname === "/api/investigations") {
          return await startInvestigation(
            request,
            env,
            currentRequestId,
            await ensureDemoSession(),
          );
        }
        const statusMatch = url.pathname.match(/^\/api\/investigations\/([^/]+)$/);
        if (request.method === "GET" && statusMatch) {
          return await getInvestigation(
            request,
            statusMatch[1],
            env,
            currentRequestId,
            demoSession?.scopeId ?? null,
          );
        }
        const followUpMatch = url.pathname.match(
          /^\/api\/investigations\/([^/]+)\/follow-ups$/,
        );
        if (request.method === "POST" && followUpMatch) {
          return await followUpInvestigation(
            request,
            followUpMatch[1],
            env,
            currentRequestId,
            demoSession?.scopeId ?? null,
          );
        }
        const reviewMatch = url.pathname.match(
          /^\/api\/investigations\/([^/]+)\/review$/,
        );
        if (request.method === "POST" && reviewMatch) {
          return await reviewInvestigation(
            request,
            reviewMatch[1],
            env,
            demoSession?.scopeId ?? null,
          );
        }
        return Response.json(
          {
            error: {
              code: "not_found",
              message: "Route not found.",
              request_id: currentRequestId,
            },
          },
          { status: 404 },
        );
      } catch (error) {
        if (error instanceof ApiInputError) {
          return errorResponse(error, currentRequestId);
        }
        console.error("request_failed", { requestId: currentRequestId });
        return Response.json(
          {
            error: {
              code: "internal_error",
              message: "The request could not be completed.",
              request_id: currentRequestId,
            },
          },
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
    })();
    return withSecurityHeaders(response, setCookie);
  },
} satisfies ExportedHandler<Env>;
