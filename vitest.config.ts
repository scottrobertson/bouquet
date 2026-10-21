import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config so the React Router plugin doesn't load during tests. These
// cover the logic the browser runs itself; the server's tests live in server/.
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
