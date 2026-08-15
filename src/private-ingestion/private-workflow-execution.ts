import { parseDiagnosis, type Diagnosis } from "../diagnosis";
import { AI_STEP_CONFIG } from "../model-call-budget";
import { DIAGNOSIS_RESPONSE_FORMAT, MODEL_ID } from "../prompt";
import {
  normalizeWorkersAiResponse,
  type ModelUsage,
} from "../workers-ai-response";
import { buildPrivateDiagnosisMessages } from "./model-input";
import type { PrivateEvidencePacket } from "./packet";
import type { PrivateReviewedMemory } from "./store";

const RETRYABLE_AGENT_STEP = {
  retries: { limit: 3, delay: 0, backoff: "constant" },
  timeout: "30 seconds",
} as const;

export interface PrivateWorkflowStep {
  do<T>(
    name: string,
    configOrCallback: unknown,
    maybeCallback?: () => Promise<T>,
  ): Promise<T>;
}

export interface PrivateDiagnosisWorkflowAgent {
  getWorkflowPacket(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<PrivateEvidencePacket>;
  markCollecting(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<void>;
  getReviewedMemory(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<PrivateReviewedMemory | null>;
  claimModelCall(
    investigationId: string,
    workflowInstanceId: string,
  ): Promise<boolean>;
  completeInvestigation(
    investigationId: string,
    workflowInstanceId: string,
    diagnosis: Diagnosis,
    usage: ModelUsage,
  ): Promise<void>;
  failInvestigation(
    investigationId: string,
    workflowInstanceId: string,
    errorCode: string,
  ): Promise<void>;
}

export interface PrivateDiagnosisAi {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type PrivateInvestigationExecution = {
  investigationId: string;
  workflowInstanceId: string;
  agent: PrivateDiagnosisWorkflowAgent;
  ai: PrivateDiagnosisAi;
};

export class PrivateWorkflowTerminalError extends Error {}

function workflowErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    ["model_call_limit_exceeded", "workers_ai_diagnosis_failed"].includes(
      error.message,
    )
  ) {
    return error.message;
  }
  return "private_workflow_failed";
}

export async function executePrivateInvestigation(
  execution: PrivateInvestigationExecution,
  step: PrivateWorkflowStep,
): Promise<Diagnosis> {
  const { investigationId, workflowInstanceId, agent } = execution;
  try {
    const packet = await step.do(
      "load-private-evidence",
      RETRYABLE_AGENT_STEP,
      () => agent.getWorkflowPacket(investigationId, workflowInstanceId),
    );
    await step.do("mark-private-evidence-loaded", RETRYABLE_AGENT_STEP, () =>
      agent.markCollecting(investigationId, workflowInstanceId),
    );
    const reviewedMemory = await step.do(
      "find-private-reviewed-resolution",
      RETRYABLE_AGENT_STEP,
      () => agent.getReviewedMemory(investigationId, workflowInstanceId),
    );

    const result = await step.do(
      "diagnose-with-workers-ai",
      AI_STEP_CONFIG,
      async () => {
        const claimed = await agent.claimModelCall(
          investigationId,
          workflowInstanceId,
        );
        if (!claimed) throw new Error("model_call_limit_exceeded");
        try {
          const response = await execution.ai.run(MODEL_ID, {
            messages: buildPrivateDiagnosisMessages(packet, reviewedMemory),
            temperature: 0.1,
            max_tokens: 1_200,
            response_format: DIAGNOSIS_RESPONSE_FORMAT,
          });
          const normalized = normalizeWorkersAiResponse(response);
          return {
            diagnosis: parseDiagnosis(
              normalized.text,
              new Set(packet.evidence.map((item) => item.id)),
              reviewedMemory !== null,
            ),
            usage: normalized.usage,
          };
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "model_call_limit_exceeded"
          ) {
            throw error;
          }
          throw new Error("workers_ai_diagnosis_failed");
        }
      },
    );

    await step.do("save-private-diagnosis", RETRYABLE_AGENT_STEP, () =>
      agent.completeInvestigation(
        investigationId,
        workflowInstanceId,
        result.diagnosis,
        result.usage,
      ),
    );
    return result.diagnosis;
  } catch (error) {
    const errorCode = workflowErrorCode(error);
    try {
      await step.do("save-private-failure", RETRYABLE_AGENT_STEP, () =>
        agent.failInvestigation(
          investigationId,
          workflowInstanceId,
          errorCode,
        ),
      );
    } catch {
      throw new PrivateWorkflowTerminalError(
        "private_failure_state_unavailable",
      );
    }
    throw new PrivateWorkflowTerminalError(errorCode);
  }
}
