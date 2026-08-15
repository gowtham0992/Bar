export const MAX_MODEL_CALLS_PER_INVESTIGATION = 1;
export const AI_STEP_CONFIG = {
  retries: { limit: 1, delay: 0, backoff: "constant" },
  timeout: "2 minutes",
} as const;

export function canReserveModelCall(modelCalls: number): boolean {
  return (
    Number.isInteger(modelCalls) &&
    modelCalls >= 0 &&
    modelCalls < MAX_MODEL_CALLS_PER_INVESTIGATION
  );
}
