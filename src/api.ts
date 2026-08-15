import { isFixtureId, type FixtureId } from "./fixture-data";
import type { ReviewAction } from "./review";

export class ApiInputError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseStartRequest(value: unknown): { fixtureId: FixtureId } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiInputError("invalid_request", 400, "Request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("fixtureId" in record)) {
    throw new ApiInputError(
      "invalid_request",
      400,
      "Only fixtureId is accepted.",
    );
  }
  if (!isFixtureId(record.fixtureId)) {
    throw new ApiInputError(
      "fixture_not_allowed",
      422,
      "The requested fixture is not available.",
    );
  }
  return { fixtureId: record.fixtureId };
}

export function parseIdempotencyKey(value: string | null): string {
  if (
    value === null ||
    value.length < 16 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new ApiInputError(
      "invalid_idempotency_key",
      400,
      "Idempotency-Key must be 16-128 URL-safe characters.",
    );
  }
  return value;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ApiInputError("invalid_request", 400, "Request fields are invalid.");
  }
}

function requireText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new ApiInputError(
      `invalid_${field}`,
      422,
      `${field} must be 1-${maximumLength} characters.`,
    );
  }
  return value.trim();
}

export function parseFollowUpRequest(value: unknown): { question: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiInputError("invalid_request", 400, "Request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  requireExactFields(record, ["question"]);
  return { question: requireText(record.question, "question", 600) };
}

export function parseReviewRequest(value: unknown): {
  action: ReviewAction;
  resolution: string | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiInputError("invalid_request", 400, "Request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.action === "correct_and_approve") {
    requireExactFields(record, ["action", "resolution"]);
    return {
      action: "correct_and_approve",
      resolution: requireText(record.resolution, "resolution", 2_000),
    };
  }
  if (record.action === "approve" || record.action === "reject") {
    requireExactFields(record, ["action"]);
    return { action: record.action, resolution: null };
  }
  throw new ApiInputError("invalid_review_action", 422, "Review action is invalid.");
}

export async function deriveSessionId(
  fixtureId: FixtureId,
  idempotencyKey: string,
  demoScopeId: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    `${demoScopeId}\0${fixtureId}\0${idempotencyKey}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function deriveActionId(parts: readonly string[]): Promise<string> {
  const input = new TextEncoder().encode(parts.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function errorResponse(error: ApiInputError, requestId: string): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: requestId,
      },
    },
    { status: error.status, headers: { "cache-control": "no-store" } },
  );
}
