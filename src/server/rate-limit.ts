// T-8 (REQ-1): rate limits for public endpoints, stored in Postgres so every server instance
// shares them (no hosted key-value store, REQ-7). Fixed one-minute windows, one upsert per
// request. The row key is an HMAC of the bucket and the caller's IP, never the IP itself.
// Fails closed: if the count can't be read (database error, or no answer within 2 seconds),
// the caller gets a 503, never a free pass. Windows follow the database's clock, so an app
// server whose clock runs ahead or behind can't lock callers out or reset their counts.
import "server-only";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { isIP } from "node:net";
import { sql, type SQL } from "drizzle-orm";
import { after } from "next/server";
import { getDb, type Database } from "@/server/db";
import { rateLimits, sessions } from "@/server/db/schema";
import { errorLabel } from "@/server/log-label";

/** Requests allowed per caller per one-minute window. */
export const RATE_LIMITS = {
  // Auth.js sign-in and OAuth callback routes.
  auth: 10,
  // tRPC calls made while signed out.
  "trpc-public": 60,
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export const TIMEOUT_MS = 2_000;
// After a limited request (at most once every CLEANUP_INTERVAL_MS per server instance, and after
// the response is sent), rate-limit rows whose window started more than a day ago are deleted,
// and so are expired Auth.js sessions (Auth.js deletes one only when its cookie comes back).
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// Fixed label for deriving the HMAC key from AUTH_SECRET, so the key is used for nothing else.
const HKDF_INFO = "dev-ops-tracker rate-limit key v1";

type Env = Readonly<Record<string, string | undefined>>;

export type RateLimitResult =
  { ok: true; count: number; limit: number } | { ok: false; status: 429 | 503 };

/**
 * The caller's IP, read only from the header named in TRUSTED_IP_HEADER (on Vercel `x-real-ip`,
 * which Vercel sets itself). With no such header configured, or a value that isn't one plain IP,
 * this returns null and the caller shares one bucket with everyone else: stricter, never looser.
 * IPv6 addresses are grouped by their /64, since one subscriber usually holds a whole /64.
 */
export function clientIp(headers: Headers, env: Env): string | null {
  const name = env.TRUSTED_IP_HEADER?.trim();
  if (!name) return null;
  let raw: string | null;
  try {
    raw = headers.get(name);
  } catch {
    return null; // not a valid header name
  }
  const value = raw?.trim() ?? "";
  if (value.length === 0 || value.length > 64) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return ipv6Prefix(value);
  return null;
}

// "2001:db8:1:2:3:4:5:6" -> "2001:db8:1:2::/64"; an IPv4-mapped address becomes its IPv4.
function ipv6Prefix(value: string): string | null {
  let host: string;
  try {
    // The URL parser validates and canonicalises IPv6 (lower case, dotted tails as hex).
    host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const halves = host.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const words = groups.map((group) => parseInt(group, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * The key for one caller in one bucket. With AUTH_SECRET set, an HMAC-SHA256 whose key is derived
 * from it (HKDF, fixed label), so the stored value can't be turned back into an IP by trying
 * every address. Without AUTH_SECRET (previews, local without sign-in) there is no secret to key
 * the hash with, so the IP is left out entirely and everyone shares the bucket.
 */
export function rateLimitKey(bucket: RateLimitBucket, ip: string | null, env: Env): string {
  const secret = env.AUTH_SECRET;
  if (!secret || ip === null) {
    return createHash("sha256").update(`${bucket}\nshared`).digest("hex");
  }
  const hmacKey = Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, 32));
  return createHmac("sha256", hmacKey).update(`${bucket}\nip:${ip}`).digest("hex");
}

/** The database's clock, or (tests only) a fixed time standing in for it. */
function clockSql(clock: Date | undefined): SQL {
  return clock ? sql`${clock.toISOString()}::timestamptz` : sql`now()`;
}

/**
 * Adds `cost` to the key's count for the current one-minute window in one statement and returns
 * the new count. The window is computed by the database (`date_bin` on its own clock). A newer
 * window starts the count again; an older one never resets it.
 */
export async function consume(
  db: Database,
  key: string,
  cost: number,
  clock?: Date,
): Promise<number> {
  const window = sql`date_bin('1 minute', ${clockSql(clock)}, timestamptz 'epoch')`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: window, count: cost })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when excluded.window_start > ${rateLimits.windowStart} then excluded.count else ${rateLimits.count} + excluded.count end`,
        windowStart: sql`greatest(${rateLimits.windowStart}, excluded.window_start)`,
      },
    })
    .returning({ count: rateLimits.count });
  if (!row) throw new Error("rate limit upsert returned no row");
  return row.count;
}

/** Deletes rate-limit rows whose window started over a day ago, and expired sessions. */
export async function deleteExpiredRows(db: Database, clock?: Date): Promise<void> {
  const at = clockSql(clock);
  await db.delete(rateLimits).where(sql`${rateLimits.windowStart} < ${at} - interval '1 day'`);
  await db.delete(sessions).where(sql`${sessions.expires} < ${at}`);
}

class LimiterTimeout extends Error {
  override name = "LimiterTimeout";
}

function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LimiterTimeout()), ms);
  });
  // `work` runs inside the promise chain, so a synchronous throw (no DATABASE_URL) is caught too.
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

export type RateLimitOptions = {
  bucket: RateLimitBucket;
  headers: Headers;
  /** How many calls this request counts as (a tRPC batch counts each call). Default 1. */
  cost?: number;
  env?: Env;
  db?: () => Database;
  /** Tests only: a fixed time standing in for the database's clock. */
  clock?: Date;
  /** This instance's clock, used only to space out clean-ups. */
  now?: () => number;
  timeoutMs?: number;
  /** When this instance last cleaned up; shared by default, separate in tests. */
  cleanup?: { lastRunMs: number };
  /** Runs the clean-up after the response; Next's `after()` by default. */
  schedule?: (task: () => Promise<void>) => void;
  /** Whether the missing-header warning was logged; shared by default, separate in tests. */
  warnings?: { missingIpHeader: boolean };
};

const instanceCleanup = { lastRunMs: 0 };
const instanceWarnings = { missingIpHeader: false };

// With a secret but no trusted IP header, every caller shares one bucket: safe, but one busy
// caller can lock everyone out of signing in. Said once per instance, naming no values.
function warnIfNoIpHeader(env: Env, warnings: { missingIpHeader: boolean }) {
  if (warnings.missingIpHeader || !env.AUTH_SECRET || env.TRUSTED_IP_HEADER?.trim()) return;
  warnings.missingIpHeader = true;
  console.warn(
    "rate-limit: AUTH_SECRET is set but TRUSTED_IP_HEADER isn't, so all callers share one " +
      "rate-limit bucket per limit.",
  );
}

export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const env = options.env ?? process.env;
  const getDatabase = options.db ?? getDb;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const limit = RATE_LIMITS[options.bucket];
  const cost = Math.max(1, Math.min(Math.floor(options.cost ?? 1), limit + 1));
  warnIfNoIpHeader(env, options.warnings ?? instanceWarnings);
  const key = rateLimitKey(options.bucket, clientIp(options.headers, env), env);

  let count: number;
  try {
    count = await withTimeout(() => consume(getDatabase(), key, cost, options.clock), timeoutMs);
  } catch (error) {
    console.error(`rate-limit ${options.bucket}: failed closed, ${errorLabel(error)}`);
    return { ok: false, status: 503 };
  }

  const nowMs = (options.now ?? Date.now)();
  const cleanup = options.cleanup ?? instanceCleanup;
  if (nowMs - cleanup.lastRunMs >= CLEANUP_INTERVAL_MS) {
    cleanup.lastRunMs = nowMs;
    // Housekeeping only, after the response is sent: a failure here never touches the request.
    const task = async () => {
      try {
        await withTimeout(() => deleteExpiredRows(getDatabase(), options.clock), timeoutMs);
      } catch (error) {
        console.error(`rate-limit cleanup: ${errorLabel(error)}`);
      }
    };
    try {
      (options.schedule ?? after)(task);
    } catch (error) {
      // e.g. called outside a request. Not marked as done, so a later request tries again.
      cleanup.lastRunMs = 0;
      console.error(`rate-limit cleanup not scheduled: ${errorLabel(error)}`);
    }
  }

  if (count > limit) return { ok: false, status: 429 };
  return { ok: true, count, limit };
}

/** The response for a refused request. No body detail beyond what the status already says. */
export function rateLimitResponse(status: 429 | 503): Response {
  const text =
    status === 429
      ? "Too many requests. Wait a minute and try again."
      : "This service is busy. Try again shortly.";
  return new Response(text, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": status === 429 ? "60" : "5",
    },
  });
}
