import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vault-agent/cli": new URL(
        "./packages/cli/src/index.ts",
        import.meta.url,
      ).pathname,
      "@vault-agent/core": new URL(
        "./packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
      "@vault-agent/server": new URL(
        "./packages/server/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});
