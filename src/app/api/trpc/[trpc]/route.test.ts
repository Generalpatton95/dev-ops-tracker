import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/trpc/[trpc]/route";
import { MAX_BATCH_SIZE, MAX_BODY_BYTES } from "@/trpc/limits";

const base = "http://localhost/api/trpc";

function post(headers: Record<string, string>) {
  return POST(new Request(`${base}/health.ping`, { method: "POST", headers, body: "{}" }));
}

function batch(size: number) {
  const paths = Array(size).fill("health.ping").join(",");
  const input = encodeURIComponent(
    JSON.stringify(Object.fromEntries(paths.split(",").map((_, i) => [i, {}]))),
  );
  return GET(new Request(`${base}/${paths}?batch=1&input=${input}`));
}

afterEach(() => vi.restoreAllMocks());

describe("/api/trpc limits", () => {
  it("answers a ping", async () => {
    const res = await GET(new Request(`${base}/health.ping`));
    expect(res.status).toBe(200);
  });

  it("refuses a POST with no content-length", async () => {
    expect((await post({})).status).toBe(411);
  });

  it("refuses a malformed content-length", async () => {
    expect((await post({ "content-length": "abc" })).status).toBe(400);
  });

  it("refuses a body over the limit", async () => {
    expect((await post({ "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
  });

  it("allows a full batch and refuses a bigger one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await batch(MAX_BATCH_SIZE)).status).toBe(200);
    expect((await batch(MAX_BATCH_SIZE + 1)).status).toBe(400);
  });

  it("logs a cleaned, capped path for unknown procedures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(new Request(`${base}/x%0Afake-line${"a".repeat(500)}`));
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(120);
  });
});
