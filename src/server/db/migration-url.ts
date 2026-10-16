// Migrations need a direct connection: Neon's pooled DATABASE_URL can break the session-level
// work a migration does, so DATABASE_URL_UNPOOLED wins when it's set. Any other Postgres
// only needs DATABASE_URL (REQ-7). An empty value counts as unset, so a blank line copied
// from .env.example can't override a real URL.
// Used by drizzle.config.ts, so it must not import "server-only".
export function migrationDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();
  if (unpooled) return unpooled;
  const pooled = env.DATABASE_URL?.trim();
  return pooled || undefined;
}
