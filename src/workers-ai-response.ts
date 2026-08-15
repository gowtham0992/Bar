export type ModelUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const DIAGNOSIS_FIELDS = [
  "outcome",
  "summary",
  "explanation",
  "confidence",
  "evidenceIds",
  "uncertainty",
  "proposedResolution",
] as const;

function isStructuredRecord(
  value: unknown,
  requiredFields: readonly string[],
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    requiredFields.every((field) => field in value)
  );
}

export function normalizeWorkersAiResponse(
  value: unknown,
  requiredFields: readonly string[] = DIAGNOSIS_FIELDS,
): {
  text: string;
  usage: ModelUsage;
} {
  if (typeof value === "string" && value.length > 0) {
    return {
      text: value,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workers_ai_response_missing");
  }
  const response = value as Record<string, unknown>;
  if (isStructuredRecord(response, requiredFields)) {
    return {
      text: JSON.stringify(response),
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };
  }
  const responseText =
    typeof response.response === "string" && response.response.length > 0
      ? response.response
      : isStructuredRecord(response.response, requiredFields)
        ? JSON.stringify(response.response)
        : null;
  if (responseText === null) {
    throw new Error("workers_ai_response_missing");
  }
  const usage =
    typeof response.usage === "object" &&
    response.usage !== null &&
    !Array.isArray(response.usage)
      ? (response.usage as Record<string, unknown>)
      : {};
  return {
    text: responseText,
    usage: {
      promptTokens: optionalNumber(usage.prompt_tokens),
      completionTokens: optionalNumber(usage.completion_tokens),
      totalTokens: optionalNumber(usage.total_tokens),
    },
  };
}
