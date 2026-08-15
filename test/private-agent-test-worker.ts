import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export { PrivateRepositoryAgent } from "../src/private-ingestion/repository-agent";

type TestWorkflowParams = {
  investigationId: string;
  repositoryScope: string;
};

export class TestPrivateWorkflow extends WorkflowEntrypoint<
  Record<string, never>,
  TestWorkflowParams
> {
  async run(
    _event: WorkflowEvent<TestWorkflowParams>,
    _step: WorkflowStep,
  ): Promise<{ completed: true }> {
    return { completed: true };
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
