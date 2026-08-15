import type { ModelUsage } from "./workers-ai-response";

export const MAX_FOLLOW_UP_CALLS = 3;

export type FollowUpAnswer = {
  answer: string;
  evidenceIds: string[];
};

export type FollowUpExchange = {
  id: string;
  question: string;
  status: "pending" | "complete" | "failed";
  answer: string | null;
  evidenceIds: string[];
  usage: ModelUsage | null;
  error: string | null;
};

export function canReserveFollowUp(currentCalls: number): boolean {
  return (
    Number.isInteger(currentCalls) &&
    currentCalls >= 0 &&
    currentCalls < MAX_FOLLOW_UP_CALLS
  );
}

function boundedAnswer(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2_000
  ) {
    throw new Error("invalid_follow_up_answer");
  }
  return value.trim();
}

export function parseFollowUpAnswer(
  text: string,
  allowedEvidenceIds: ReadonlySet<string>,
): FollowUpAnswer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid_follow_up_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_follow_up_result");
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.evidenceIds) ||
    record.evidenceIds.length === 0 ||
    record.evidenceIds.length > 8 ||
    !record.evidenceIds.every((item) => typeof item === "string")
  ) {
    throw new Error("invalid_follow_up_evidence_ids");
  }
  const evidenceIds = [...new Set(record.evidenceIds as string[])];
  if (evidenceIds.some((id) => !allowedEvidenceIds.has(id))) {
    throw new Error("unknown_follow_up_evidence_id");
  }
  return { answer: boundedAnswer(record.answer), evidenceIds };
}
