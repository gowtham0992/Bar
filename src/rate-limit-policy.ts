export const READ_LIMIT = 120;
export const READ_WINDOW_MS = 60_000;
export const CLIENT_INVESTIGATION_LIMIT = 2;
export const CLIENT_INVESTIGATION_WINDOW_MS = 10 * 60_000;
export const GLOBAL_INVESTIGATION_LIMIT = 20;
export const GLOBAL_INVESTIGATION_WINDOW_MS = 60 * 60_000;
export const CLIENT_FOLLOW_UP_LIMIT = 6;
export const CLIENT_FOLLOW_UP_WINDOW_MS = 10 * 60_000;
export const GLOBAL_FOLLOW_UP_LIMIT = 60;
export const GLOBAL_FOLLOW_UP_WINDOW_MS = 60 * 60_000;

export type RateLimitDecision = {
  allowed: boolean;
  duplicate: boolean;
  retryAfterSeconds: number;
};

export function fixedWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function windowRetryAfterSeconds(
  nowMs: number,
  windowStart: number,
  windowMs: number,
): number {
  return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1_000));
}

export function decideInvestigationAdmission(input: {
  duplicate: boolean;
  clientCount: number;
  globalCount: number;
  nowMs: number;
  clientWindowStart: number;
  globalWindowStart: number;
}): RateLimitDecision {
  if (input.duplicate) {
    return { allowed: true, duplicate: true, retryAfterSeconds: 0 };
  }
  if (input.clientCount >= CLIENT_INVESTIGATION_LIMIT) {
    return {
      allowed: false,
      duplicate: false,
      retryAfterSeconds: windowRetryAfterSeconds(
        input.nowMs,
        input.clientWindowStart,
        CLIENT_INVESTIGATION_WINDOW_MS,
      ),
    };
  }
  if (input.globalCount >= GLOBAL_INVESTIGATION_LIMIT) {
    return {
      allowed: false,
      duplicate: false,
      retryAfterSeconds: windowRetryAfterSeconds(
        input.nowMs,
        input.globalWindowStart,
        GLOBAL_INVESTIGATION_WINDOW_MS,
      ),
    };
  }
  return { allowed: true, duplicate: false, retryAfterSeconds: 0 };
}

export function decideFollowUpAdmission(input: {
  duplicate: boolean;
  clientCount: number;
  globalCount: number;
  nowMs: number;
  clientWindowStart: number;
  globalWindowStart: number;
}): RateLimitDecision {
  if (input.duplicate) {
    return { allowed: true, duplicate: true, retryAfterSeconds: 0 };
  }
  if (input.clientCount >= CLIENT_FOLLOW_UP_LIMIT) {
    return {
      allowed: false,
      duplicate: false,
      retryAfterSeconds: windowRetryAfterSeconds(
        input.nowMs,
        input.clientWindowStart,
        CLIENT_FOLLOW_UP_WINDOW_MS,
      ),
    };
  }
  if (input.globalCount >= GLOBAL_FOLLOW_UP_LIMIT) {
    return {
      allowed: false,
      duplicate: false,
      retryAfterSeconds: windowRetryAfterSeconds(
        input.nowMs,
        input.globalWindowStart,
        GLOBAL_FOLLOW_UP_WINDOW_MS,
      ),
    };
  }
  return { allowed: true, duplicate: false, retryAfterSeconds: 0 };
}
