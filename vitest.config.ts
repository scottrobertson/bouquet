import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config so the React Router plugin doesn't load during tests. We
// only cover pure logic (no DB, no network), so a plain node environment is enough.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
