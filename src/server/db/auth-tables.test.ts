import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";

describe("Auth.js tables", () => {
  // The real check is the type check: DrizzleAdapter's types reject tables that don't fit.
  it("REQ-5: fit @auth/drizzle-adapter for database sessions", () => {
    const db = drizzle.mock({ schema });
    const adapter = DrizzleAdapter(db, {
      usersTable: schema.users,
      accountsTable: schema.accounts,
      sessionsTable: schema.sessions,
      verificationTokensTable: schema.verificationTokens,
    });
    expect(adapter.createUser).toBeTypeOf("function");
    expect(adapter.getSessionAndUser).toBeTypeOf("function");
  });

  // No email and no GitHub tokens are stored (2026-10-16): CHECKs keep these null, so they must be nullable.
  it("REQ-5: columns the adapter needs but the database keeps empty are nullable", () => {
    const users = getTableColumns(schema.users);
    const accounts = getTableColumns(schema.accounts);
    const neverWritten = [
      users.email,
      users.emailVerified,
      accounts.refresh_token,
      accounts.access_token,
      accounts.expires_at,
      accounts.token_type,
      accounts.scope,
      accounts.id_token,
      accounts.session_state,
    ];
    for (const column of neverWritten) {
      expect(column.notNull, column.name).toBe(false);
      expect(column.hasDefault, column.name).toBe(false);
    }
  });
});
