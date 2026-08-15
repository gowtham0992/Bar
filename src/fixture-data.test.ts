import { describe, expect, it } from "vitest";

import { getInvestigationEvidence } from "./fixture-data";

describe("getInvestigationEvidence", () => {
  it("returns only requested sanitized evidence in source order", () => {
    const evidence = getInvestigationEvidence("link-pr-60-package-v1", [
      "E-PKG-004",
      "E-PKG-001",
    ]);

    expect(evidence.map((item) => item.id)).toEqual([
      "E-PKG-001",
      "E-PKG-004",
    ]);
    expect(evidence.every((item) => item.content.length > 0)).toBe(true);
  });

  it("does not expose unknown or expected-result records", () => {
    expect(
      getInvestigationEvidence("link-pr-60-windows-smoke-v1", [
        "E-WIN-001",
        "E-EXPECTED-999",
      ]).map((item) => item.id),
    ).toEqual(["E-WIN-001"]);
  });
});
