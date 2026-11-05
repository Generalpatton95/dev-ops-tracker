// T-9/T-10: ids that arrive from the client (in input or a cookie) are checked before any query.
// One that isn't a UUID can't name a row, so callers answer it like an unknown one, without a
// query (Postgres would reject it as a uuid).

/** Inputs take any string up to this length; longer is refused as bad input. */
export const MAX_ID_LENGTH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
