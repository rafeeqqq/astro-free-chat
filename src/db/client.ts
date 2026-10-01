// Database client for any Postgres-compatible database (Postgres, RDS, Aurora, Cloud SQL, Neon, …), configured only
// through DATABASE_URL (add ?sslmode=require for managed databases). One small pool per pod: with N pods the database
// sees at most N × DB_POOL_MAX connections, so size DB_POOL_MAX against the database's connection limit.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export type Sql = postgres.Sql;

export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,          // release idle connections (pods scale down cleanly)
    connect_timeout: 10,
    prepare: false,            // works behind PgBouncer / connection poolers in transaction mode
    onnotice: () => {},        // no "relation already exists" notices in pod logs
  });
}

/** Typed query builder over the same connection pool, for code that wants it. */
export const createDb = (sql: Sql) => drizzle(sql, { schema });
