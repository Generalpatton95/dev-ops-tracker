import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roleEnum } from "../src/server/db/schema";
import { migrationUrl } from "./migrate-on-deploy-lib.mjs";
import {
  MARKER_QUERY,
  PREVIEW_BASE_MARKER,
  errorLabel,
  isPreviewBase,
  notPreviewBaseMessage,
} from "./preview-base-lib.mjs";
import { SEED, SEED_LOCK_KEY, decideSeed, seedDatabase, shouldSeed } from "./seed-preview-lib.mjs";

// Fake values only; nothing here connects anywhere.
const pooled = "postgres://u:pooled-pass@pooled.example/db";
const direct = "postgres://u:direct-pass@direct.example/db";

describe("decideSeed", () => {
  it("REQ-6: a preview build with a database URL seeds", () => {
    expect(decideSeed({ VERCEL_ENV: "preview", DATABASE_URL: pooled })).toEqual({
      action: "seed",
      url: pooled,
    });
    expect(decideSeed({ VERCEL_ENV: " preview\n", DATABASE_URL_UNPOOLED: direct })).toEqual({
      action: "seed",
      url: direct,
    });
  });

  it("REQ-6: the seed uses the migrate step's URL rule (DATABASE_URL_UNPOOLED first)", () => {
    const values = [undefined, "", "   ", pooled, ` ${direct} `];
    for (const DATABASE_URL of values) {
      for (const DATABASE_URL_UNPOOLED of values) {
        const env = { VERCEL_ENV: "preview", DATABASE_URL, DATABASE_URL_UNPOOLED };
        const decision = decideSeed(env);
        const url = migrationUrl(env);
        if (url) expect(decision).toEqual({ action: "seed", url });
        else expect(decision.action).toBe("skip");
      }
    }
  });

  it("REQ-6: a preview build with no database URL skips", () => {
    for (const env of [
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "preview", DATABASE_URL: "", DATABASE_URL_UNPOOLED: " " },
    ]) {
      const decision = decideSeed(env);
      expect(decision.action).toBe("skip");
      if (decision.action !== "skip") return;
      expect(decision.message).toContain("no database URL");
    }
  });

  it("REQ-6: production never seeds, even with database URLs set", () => {
    const decision = decideSeed({
      VERCEL_ENV: "production",
      DATABASE_URL: pooled,
      DATABASE_URL_UNPOOLED: direct,
    });
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.message).toBe(
      "seed-preview: this is a production build; only preview builds are seeded. Skipping.",
    );
  });

  it("REQ-6: development, unset, empty or unknown VERCEL_ENV values skip", () => {
    for (const VERCEL_ENV of [undefined, "", " ", "development", "Preview", "PREVIEW", "staging"]) {
      expect(decideSeed({ VERCEL_ENV, DATABASE_URL: pooled }).action, VERCEL_ENV).toBe("skip");
    }
  });

  it("REQ-6: skip messages are one line and never contain a URL or password", () => {
    const envs = [
      { VERCEL_ENV: "production", DATABASE_URL: pooled },
      { VERCEL_ENV: "development", DATABASE_URL_UNPOOLED: direct },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "staging", DATABASE_URL: pooled },
      { VERCEL_ENV: pooled, DATABASE_URL: pooled },
    ];
    for (const env of envs) {
      const decision = decideSeed(env);
      expect(decision.action).toBe("skip");
      if (decision.action !== "skip") continue;
      expect(decision.message).not.toContain("\n");
      expect(decision.message).not.toContain("://");
      expect(decision.message).not.toContain("pass");
      expect(decision.message).not.toContain(".example");
    }
  });
});

describe("shouldSeed", () => {
  it("REQ-6: seeds only when the user and workspace tables are both empty", () => {
    expect(shouldSeed({ hasUsers: false, hasWorkspaces: false })).toBe(true);
    expect(shouldSeed({ hasUsers: true, hasWorkspaces: false })).toBe(false);
    expect(shouldSeed({ hasUsers: false, hasWorkspaces: true })).toBe(false);
    expect(shouldSeed({ hasUsers: true, hasWorkspaces: true })).toBe(false);
  });
});

describe("SEED", () => {
  it("REQ-6: the demo data is fake: negative GitHub id, valid role and project key", () => {
    expect(SEED.user.githubId).toBeLessThan(0);
    expect(SEED.user.name).toBe("Demo owner");
    expect(SEED.workspace.name).toBe("Demo workspace");
    expect(roleEnum.enumValues).toContain(SEED.role);
    expect(SEED.role).toBe("owner");
    expect(SEED.project).toEqual({ key: "DEMO", name: "Demo project" });
    expect(SEED.project.key).toMatch(/^[A-Z]{2,5}$/);
  });
});

