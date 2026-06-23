import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infra/db/events-schema.ts",
  out: "./drizzle/events",
  dbCredentials: {
    url: "./.backend-data/events.db",
  },
});
