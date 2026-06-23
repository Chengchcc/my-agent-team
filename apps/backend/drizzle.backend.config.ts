import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  casing: "snake_case",
  schema: "./src/infra/db/schema.ts",
  out: "./drizzle/backend",
  dbCredentials: {
    url: "./.backend-data/backend.db",
  },
});
