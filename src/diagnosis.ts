export type Diagnosis = {
  outcome: "diagnosed" | "insufficient_evidence";
  summary: string;
  explanation: string;
  confidence: number;
  evidenceIds: string[];
  uncertainty: string;
  proposedResolution: string;
  memoryAssessment:
    | "not_available"
    | "applies"
    | "partially_applies"
    | "does_not_apply";
  memoryExplanation: string;
};

function requireBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

export function parseDiagnosis(
  text: string,
  allowedEvidenceIds: ReadonlySet<string>,
  hasReviewedMemory = false,
): Diagnosis {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid_model_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_model_result");
  }
  const record = value as Record<string, unknown>;
  if (
    record.outcome !== "diagnosed" &&
    record.outcome !== "insufficient_evidence"
  ) {
    throw new Error("invalid_outcome");
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error("invalid_confidence");
  }
  const allowedMemoryAssessments = hasReviewedMemory
    ? ["applies", "partially_applies", "does_not_apply"]
    : ["not_available"];
  if (!allowedMemoryAssessments.includes(record.memoryAssessment as string)) {
    throw new Error("invalid_memory_assessment");
  }
  if (
    !Array.isArray(record.evidenceIds) ||
    record.evidenceIds.length === 0 ||
    record.evidenceIds.length > 8 ||
    !record.evidenceIds.every((item) => typeof item === "string")
  ) {
    throw new Error("invalid_evidence_ids");
  }
  const evidenceIds = [...new Set(record.evidenceIds as string[])];
  if (evidenceIds.some((evidenceId) => !allowedEvidenceIds.has(evidenceId))) {
    throw new Error("unknown_evidence_id");
  }
  return {
    outcome: record.outcome,
    summary: requireBoundedString(record.summary, "summary", 500),
    explanation: requireBoundedString(record.explanation, "explanation", 4_000),
    confidence: record.confidence,
    evidenceIds,
    uncertainty: requireBoundedString(record.uncertainty, "uncertainty", 1_000),
    proposedResolution: requireBoundedString(
      record.proposedResolution,
      "proposed_resolution",
      2_000,
    ),
    memoryAssessment: record.memoryAssessment as Diagnosis["memoryAssessment"],
    memoryExplanation: requireBoundedString(
      record.memoryExplanation,
      "memory_explanation",
      1_500,
    ),
  };
}
