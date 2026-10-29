import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vault-agent/core/portable": new URL(
        "./packages/core/src/portable/index.ts",
        import.meta.url,
      ).pathname,
      "@vault-agent/core/local": new URL(
        "./packages/core/src/local/index.ts",
        import.meta.url,
      ).pathname,
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
    exclude: ["packages/cloudflare/**", "**/node_modules/**"],
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});
