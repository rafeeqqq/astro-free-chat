import { defineConfig } from "drizzle-kit";

// `npm run db:generate` compares src/db/schema.ts with the migrations in drizzle/ and writes the next one.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/postgres" },
});
