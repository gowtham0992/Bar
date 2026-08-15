import { describe, expect, it } from "vitest";

import {
  AI_STEP_CONFIG,
  canReserveModelCall,
  MAX_MODEL_CALLS_PER_INVESTIGATION,
} from "./model-call-budget";

describe("model call budget", () => {
  it("allows only the first model-call reservation", () => {
    expect(MAX_MODEL_CALLS_PER_INVESTIGATION).toBe(1);
    expect(canReserveModelCall(0)).toBe(true);
    expect(canReserveModelCall(1)).toBe(false);
    expect(canReserveModelCall(2)).toBe(false);
  });

  it("configures the paid AI step for one total attempt", () => {
    expect(AI_STEP_CONFIG).toMatchObject({
      retries: { limit: 1 },
    });
  });
});
