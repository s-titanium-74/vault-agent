import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp/adapter.ts", "src/mcp/stdio.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
