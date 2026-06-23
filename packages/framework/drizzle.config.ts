import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/checkpointers/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./checkpointer.sqlite",
  },
});
