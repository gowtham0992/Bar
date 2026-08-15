import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export type VerifiedAccessClaims = {
  authenticationType: "service_token";
  issuer: string;
  audiences: string[];
  serviceTokenClientId: string;
  expiresAt: number;
};

export interface AccessJwtVerifier {
  verify(request: Request): Promise<VerifiedAccessClaims>;
}

export class AccessAuthenticationError extends Error {
  constructor(message = "Access authentication failed.") {
    super(message);
  }
}

export class AccessAuthenticationUnavailableError extends Error {
  constructor(message = "Access verification is temporarily unavailable.") {
    super(message);
  }
}

export type CloudflareAccessJwtVerifierConfig = {
  teamDomain: string;
  audience: string;
  serviceTokenClientId: string;
  fetchImplementation?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function isJwksInfrastructureError(error: unknown): boolean {
  return (
    error instanceof AccessAuthenticationUnavailableError ||
    ["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JWK_INVALID"].includes(
      errorCode(error) ?? "",
    )
  );
}

function validateTeamDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_access_team_domain");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid_access_team_domain");
  }
  return url.origin;
}

export class CloudflareAccessJwtVerifier implements AccessJwtVerifier {
  private readonly teamDomain: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: CloudflareAccessJwtVerifierConfig) {
    this.teamDomain = validateTeamDomain(config.teamDomain);
    if (config.audience.length < 16 || config.serviceTokenClientId.length < 16) {
      throw new Error("invalid_access_verifier_config");
    }
    const fetchImplementation = config.fetchImplementation ?? fetch;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.teamDomain}/cdn-cgi/access/certs`),
      {
        timeoutDuration: 5_000,
        [customFetch]: async (url, init) => {
          let response: Response;
          try {
            response = await fetchImplementation(url, init);
          } catch {
            throw new AccessAuthenticationUnavailableError();
          }
          if (response.status !== 200) {
            throw new AccessAuthenticationUnavailableError();
          }
          try {
            const document: unknown = await response.clone().json();
            if (
              !isRecord(document) ||
              !Array.isArray(document.keys) ||
              !document.keys.every(isRecord)
            ) {
              throw new AccessAuthenticationUnavailableError();
            }
          } catch (error) {
            if (error instanceof AccessAuthenticationUnavailableError) throw error;
            throw new AccessAuthenticationUnavailableError();
          }
          return response;
        },
      },
    );
  }

  async verify(request: Request): Promise<VerifiedAccessClaims> {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) throw new AccessAuthenticationError();
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
        issuer: this.teamDomain,
        audience: this.config.audience,
        algorithms: ["RS256"],
      });
      const audiences = typeof payload.aud === "string"
        ? [payload.aud]
        : Array.isArray(payload.aud)
          ? payload.aud
          : [];
      if (
        protectedHeader.alg !== "RS256" ||
        payload.type !== "app" ||
        payload.sub !== "" ||
        payload.common_name !== this.config.serviceTokenClientId ||
        typeof payload.exp !== "number" ||
        !audiences.includes(this.config.audience)
      ) {
        throw new AccessAuthenticationError();
      }
      return {
        authenticationType: "service_token",
        issuer: this.teamDomain,
        audiences,
        serviceTokenClientId: this.config.serviceTokenClientId,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (isJwksInfrastructureError(error)) {
        throw new AccessAuthenticationUnavailableError();
      }
      throw new AccessAuthenticationError();
    }
  }
}
