import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const configPath = process.env.CONFIG_PATH ?? "./data";

export default defineConfig({
  schema: "./app/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: join(configPath, "bouquet.db"),
  },
});
