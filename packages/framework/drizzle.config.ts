import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  casing: "snake_case",
  schema: "./src/checkpointers/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./checkpointer.sqlite",
  },
});
