import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config so the React Router plugin doesn't load during tests. A
// plain node environment is enough; DB-backed tests run against a temp database.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Redirect the DB to a temp dir before any app module loads. Harmless for
    // the pure tests, which never open a connection.
    setupFiles: ["test/setup-db.ts"],
  },
});
