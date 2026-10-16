// T-5 (REQ-5): which database the database tests may use. Test-only; the app never imports it.
// The tests wipe the schema they run in, so they only ever use TEST_DATABASE_URL, and only
// when its database name ends in `_test`. Error messages never include the URL itself.
// node-postgres lets query parameters (and the socket: scheme) override the host, port and
// database in the path, so those are refused: the name checked here is the one used.

export type TestDatabase = { run: true; url: string } | { run: false; reason: string };

export const TEST_DATABASE_SUFFIX = "_test";

const ALLOWED_SCHEMES = new Set(["postgres:", "postgresql:"]);
// Query keys node-postgres (or libpq) would use to point the connection somewhere else.
const FORBIDDEN_QUERY_KEYS = new Set(["host", "hostaddr", "port", "db", "database", "dbname"]);

export function isTestDatabaseName(name: string): boolean {
  return name.length > TEST_DATABASE_SUFFIX.length && name.endsWith(TEST_DATABASE_SUFFIX);
}

export function resolveTestDatabase(
  env: Readonly<Record<string, string | undefined>>,
): TestDatabase {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env.CI) {
      // CI must never pass by silently skipping the database tests.
      throw new Error("TEST_DATABASE_URL is not set. CI runs the database tests, so this fails.");
    }
    return {
      run: false,
      reason: "TEST_DATABASE_URL is not set, so the database tests are skipped. CI runs them.",
    };
  }

  let parsed: URL;
  let name: string;
  try {
    parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid postgres:// URL.");
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      "Refusing to run: TEST_DATABASE_URL must start with postgres:// or postgresql://.",
    );
  }

  const overrides = [...new Set([...parsed.searchParams.keys()].map((key) => key.toLowerCase()))]
    .filter((key) => FORBIDDEN_QUERY_KEYS.has(key))
    .sort();
  if (overrides.length > 0) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL must not set ${overrides.join(", ")} in its query ` +
        "string. Put the host, port and database in the URL itself.",
    );
  }

  if (!isTestDatabaseName(name)) {
    throw new Error(
      `Refusing to run: the database name in TEST_DATABASE_URL must end in "${TEST_DATABASE_SUFFIX}", ` +
        "because the database tests wipe it.",
    );
  }
  return { run: true, url };
}
