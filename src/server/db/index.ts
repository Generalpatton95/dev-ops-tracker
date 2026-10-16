// T-5 (REQ-5, REQ-7): the app's database client. Plain node-postgres through DATABASE_URL,
// so any Postgres works; Neon is just one place the URL can point.
import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

// Kept on globalThis so dev hot reloads reuse one pool instead of opening a new one each time.
const globalForDb = globalThis as unknown as { dotDb?: Database };

// Created on first use, never at import, so `next build` and tests that don't touch the
// database never connect. The pool itself only connects when the first query runs.
export function getDb(): Database {
  if (!globalForDb.dotDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForDb.dotDb = drizzle(new Pool({ connectionString }), { schema });
  }
  return globalForDb.dotDb;
}
