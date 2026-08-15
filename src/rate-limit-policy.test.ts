import { describe, expect, it } from "vitest";

import {
  CLIENT_FOLLOW_UP_LIMIT,
  CLIENT_INVESTIGATION_LIMIT,
  decideFollowUpAdmission,
  decideInvestigationAdmission,
  fixedWindowStart,
  GLOBAL_FOLLOW_UP_LIMIT,
  GLOBAL_INVESTIGATION_LIMIT,
} from "./rate-limit-policy";

const NOW = 650_000;
const CLIENT_WINDOW_START = 600_000;
const GLOBAL_WINDOW_START = 0;

function decide(overrides: Partial<Parameters<typeof decideInvestigationAdmission>[0]> = {}) {
  return decideInvestigationAdmission({
    duplicate: false,
    clientCount: 0,
    globalCount: 0,
    nowMs: NOW,
    clientWindowStart: CLIENT_WINDOW_START,
    globalWindowStart: GLOBAL_WINDOW_START,
    ...overrides,
  });
}

describe("public investigation rate-limit policy", () => {
  it("allows a new investigation below both limits", () => {
    expect(decide()).toEqual({
      allowed: true,
      duplicate: false,
      retryAfterSeconds: 0,
    });
  });

  it("allows an idempotent duplicate without consuming another admission", () => {
    expect(
      decide({
        duplicate: true,
        clientCount: CLIENT_INVESTIGATION_LIMIT,
        globalCount: GLOBAL_INVESTIGATION_LIMIT,
      }),
    ).toEqual({ allowed: true, duplicate: true, retryAfterSeconds: 0 });
  });

  it("rejects a new investigation at the per-client limit", () => {
    expect(decide({ clientCount: CLIENT_INVESTIGATION_LIMIT })).toEqual({
      allowed: false,
      duplicate: false,
      retryAfterSeconds: 550,
    });
  });

  it("rejects a new investigation at the global limit", () => {
    expect(decide({ globalCount: GLOBAL_INVESTIGATION_LIMIT })).toEqual({
      allowed: false,
      duplicate: false,
      retryAfterSeconds: 2_950,
    });
  });

  it("starts fixed windows on exact boundaries", () => {
    expect(fixedWindowStart(599_999, 600_000)).toBe(0);
    expect(fixedWindowStart(600_000, 600_000)).toBe(600_000);
  });
});

describe("public follow-up rate-limit policy", () => {
  const decideFollowUp = (
    overrides: Partial<Parameters<typeof decideFollowUpAdmission>[0]> = {},
  ) =>
    decideFollowUpAdmission({
      duplicate: false,
      clientCount: 0,
      globalCount: 0,
      nowMs: NOW,
      clientWindowStart: CLIENT_WINDOW_START,
      globalWindowStart: GLOBAL_WINDOW_START,
      ...overrides,
    });

  it("lets an idempotent duplicate bypass exhausted buckets", () => {
    expect(
      decideFollowUp({
        duplicate: true,
        clientCount: CLIENT_FOLLOW_UP_LIMIT,
        globalCount: GLOBAL_FOLLOW_UP_LIMIT,
      }),
    ).toEqual({ allowed: true, duplicate: true, retryAfterSeconds: 0 });
  });

  it("enforces both paid-call admission ceilings", () => {
    expect(decideFollowUp({ clientCount: CLIENT_FOLLOW_UP_LIMIT })).toMatchObject({
      allowed: false,
      retryAfterSeconds: 550,
    });
    expect(decideFollowUp({ globalCount: GLOBAL_FOLLOW_UP_LIMIT })).toMatchObject({
      allowed: false,
      retryAfterSeconds: 2_950,
    });
  });
});
