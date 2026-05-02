import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@mindpal/device-agent-sdk": path.resolve(__dirname, "../../packages/device-agent-sdk/src"),
    },
  },
  test: {
    globals: false,
  },
});
