import type { InvestigationAgent } from "./investigation-agent";
import type { InvestigationWorkflowParams } from "./investigation-workflow";
import type { PublicRateLimitAgent } from "./public-rate-limit-agent";
import type { ResolutionMemoryAgent } from "./resolution-memory-agent";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  InvestigationAgent: DurableObjectNamespace<InvestigationAgent>;
  PublicRateLimitAgent: DurableObjectNamespace<PublicRateLimitAgent>;
  ResolutionMemoryAgent: DurableObjectNamespace<ResolutionMemoryAgent>;
  INVESTIGATION_WORKFLOW: Workflow<InvestigationWorkflowParams>;
}
