import { describe, expect, it } from "vitest";

import { parsePublicJsonBody } from "./public-request-body";

describe("public JSON request body", () => {
  it("parses a bounded JSON body", async () => {
    const request = new Request("https://bar.example/api/investigations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixtureId: "link-pr-60-package-v1" }),
    });

    await expect(parsePublicJsonBody(request)).resolves.toEqual({
      fixtureId: "link-pr-60-package-v1",
    });
  });

  it("stops reading once a body without Content-Length crosses 4 KiB", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024));
        if (pulls === 20) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://bar.example/api/investigations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    await expect(parsePublicJsonBody(request)).rejects.toMatchObject({
      code: "request_too_large",
      status: 413,
    });
    expect(pulls).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });
});
