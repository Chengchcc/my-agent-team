import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  casing: "snake_case",
  schema: "./src/infra/db/events-schema.ts",
  out: "./drizzle/events",
  dbCredentials: {
    url: "./.backend-data/events.db",
  },
});
