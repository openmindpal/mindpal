import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    root: path.resolve(__dirname),
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
