import { describe, expect, it } from "vitest";
import { migrationDatabaseUrl } from "../src/server/db/migration-url";
import {
  childEnv,
  decideMigration,
  migrationUrl,
  redact,
  secretsFrom,
} from "./migrate-on-deploy-lib.mjs";

// Fake values only; nothing here connects anywhere.
const pooled = "postgres://u:pooled-pass@pooled.example/db";
const direct = "postgres://u:direct-pass@direct.example/db";

describe("decideMigration", () => {
  it("REQ-5: a production deploy migrates when DATABASE_URL is set", () => {
    expect(decideMigration({ VERCEL_ENV: "production", DATABASE_URL: pooled })).toEqual({
      action: "migrate",
    });
  });

  it("REQ-5: a production deploy migrates when only DATABASE_URL_UNPOOLED is set", () => {
    expect(decideMigration({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: direct })).toEqual({
      action: "migrate",
    });
  });

  it("REQ-6: a production deploy with no database URL fails, naming the variables only", () => {
    const decision = decideMigration({ VERCEL_ENV: "production" });
    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") return;
    expect(decision.message).toContain("DATABASE_URL_UNPOOLED");
    expect(decision.message).toContain("DATABASE_URL");
  });

  it("REQ-6: empty or blank URL values count as unset in production", () => {
    expect(
      decideMigration({ VERCEL_ENV: "production", DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" })
        .action,
    ).toBe("fail");
    expect(
      decideMigration({ VERCEL_ENV: "production", DATABASE_URL: "  ", DATABASE_URL_UNPOOLED: " " })
        .action,
    ).toBe("fail");
  });

  it("REQ-5: a preview deploy migrates when a database URL is set", () => {
    expect(decideMigration({ VERCEL_ENV: "preview", DATABASE_URL: pooled }).action).toBe("migrate");
    expect(decideMigration({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: direct }).action).toBe(
      "migrate",
    );
  });

  it("REQ-6: a preview deploy with no database URL skips without failing", () => {
    const decision = decideMigration({ VERCEL_ENV: "preview", DATABASE_URL: "" });
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.message).toContain("preview");
  });

  it("REQ-6: a development build migrates with a URL and skips without one", () => {
    expect(decideMigration({ VERCEL_ENV: "development", DATABASE_URL: pooled }).action).toBe(
      "migrate",
    );
    expect(decideMigration({ VERCEL_ENV: "development" }).action).toBe("skip");
  });

  it("REQ-7: outside a Vercel build (VERCEL_ENV unset) the script fails and points to db:migrate", () => {
    const decision = decideMigration({ DATABASE_URL: pooled });
    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") return;
    expect(decision.message).toContain("pnpm run db:migrate");
  });

  it("REQ-7: an empty or unknown VERCEL_ENV fails even with a URL set", () => {
    for (const VERCEL_ENV of ["", " ", "Production", "staging", "prod"]) {
      expect(decideMigration({ VERCEL_ENV, DATABASE_URL: pooled }).action).toBe("fail");
    }
  });

  it("REQ-6: messages never contain a URL value", () => {
    const envs = [
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "staging", DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct },
    ];
    for (const env of envs) {
      const decision = decideMigration(env);
      if (decision.action === "migrate") continue;
      expect(decision.message).not.toContain("postgres://");
      expect(decision.message).not.toContain("pass");
    }
  });
});

describe("migrationUrl", () => {
  it("REQ-5: DATABASE_URL_UNPOOLED is preferred over DATABASE_URL", () => {
    expect(migrationUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct })).toBe(direct);
    expect(migrationUrl({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: "" })).toBe(pooled);
  });

  it("REQ-5: agrees with migrationDatabaseUrl, which drizzle.config.ts uses", () => {
    const values = [undefined, "", "   ", pooled, ` ${direct} `];
    for (const DATABASE_URL of values) {
      for (const DATABASE_URL_UNPOOLED of values) {
        const env = { DATABASE_URL, DATABASE_URL_UNPOOLED };
        expect(migrationUrl(env)).toBe(migrationDatabaseUrl(env));
      }
    }
  });
});

