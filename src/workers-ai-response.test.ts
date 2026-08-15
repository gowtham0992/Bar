import { describe, expect, it } from "vitest";

import { normalizeWorkersAiResponse } from "./workers-ai-response";

describe("normalizeWorkersAiResponse", () => {
  it("accepts the model's direct-string response variant", () => {
    expect(normalizeWorkersAiResponse('{"outcome":"diagnosed"}')).toEqual({
      text: '{"outcome":"diagnosed"}',
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    });
  });

  it("retains token usage from the object response variant", () => {
    expect(
      normalizeWorkersAiResponse({
        response: '{"outcome":"diagnosed"}',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
    ).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("accepts a parsed diagnosis object from JSON-schema mode", () => {
    const diagnosis = {
      outcome: "diagnosed",
      summary: "Summary",
      explanation: "Explanation",
      confidence: 0.9,
      evidenceIds: ["E-1"],
      uncertainty: "None",
      proposedResolution: "Apply the evidence-grounded repair.",
    };
    expect(normalizeWorkersAiResponse(diagnosis)).toEqual({
      text: JSON.stringify(diagnosis),
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    });
  });

  it("accepts a parsed diagnosis nested under response", () => {
    const diagnosis = {
      outcome: "diagnosed",
      summary: "Summary",
      explanation: "Explanation",
      confidence: 0.9,
      evidenceIds: ["E-1"],
      uncertainty: "None",
      proposedResolution: "Apply the evidence-grounded repair.",
    };
    expect(
      normalizeWorkersAiResponse({
        response: diagnosis,
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    ).toEqual({
      text: JSON.stringify(diagnosis),
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });
  });

  it("rejects responses without generated text", () => {
    expect(() => normalizeWorkersAiResponse({ request_id: "async" })).toThrow(
      "workers_ai_response_missing",
    );
  });

  it("accepts a parsed follow-up object with its own required fields", () => {
    const followUp = { answer: "The sdist lacks the file.", evidenceIds: ["E-1"] };
    expect(
      normalizeWorkersAiResponse(followUp, ["answer", "evidenceIds"]),
    ).toMatchObject({ text: JSON.stringify(followUp) });
  });
});
