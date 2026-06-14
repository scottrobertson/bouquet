import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the app DB at a throwaway dir before any app module loads, so tests
// never touch the real ./data database. Each test file gets its own.
process.env.CONFIG_PATH = mkdtempSync(join(tmpdir(), "bouquet-test-"));