describe("childEnv", () => {
  it("REQ-6: drops TEST_DATABASE_URL and keeps both URL variables present", () => {
    const env = childEnv({
      PATH: "/bin",
      VERCEL_ENV: "production",
      DATABASE_URL: pooled,
      TEST_DATABASE_URL: "postgres://t:t@localhost/dot_test",
    });
    expect(env).not.toHaveProperty("TEST_DATABASE_URL");
    expect(env.DATABASE_URL).toBe(pooled);
    // Present but empty, so the .env drizzle-kit loads can't fill it in.
    expect(env).toHaveProperty("DATABASE_URL_UNPOOLED", "");
    expect(env.PATH).toBe("/bin");
  });

  it("REQ-6: drops every DOTENV_* variable, so dotenv can't be told to override or load another file", () => {
    const env = childEnv({
      PATH: "/bin",
      DATABASE_URL: pooled,
      DOTENV_CONFIG_OVERRIDE: "true",
      DOTENV_CONFIG_PATH: "/tmp/other.env",
      DOTENV_CONFIG_ENCODING: "latin1",
      DOTENV_CONFIG_DEBUG: "true",
      DOTENV_CONFIG_DOTENV_KEY: "fake-key",
      DOTENV_KEY: "fake-key",
      dotenv_config_override: "false",
    });
    expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith("DOTENV_"))).toEqual([]);
    expect(env.PATH).toBe("/bin");
    expect(env.DATABASE_URL).toBe(pooled);
  });

  it("REQ-6: drops other-case copies of the URL and test variables (Windows names ignore case)", () => {
    const env = childEnv({
      DATABASE_URL: pooled,
      database_url_unpooled: direct,
      test_database_url: "postgres://t:t@localhost/dot_test",
    });
    expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
    expect(env.DATABASE_URL_UNPOOLED).toBe("");
  });
});

describe("redact", () => {
  it("REQ-6: hides postgres URLs with credentials", () => {
    const out = redact(`connecting to ${direct} and postgresql://a:b@h:5432/x?sslmode=require.`);
    expect(out).not.toContain("direct-pass");
    expect(out).not.toContain("a:b@");
    expect(out).not.toContain("sslmode");
    expect(out).toBe("connecting to postgres://[redacted] and postgres://[redacted]");
  });

  it("REQ-6: hides the user and password in other URLs", () => {
    expect(redact("see https://user:hunter2@example.com/path")).toBe(
      "see https://[redacted]@example.com/path",
    );
  });

  it("REQ-6: hides password=… and password: … forms", () => {
    expect(redact("host=h password=hunter2 user=u")).toBe("host=h password=[redacted] user=u");
    expect(redact("PGPASSWORD=hunter2")).toBe("PGPASSWORD=[redacted]");
    expect(redact(`{ password: 'hunter2', user: "u" }`)).toBe(
      `{ password: [redacted], user: "u" }`,
    );
    expect(redact(`{"password":"hunter 2","host":"h"}`)).toBe(`{"password":[redacted],"host":"h"}`);
    expect(redact("pwd = hunter2;")).toBe("pwd = [redacted];");
  });

  it("REQ-6: hides the exact URL and password values it is given", () => {
    const env = { DATABASE_URL_UNPOOLED: "postgres://u:p%40ss-word@h/db" };
    const secrets = secretsFrom(env);
    const out = redact("failed for p@ss-word and p%40ss-word", secrets);
    expect(out).toBe("failed for [redacted] and [redacted]");
  });

  it("REQ-6: hides the host and user of a Neon-shaped URL, alone or in pg error lines", () => {
    // Fake values in Neon's format; nothing here exists.
    const neonPooled =
      "postgresql://neondb_owner:npg_Ab12Cd34@ep-cool-name-a1b2c3-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    const neonDirect =
      "postgresql://neondb_owner:npg_Ab12Cd34@ep-cool-name-a1b2c3.us-east-1.aws.neon.tech/neondb?sslmode=require";
    const secrets = secretsFrom({ DATABASE_URL: neonPooled, DATABASE_URL_UNPOOLED: neonDirect });
    const text = [
      `connecting to ${neonDirect}`,
      "Error: getaddrinfo ENOTFOUND ep-cool-name-a1b2c3.us-east-1.aws.neon.tech",
      "Error: getaddrinfo ENOTFOUND ep-cool-name-a1b2c3-pooler.us-east-1.aws.neon.tech",
      'error: password authentication failed for user "neondb_owner"',
      "npg_Ab12Cd34",
    ].join("\n");
    const out = redact(text, secrets);
    for (const leaked of ["neon.tech", "ep-cool-name", "neondb_owner", "npg_Ab12Cd34", "sslmode"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toBe(
      [
        "connecting to [redacted]",
        "Error: getaddrinfo ENOTFOUND [redacted]",
        "Error: getaddrinfo ENOTFOUND [redacted]",
        'error: password authentication failed for user "[redacted]"',
        "[redacted]",
      ].join("\n"),
    );
  });

  it("REQ-6: hides the URL's host and user, longest first, skipping parts under 4 characters", () => {
    const secrets = secretsFrom({
      DATABASE_URL: "postgres://app_user:pw@db.internal.example:5432/x",
    });
    expect(secrets).toContain("app_user");
    expect(secrets).toContain("db.internal.example");
    expect(secrets).not.toContain("pw");
    const lengths = secrets.map((secret) => secret.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it("REQ-6: leaves text with no secrets unchanged", () => {
    const text =
      '[✓] migrations applied successfully!\npassword authentication failed for user "u"\n' +
      "See https://orm.drizzle.team/docs/migrations";
    expect(redact(text)).toBe(text);
    expect(redact(text, secretsFrom({}))).toBe(text);
  });
});
