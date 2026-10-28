import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@vault-agent/core/portable": fileURLToPath(
        new URL("../core/src/portable/index.ts", import.meta.url),
      ),
      zod: fileURLToPath(
        new URL("./node_modules/zod/v3/index.js", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
