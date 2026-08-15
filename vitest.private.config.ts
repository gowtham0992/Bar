import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.private.test.jsonc" },
    }),
  ],
  test: {
    include: ["test/private-repository-agent.sqlite.test.ts"],
  },
});
