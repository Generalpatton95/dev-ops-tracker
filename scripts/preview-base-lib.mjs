// T-7 (REQ-6): what the deploy scripts share about preview databases. Deploy config, not app
// code (REQ-7).
// Every preview (and Vercel development) database is a Neon branch of `preview-base`, which
// scripts/empty-preview-base.sql marks with a comment on its public schema. Production's `main`
// never has the marker, so a preview build pointed at production by mistake stops before it
// migrates or seeds anything.
import pg from "pg";

/** The comment empty-preview-base.sql puts on `preview-base`'s public schema. */
export const PREVIEW_BASE_MARKER = "dot-preview-base";

/** Reads the public schema's comment; null when there is none. */
export const MARKER_QUERY =
  "select obj_description('public'::regnamespace, 'pg_namespace') as marker";

// A hung database must not hold the build open.
export const CONNECT_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 30_000;

/**
 * True only for the exact marker; anything else (no comment, another comment) is not a copy of
 * preview-base.
 * @param {unknown} marker
 * @returns {boolean}
 */
export function isPreviewBase(marker) {
  return marker === PREVIEW_BASE_MARKER;
}

/**
 * @param {{ query: (text: string) => Promise<{ rows: any[] }> }} client a connected pg Client
 * @returns {Promise<boolean>} whether the database is marked as a copy of preview-base
 */
export async function hasPreviewBaseMarker(client) {
  const { rows } = await client.query(MARKER_QUERY);
  return isPreviewBase(rows[0]?.marker);
}

/**
 * The one-line failure when the marker is missing. Names variables, never their values.
 * @param {string} step the script's name, e.g. "migrate-on-deploy"
 * @param {string} refused what was not done, e.g. "migrations were refused"
 * @returns {string}
 */
export function notPreviewBaseMessage(step, refused) {
  return (
    `${step}: this database is not a copy of preview-base (its public schema has no ` +
    `"${PREVIEW_BASE_MARKER}" marker), so ${refused}. Check that the Preview and Development ` +
    "database variables don't point at production."
  );
}

/**
 * A short, safe label for an error: its code (a SQLSTATE like 42P01, or ECONNREFUSED) or else
 * its class name. Never the message, which can carry a host, user or query values.
 * @param {unknown} error
 * @returns {string}
 */
export function errorLabel(error) {
  if (error && typeof error === "object") {
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
    const name = error.constructor?.name;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(name)) return name;
  }
  return "error";
}

/**
 * Connects a pg Client with the timeouts above. Only client-side settings are used: Neon's
 * pooler rejects startup options such as statement_timeout.
 * @param {string} url
 * @returns {Promise<pg.Client>}
 */
export async function connect(url) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  // A dropped connection is emitted as an event; without a listener Node would crash and print
  // the error's message. The pending query rejects as well, and that is what gets reported.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}
