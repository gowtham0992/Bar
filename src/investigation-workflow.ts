import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
  type DefaultProgress,
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { getAgentByName } from "agents";

import { parseDiagnosis, type Diagnosis } from "./diagnosis";
import { getFixture, type FixtureId } from "./fixture-data";
import type { Env } from "./env";
import type { InvestigationAgent } from "./investigation-agent";
import { AI_STEP_CONFIG } from "./model-call-budget";
import {
  buildDiagnosisMessages,
  DIAGNOSIS_RESPONSE_FORMAT,
  MODEL_ID,
} from "./prompt";
import { normalizeWorkersAiResponse } from "./workers-ai-response";
import type { ReviewedMemoryMatch } from "./review";
import { demoMemoryAgentName, isDemoScopeId } from "./demo-session";

export type InvestigationWorkflowParams = {
  fixtureId: FixtureId;
  memoryScopeId: string;
};

export class InvestigationWorkflow extends AgentWorkflow<
  InvestigationAgent,
  InvestigationWorkflowParams,
  DefaultProgress,
  Env
> {
  async run(
    event: AgentWorkflowEvent<InvestigationWorkflowParams>,
    step: AgentWorkflowStep,
  ): Promise<Diagnosis> {
    const bundle = await step.do("load-sanitized-evidence", async () =>
      getFixture(event.payload.fixtureId),
    );
    if (!isDemoScopeId(event.payload.memoryScopeId)) {
      throw new NonRetryableError("invalid_demo_memory_scope");
    }
    await step.mergeAgentState({
      status: "collecting",
      evidenceIds: bundle.fixture.evidence_ids,
      milestones: [
        { stage: "load_evidence", status: "complete" },
        { stage: "recall_memory", status: "pending" },
        { stage: "diagnose", status: "pending" },
      ],
    });

    const reviewedMemory = await step.do(
      "find-reviewed-resolution",
      async (): Promise<ReviewedMemoryMatch | null> => {
        const memory = await getAgentByName(
          this.env.ResolutionMemoryAgent,
          demoMemoryAgentName(event.payload.memoryScopeId),
        );
        return memory.getLatestApprovedForFixture(event.payload.fixtureId);
      },
    );
    await step.mergeAgentState({
      memoryMatch: reviewedMemory,
      milestones: [
        { stage: "load_evidence", status: "complete" },
        { stage: "recall_memory", status: "complete" },
        { stage: "diagnose", status: "pending" },
      ],
    });
    await step.mergeAgentState({ status: "diagnosing" });

    const result = await step.do(
      "diagnose-with-workers-ai",
      AI_STEP_CONFIG,
      async () => {
        const claimed = await this.agent.claimModelCall();
        if (!claimed) {
          throw new NonRetryableError("model_call_limit_exceeded");
        }
        try {
          const response = await this.env.AI.run(MODEL_ID, {
            messages: buildDiagnosisMessages(bundle, reviewedMemory),
            temperature: 0.1,
            max_tokens: 1_200,
            response_format: DIAGNOSIS_RESPONSE_FORMAT,
          });
          const normalized = normalizeWorkersAiResponse(response);
          return {
            diagnosis: parseDiagnosis(
              normalized.text,
              new Set(bundle.fixture.evidence_ids),
              reviewedMemory !== null,
            ),
            usage: normalized.usage,
          };
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "workers_ai_diagnosis_failed";
          throw new NonRetryableError(message);
        }
      },
    );

    await step.mergeAgentState({
      status: "complete",
      diagnosis: result.diagnosis,
      modelUsage: result.usage,
      error: null,
      milestones: [
        { stage: "load_evidence", status: "complete" },
        { stage: "recall_memory", status: "complete" },
        { stage: "diagnose", status: "complete" },
      ],
    });
    await step.reportComplete(result.diagnosis);
    return result.diagnosis;
  }
}
