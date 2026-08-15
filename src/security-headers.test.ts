import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS, withSecurityHeaders } from "./security-headers";

describe("security response headers", () => {
  it("adds the security policy without losing response metadata", async () => {
    const response = withSecurityHeaders(
      new Response("fixture", {
        status: 202,
        headers: { "cache-control": "no-store", "x-existing": "kept" },
      }),
      "bar_demo_session=test; Path=/; HttpOnly; SameSite=Lax; Secure",
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("fixture");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-existing")).toBe("kept");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
