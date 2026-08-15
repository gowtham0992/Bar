import type { PrivateRepositoryAgent } from "./private-ingestion/repository-agent";
import type { PrivateInvestigationWorkflowParams } from "./private-ingestion/private-workflow";

export interface PrivateEnv {
  AI: Ai;
  ASSETS: Fetcher;
  PrivateRepositoryAgent: DurableObjectNamespace<PrivateRepositoryAgent>;
  PRIVATE_INVESTIGATION_WORKFLOW: Workflow<PrivateInvestigationWorkflowParams>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ACCESS_SUMMARY_AUDIENCE: string;
  ACCESS_SERVICE_TOKEN_CLIENT_ID: string;
}