describe("preview-base marker", () => {
  it("REQ-6: only the exact marker counts as a copy of preview-base", () => {
    expect(PREVIEW_BASE_MARKER).toBe("dot-preview-base");
    expect(isPreviewBase("dot-preview-base")).toBe(true);
    for (const value of [
      null,
      undefined,
      "",
      " dot-preview-base",
      "DOT-PREVIEW-BASE",
      "standard public schema",
    ]) {
      expect(isPreviewBase(value), String(value)).toBe(false);
    }
  });

  it("REQ-6: the refusal is one line, names the marker and points at the database variables", () => {
    const message = notPreviewBaseMessage("migrate-on-deploy", "migrations were refused");
    expect(message).not.toContain("\n");
    expect(message).toContain("not a copy of preview-base");
    expect(message).toContain('"dot-preview-base"');
    expect(message).toContain("migrations were refused");
    expect(message).toContain("Preview and Development database variables");
    expect(message).not.toContain("://");
  });
});

describe("errorLabel", () => {
  it("REQ-6: gives a code or class name, never the message", () => {
    const pgError = Object.assign(new Error('relation "user" does not exist at db.example'), {
      code: "42P01",
    });
    expect(errorLabel(pgError)).toBe("42P01");
    const netError = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), {
      code: "ECONNREFUSED",
    });
    expect(errorLabel(netError)).toBe("ECONNREFUSED");
    expect(errorLabel(new TypeError("Invalid URL postgres://u:secret@h/db"))).toBe("TypeError");
    // A code that isn't a plain token falls back to the class name.
    const odd = Object.assign(new RangeError("x"), { code: "password=hunter2 host" });
    expect(errorLabel(odd)).toBe("RangeError");
    expect(errorLabel("a string with postgres://u:p@h/db")).toBe("error");
    expect(errorLabel(undefined)).toBe("error");
  });
});

type Call = { text: string; values?: unknown[] };

// A stand-in for pg's Client that records every query and answers the marker and emptiness
// checks.
function fakeClient(
  state: { hasUsers: boolean; hasWorkspaces: boolean; marker?: string | null },
  failOn?: string,
) {
  const calls: Call[] = [];
  let nextId = 1;
  const client = {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (failOn && text.includes(failOn)) {
        throw Object.assign(new Error("boom"), { code: "23505" });
      }
      if (text === MARKER_QUERY) {
        return { rows: [{ marker: "marker" in state ? state.marker : PREVIEW_BASE_MARKER }] };
      }
      if (text.startsWith("select exists")) {
        return { rows: [{ has_users: state.hasUsers, has_workspaces: state.hasWorkspaces }] };
      }
      if (text.includes("returning id")) return { rows: [{ id: `id-${nextId++}` }] };
      return { rows: [] };
    },
  };
  return client;
}

const inserts = (calls: Call[]) => calls.filter((call) => call.text.startsWith("insert"));

