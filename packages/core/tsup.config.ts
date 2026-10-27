import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/portable/index.ts", "src/local/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
