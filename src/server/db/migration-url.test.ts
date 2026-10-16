import { describe, expect, it } from "vitest";
import { migrationDatabaseUrl } from "./migration-url";

const pooled = "postgres://u:p@pooled.example/db";
const direct = "postgres://u:p@direct.example/db";

describe("migrationDatabaseUrl", () => {
  it("REQ-5: migrations use DATABASE_URL_UNPOOLED when it is set", () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct })).toBe(
      direct,
    );
  });

  it("REQ-5: migrations fall back to DATABASE_URL", () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: pooled })).toBe(pooled);
  });

  it("REQ-5: an empty DATABASE_URL_UNPOOLED counts as unset", () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: "" })).toBe(pooled);
    expect(migrationDatabaseUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: "  " })).toBe(
      pooled,
    );
  });

  it("REQ-5: no URL at all gives undefined, so drizzle-kit migrate fails", () => {
    expect(migrationDatabaseUrl({})).toBeUndefined();
    expect(migrationDatabaseUrl({ DATABASE_URL: "" })).toBeUndefined();
  });
});
