import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AccessAuthenticationError,
  AccessAuthenticationUnavailableError,
  CloudflareAccessJwtVerifier,
} from "./access";

const ISSUER = "https://bar.cloudflareaccess.com";
const AUDIENCE = "private-ingestion-audience";
const CLIENT_ID = "link-actions-client.access";
const KEY_ID = "access-signing-key";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: KEY_ID,
    use: "sig",
  };
});

function verifier(jwksFetch?: typeof fetch): CloudflareAccessJwtVerifier {
  return new CloudflareAccessJwtVerifier({
    teamDomain: ISSUER,
    audience: AUDIENCE,
    serviceTokenClientId: CLIENT_ID,
    fetchImplementation:
      jwksFetch ?? (async () => Response.json({ keys: [publicJwk] })),
  });
}

async function signedToken(
  overrides: {
    issuer?: string;
    audience?: string;
    clientId?: string;
    subject?: string;
    expiresAt?: number;
    signingKey?: CryptoKey;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    type: "app",
    common_name: overrides.clientId ?? CLIENT_ID,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? "")
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 60)
    .sign(overrides.signingKey ?? privateKey);
}

function request(token: string): Request {
  return new Request("https://bar-private.example/api/v1/github/investigations", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

describe("CloudflareAccessJwtVerifier", () => {
  it("accepts a real RS256 service-token JWT from the configured Access application", async () => {
    const claims = await verifier().verify(request(await signedToken()));

    expect(claims).toEqual({
      authenticationType: "service_token",
      issuer: ISSUER,
      audiences: [AUDIENCE],
      serviceTokenClientId: CLIENT_ID,
      expiresAt: expect.any(Number),
    });
  });

  it.each([
    ["issuer", { issuer: "https://wrong.cloudflareaccess.com" }],
    ["audience", { audience: "wrong-audience" }],
    ["client ID", { clientId: "another-client-id.access" }],
    ["subject", { subject: "human-user-subject" }],
    ["expiry", { expiresAt: 1 }],
  ] as const)("rejects a JWT with the wrong %s", async (_label, overrides) => {
    await expect(
      verifier().verify(request(await signedToken(overrides))),
    ).rejects.toBeInstanceOf(AccessAuthenticationError);
  });

  it("rejects a JWT with an invalid signature", async () => {
    const otherPair = await generateKeyPair("RS256");
    const token = await signedToken({ signingKey: otherPair.privateKey });

    await expect(verifier().verify(request(token))).rejects.toBeInstanceOf(
      AccessAuthenticationError,
    );
  });

  it("classifies a failed JWKS request as temporarily unavailable", async () => {
    const unavailableFetch: typeof fetch = async () => {
      throw new TypeError("temporary network failure");
    };

    await expect(
      verifier(unavailableFetch).verify(request(await signedToken())),
    ).rejects.toBeInstanceOf(AccessAuthenticationUnavailableError);
  });

  it("classifies a JWKS timeout as temporarily unavailable", async () => {
    const timeoutFetch: typeof fetch = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    await expect(
      verifier(timeoutFetch).verify(request(await signedToken())),
    ).rejects.toBeInstanceOf(AccessAuthenticationUnavailableError);
  });

  it("classifies a non-200 JWKS response as temporarily unavailable", async () => {
    const unavailableFetch: typeof fetch = async () =>
      new Response("temporarily unavailable", { status: 503 });

    await expect(
      verifier(unavailableFetch).verify(request(await signedToken())),
    ).rejects.toBeInstanceOf(AccessAuthenticationUnavailableError);
  });

  it("classifies malformed JWKS JSON as temporarily unavailable", async () => {
    const malformedFetch: typeof fetch = async () =>
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      verifier(malformedFetch).verify(request(await signedToken())),
    ).rejects.toBeInstanceOf(AccessAuthenticationUnavailableError);
  });
});
