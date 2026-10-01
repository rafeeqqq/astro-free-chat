// Applies pending database migrations (drizzle/*.sql) exactly once. Run it as a one-off step on each deploy,
// BEFORE the new pods start (Devtron pre-deployment stage / a Kubernetes Job / the "migrate" service in
// docker-compose), never inside the app pods.
//
//   npm run db:migrate          (needs DATABASE_URL)
//
// Safe if two copies start at once: a Postgres advisory lock lets one run while the other waits, then finds nothing to do.
// Already-applied migrations are recorded in drizzle.__drizzle_migrations and skipped.
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createSql, createDb } from "../src/db/client.ts";

const LOCK_ID = 7_204_311; // any constant; shared by every copy of this job

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = createSql(url, { max: 1 });
  const started = Date.now();
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    const before = await applied(sql);
    await migrate(createDb(sql), { migrationsFolder: "drizzle" });
    const after = await applied(sql);
    console.log(`migrations: ${after - before} applied, ${after} total, ${Date.now() - started} ms`);
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function applied(sql: ReturnType<typeof createSql>): Promise<number> {
  const [row] = await sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!row.t) return 0;
  const [n] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return n.n;
}

main().catch((err) => {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exit(1);
});
