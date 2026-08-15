import { describe, expect, it } from "vitest";

import {
  canMutateInvestigation,
  createDemoSession,
  demoMemoryAgentName,
  deriveDemoScopeId,
  readDemoSession,
  readDemoSessionToken,
} from "./demo-session";

describe("public demo sessions", () => {
  it("accepts only the exact opaque session-cookie format", () => {
    const token = "a".repeat(64);
    expect(readDemoSessionToken(`theme=light; bar_demo_session=${token}`)).toBe(token);
    expect(readDemoSessionToken("bar_demo_session=../../shared-memory")).toBeNull();
    expect(readDemoSessionToken("bar_demo_session=abc")).toBeNull();
  });

  it("maps different browser sessions to different memory Agent names", async () => {
    const first = demoMemoryAgentName(await deriveDemoScopeId("a".repeat(64)));
    const second = demoMemoryAgentName(await deriveDemoScopeId("b".repeat(64)));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^demo-memory-v1-[a-f0-9]{64}$/);
  });

  it("authorizes writes only for the investigation owner scope", () => {
    expect(canMutateInvestigation("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(canMutateInvestigation("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(canMutateInvestigation("a".repeat(64), null)).toBe(false);
    expect(canMutateInvestigation(null, "a".repeat(64))).toBe(false);
  });

  it("issues an HttpOnly SameSite cookie and requires Secure on HTTPS", async () => {
    const session = await createDemoSession(new Request("https://bar.example/api/fixtures"));

    expect(session.scopeId).toMatch(/^[a-f0-9]{64}$/);
    expect(session.setCookie).toMatch(
      /^bar_demo_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
    const restored = await readDemoSession(
      new Request("https://bar.example/api/fixtures", {
        headers: { cookie: session.setCookie!.split(";")[0] },
      }),
    );
    expect(restored?.scopeId).toBe(session.scopeId);
    expect(restored?.setCookie).toBeNull();
  });
});
