import { getAgentByName } from "agents";

import { ApiInputError, errorResponse } from "./api";
import type { PrivateEnv } from "./private-env";
import { handlePrivateApiRequest } from "./private-api";
import { withSecurityHeaders } from "./security-headers";
import { CloudflareAccessJwtVerifier } from "./private-ingestion/access";
import { createPrivateIngestionHandler } from "./private-ingestion/handler";
import { deriveRepositoryScope } from "./private-ingestion/scopes";
import {
  createPrivateInvestigationSummaryHandler,
  isPrivateInvestigationSummaryPath,
} from "./private-ingestion/summary";

export { PrivateInvestigationWorkflow } from "./private-ingestion/private-workflow";
export { PrivateRepositoryAgent } from "./private-ingestion/repository-agent";

const LINK_REPOSITORY = "gowtham0992/link";
const ALLOWED_REPOSITORIES = new Map([
  [
    LINK_REPOSITORY,
    { workflowName: "CI", workflowPath: ".github/workflows/ci.yml" },
  ],
]);

export default {
  async fetch(request: Request, env: PrivateEnv): Promise<Response> {
    const url = new URL(request.url);
    const currentRequestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const response = await (async (): Promise<Response> => {
      try {
        if (isPrivateInvestigationSummaryPath(url.pathname)) {
          const repositoryScope = await deriveRepositoryScope(LINK_REPOSITORY);
          return createPrivateInvestigationSummaryHandler({
            access: () =>
              new CloudflareAccessJwtVerifier({
                teamDomain: env.ACCESS_TEAM_DOMAIN,
                audience: env.ACCESS_SUMMARY_AUDIENCE,
                serviceTokenClientId: env.ACCESS_SERVICE_TOKEN_CLIENT_ID,
              }),
            expectedRepository: LINK_REPOSITORY,
            expectedRepositoryScope: repositoryScope,
            repositoryStore: async () =>
              getAgentByName(env.PrivateRepositoryAgent, repositoryScope),
          })(request);
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/v1/github/investigations"
        ) {
          return createPrivateIngestionHandler({
            access: () =>
              new CloudflareAccessJwtVerifier({
                teamDomain: env.ACCESS_TEAM_DOMAIN,
                audience: env.ACCESS_AUDIENCE,
                serviceTokenClientId: env.ACCESS_SERVICE_TOKEN_CLIENT_ID,
              }),
            allowedRepositories: ALLOWED_REPOSITORIES,
            repositoryStore: async (repositoryScope) =>
              getAgentByName(env.PrivateRepositoryAgent, repositoryScope),
          })(request);
        }

        const repositoryScope = await deriveRepositoryScope(LINK_REPOSITORY);
        const apiResponse = await handlePrivateApiRequest(request, {
          repositoryAgent: async () =>
            getAgentByName(env.PrivateRepositoryAgent, repositoryScope),
          ai: env.AI,
        });
        if (apiResponse !== null) return apiResponse;

        const pageMatch = url.pathname.match(
          /^\/private\/investigations\/([a-f0-9]{64})$/,
        );
        if (request.method === "GET" && pageMatch) {
          const assetUrl = new URL("/index.html", request.url);
          return env.ASSETS.fetch(new Request(assetUrl, request));
        }
        if (
          request.method === "GET" &&
          ["/private-app.js", "/private.css"].includes(url.pathname)
        ) {
          return env.ASSETS.fetch(request);
        }
        return Response.json(
          {
            error: {
              code: "not_found",
              message: "Route not found.",
              request_id: currentRequestId,
            },
          },
          { status: 404, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof ApiInputError) {
          return errorResponse(error, currentRequestId);
        }
        console.error("private_request_failed", { requestId: currentRequestId });
        return Response.json(
          {
            error: {
              code: "internal_error",
              message: "The request could not be completed.",
              request_id: currentRequestId,
            },
          },
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
    })();
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<PrivateEnv>;