describe("seedDatabase", () => {
  it("REQ-6: on empty tables, inserts the user, workspace, owner membership and project in one transaction", async () => {
    const client = fakeClient({ hasUsers: false, hasWorkspaces: false });
    await expect(seedDatabase(client)).resolves.toEqual({ outcome: "seeded" });

    const texts = client.calls.map((call) => call.text);
    expect(texts[0]).toBe("begin");
    expect(texts.at(-1)).toBe("commit");
    expect(texts.filter((text) => text === "begin")).toHaveLength(1);
    expect(texts).not.toContain("rollback");

    // The timeouts are set and the lock taken, then the marker is checked, then the tables.
    const lock = texts.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    const marker = texts.indexOf(MARKER_QUERY);
    const check = texts.findIndex((text) => text.startsWith("select exists"));
    expect(lock).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(marker);
    expect(client.calls[lock].values).toEqual([SEED_LOCK_KEY]);
    expect(texts.slice(0, lock).join("\n")).toContain("set local statement_timeout");

    const rows = inserts(client.calls);
    expect(rows.map((call) => call.text.split(" ")[2])).toEqual([
      '"user"',
      "workspace",
      "membership",
      "project",
    ]);
    expect(rows[0].values).toEqual(["Demo owner", -1]);
    expect(rows[1].values).toEqual(["Demo workspace"]);
    expect(rows[2].values).toEqual(["id-1", "id-2", "owner"]);
    expect(rows[3].values).toEqual(["id-2", "DEMO", "Demo project"]);
  });

  it("REQ-6: every value goes in as a parameter, never in the SQL text", async () => {
    const client = fakeClient({ hasUsers: false, hasWorkspaces: false });
    await seedDatabase(client);
    const sqlText = client.calls.map((call) => call.text).join("\n");
    for (const value of ["Demo", "DEMO", "owner", "-1"]) {
      expect(sqlText).not.toContain(value);
    }
  });

  it("REQ-6: changes nothing when the user or workspace table has rows", async () => {
    for (const state of [
      { hasUsers: true, hasWorkspaces: false },
      { hasUsers: false, hasWorkspaces: true },
      { hasUsers: true, hasWorkspaces: true },
    ]) {
      const client = fakeClient(state);
      await expect(seedDatabase(client)).resolves.toEqual({ outcome: "has-rows" });
      expect(inserts(client.calls)).toEqual([]);
      expect(client.calls.at(-1)?.text).toBe("rollback");
      expect(client.calls.map((call) => call.text)).not.toContain("commit");
    }
  });

  it("REQ-6: changes nothing on a database without the preview-base marker, even with empty tables", async () => {
    for (const marker of [null, "standard public schema"]) {
      const client = fakeClient({ hasUsers: false, hasWorkspaces: false, marker });
      await expect(seedDatabase(client)).resolves.toEqual({ outcome: "not-preview-base" });
      const texts = client.calls.map((call) => call.text);
      expect(inserts(client.calls)).toEqual([]);
      expect(texts.some((text) => text.startsWith("select exists"))).toBe(false);
      expect(texts.at(-1)).toBe("rollback");
      expect(texts).not.toContain("commit");
    }
  });

  it("REQ-6: rolls back and rethrows when an insert fails", async () => {
    const client = fakeClient({ hasUsers: false, hasWorkspaces: false }, "insert into project");
    await expect(seedDatabase(client)).rejects.toMatchObject({ code: "23505" });
    const texts = client.calls.map((call) => call.text);
    expect(texts.at(-1)).toBe("rollback");
    expect(texts).not.toContain("commit");
  });
});

describe("empty-preview-base.sql", () => {
  const text = readFileSync(new URL("./empty-preview-base.sql", import.meta.url), "utf8");
  // Drop the comment lines at the top and anywhere else, so only SQL is left.
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();

  it("REQ-6: is a single DO block, so any error aborts all of it", () => {
    expect(body.startsWith("DO $$")).toBe(true);
    expect(body.endsWith("$$;")).toBe(true);
    // Exactly one dollar-quoted body: an opening and a closing $$.
    expect(body.match(/\$\$/g)).toHaveLength(2);
  });

  it("REQ-6: checks for migration history and rows before it drops anything", () => {
    const firstDrop = body.indexOf("DROP ");
    expect(firstDrop).toBeGreaterThan(0);
    const guard = body.slice(0, firstDrop);
    expect(guard).toContain("drizzle.__drizzle_migrations");
    expect(guard).toContain('public."user"');
    expect(guard).toContain("public.workspace");
    expect(guard).toContain(
      "migration history found: this is not the schema-only preview-base branch; nothing was changed",
    );
    expect(body.indexOf("RAISE EXCEPTION")).toBeLessThan(firstDrop);
  });

  it("REQ-6: keeps the public schema and its grants, and ends by setting the marker", () => {
    expect(body).not.toMatch(/DROP SCHEMA (IF EXISTS )?public/i);
    expect(body).not.toMatch(/CREATE SCHEMA/i);
    expect(body).not.toMatch(/(GRANT|REVOKE)/i);
    expect(body).not.toMatch(/DROP EXTENSION/i);
    const marker = `COMMENT ON SCHEMA public IS '${PREVIEW_BASE_MARKER}';`;
    expect(body).toContain(marker);
    expect(body.lastIndexOf("DROP ")).toBeLessThan(body.indexOf(marker));
  });

  it("REQ-6: says in its header where to run it and that it must fail on main", () => {
    const header = text.slice(0, text.indexOf("DO $$"));
    expect(header).toContain("preview-base");
    expect(header).toContain("SQL Editor");
    expect(header).toContain("dev_ops_tracker_owner");
    expect(header).toContain(PREVIEW_BASE_MARKER);
    expect(header).toMatch(/on `main`[^]*MUST fail/);
  });
});
