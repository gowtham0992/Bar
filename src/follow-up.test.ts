import { describe, expect, it } from "vitest";

import {
  canReserveFollowUp,
  MAX_FOLLOW_UP_CALLS,
  parseFollowUpAnswer,
} from "./follow-up";

describe("follow-up call budget", () => {
  it("allows exactly three lifetime reservations", () => {
    expect(MAX_FOLLOW_UP_CALLS).toBe(3);
    expect(canReserveFollowUp(0)).toBe(true);
    expect(canReserveFollowUp(2)).toBe(true);
    expect(canReserveFollowUp(3)).toBe(false);
    expect(canReserveFollowUp(4)).toBe(false);
  });
});

describe("parseFollowUpAnswer", () => {
  it("accepts an evidence-cited answer", () => {
    expect(
      parseFollowUpAnswer(
        JSON.stringify({
          answer: "The force-include points at a missing file.",
          evidenceIds: ["E-PKG-001", "E-PKG-002"],
        }),
        new Set(["E-PKG-001", "E-PKG-002"]),
      ),
    ).toEqual({
      answer: "The force-include points at a missing file.",
      evidenceIds: ["E-PKG-001", "E-PKG-002"],
    });
  });

  it("rejects an invented citation", () => {
    expect(() =>
      parseFollowUpAnswer(
        JSON.stringify({ answer: "Unsupported", evidenceIds: ["E-NOPE"] }),
        new Set(["E-PKG-001"]),
      ),
    ).toThrow("unknown_follow_up_evidence_id");
  });
});
