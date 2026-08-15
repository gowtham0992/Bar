import { getAgentByName } from "agents";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import type { Diagnosis } from "../diagnosis";
import type { PrivateEnv } from "../private-env";
import {
  executePrivateInvestigation,
  PrivateWorkflowTerminalError,
  type PrivateDiagnosisAi,
  type PrivateDiagnosisWorkflowAgent,
  type PrivateWorkflowStep,
} from "./private-workflow-execution";

export type PrivateInvestigationWorkflowParams = {
  investigationId: string;
  repositoryScope: string;
};

export class PrivateInvestigationWorkflow extends WorkflowEntrypoint<
  PrivateEnv,
  PrivateInvestigationWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<PrivateInvestigationWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<Diagnosis> {
    const agent = (await getAgentByName(
      this.env.PrivateRepositoryAgent,
      event.payload.repositoryScope,
    )) as unknown as PrivateDiagnosisWorkflowAgent;
    try {
      return await executePrivateInvestigation(
        {
          investigationId: event.payload.investigationId,
          workflowInstanceId: event.instanceId,
          agent,
          ai: this.env.AI as unknown as PrivateDiagnosisAi,
        },
        step as unknown as PrivateWorkflowStep,
      );
    } catch (error) {
      if (error instanceof PrivateWorkflowTerminalError) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}
