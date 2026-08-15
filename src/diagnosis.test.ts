import { describe, expect, it } from "vitest";

import { parseDiagnosis } from "./diagnosis";

describe("parseDiagnosis", () => {
  it("accepts a bounded diagnosis citing known evidence", () => {
    expect(
      parseDiagnosis(
        JSON.stringify({
          outcome: "diagnosed",
          summary: "The package build cannot find .linkignore.",
          explanation: "The wheel force-include references a file absent from the sdist build context.",
          confidence: 0.96,
          evidenceIds: ["E-PKG-001", "E-PKG-002"],
          uncertainty: "The proposed source change has not been executed in this run.",
          proposedResolution: "Include .linkignore in the sdist build context.",
          memoryAssessment: "not_available",
          memoryExplanation: "No reviewed memory was supplied.",
        }),
        new Set(["E-PKG-001", "E-PKG-002", "E-PKG-003", "E-PKG-004"]),
      ),
    ).toMatchObject({ outcome: "diagnosed", confidence: 0.96 });
  });

  it("rejects a diagnosis that invents an evidence citation", () => {
    expect(() =>
      parseDiagnosis(
        JSON.stringify({
          outcome: "diagnosed",
          summary: "Unsupported claim",
          explanation: "Unsupported explanation",
          confidence: 0.8,
          evidenceIds: ["E-SECRET-999"],
          uncertainty: "none",
          proposedResolution: "Unsupported fix",
          memoryAssessment: "not_available",
          memoryExplanation: "No reviewed memory was supplied.",
        }),
        new Set(["E-PKG-001"]),
      ),
    ).toThrow("unknown_evidence_id");
  });

  it("requires an available memory to be evaluated rather than marked unavailable", () => {
    expect(() =>
      parseDiagnosis(
        JSON.stringify({
          outcome: "diagnosed",
          summary: "The current source distribution omits .linkignore.",
          explanation: "The current wheel build requires the missing file.",
          confidence: 0.9,
          evidenceIds: ["E-PKG-R2-001"],
          uncertainty: "The remediation has not been run.",
          proposedResolution: "Include .linkignore in the current sdist.",
          memoryAssessment: "not_available",
          memoryExplanation: "No memory considered.",
        }),
        new Set(["E-PKG-R2-001"]),
        true,
      ),
    ).toThrow("invalid_memory_assessment");
  });

  it("accepts a reviewed-memory assessment citing only current evidence", () => {
    expect(
      parseDiagnosis(
        JSON.stringify({
          outcome: "diagnosed",
          summary: "The current source distribution omits .linkignore.",
          explanation: "The current artifact listing and failure agree.",
          confidence: 0.94,
          evidenceIds: ["E-PKG-R2-001", "E-PKG-R2-002"],
          uncertainty: "The proposed fix has not been executed.",
          proposedResolution: "Include .linkignore in the current sdist.",
          memoryAssessment: "applies",
          memoryExplanation: "The current evidence independently shows the same failure family.",
        }),
        new Set(["E-PKG-R2-001", "E-PKG-R2-002"]),
        true,
      ),
    ).toMatchObject({ memoryAssessment: "applies", confidence: 0.94 });
  });
});
