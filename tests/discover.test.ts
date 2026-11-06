import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverGithub, type DiscoveryQuery } from "../src/index.js";
import type { FetchLike } from "../src/github/transport.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search-page.json", import.meta.url), "utf8"));

// A synthetic search item; `n` makes ids/numbers unique.
const item = (n: number) => ({ ...fixture.items[0], node_id: `I_${n}`, number: n });
const page = (items: unknown[], total = items.length) => ({ total_count: total, incomplete_results: false, items });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Fake fetch: replies in order, records requested URLs and auth headers. */
function fakeFetch(...replies: Reply[]) {
  const calls: { url: URL; auth: string | null }[] = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") });
    const r = replies[calls.length - 1] ?? replies[replies.length - 1]!;
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  };
  return { fn, calls };
}

const q: DiscoveryQuery = { text: "effect twice", limit: 10 };
const run = (f: ReturnType<typeof fakeFetch>, query: DiscoveryQuery = q, token: string | undefined = "test-token") =>
  discoverGithub(query, { token, fetch: f.fn });

describe("normalization", () => {
  it("maps issues and PRs to DiscoveryRef without body text", async () => {
    const f = fakeFetch({ body: fixture, headers: { "x-ratelimit-remaining": "28", "x-ratelimit-reset": "1800000000" } });
    const r = await run(f);
    expect(r).toMatchObject({ ok: true, totalMatches: 2, sourceIncomplete: false, rateLimit: { remaining: 28, resetAt: "2027-01-15T08:00:00.000Z" } });
    if (!r.ok) throw new Error();
    expect(r.refs).toEqual([
      {
        id: "I_kwDOAAAA1", source: "github", type: "issue", title: "Signals: effect runs twice on init",
        url: "https://github.com/angular/angular/issues/101", repo: "angular/angular", number: 101,
        createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-02T11:30:00Z",
        meta: { state: "open", commentCount: 7, labels: ["area: core", "bug"], score: 1 },
      },
      expect.objectContaining({ id: "PR_kwDOAAAA2", type: "pull_request", repo: "angular/angular", number: 202 }),
    ]);
    expect(JSON.stringify(r)).not.toContain("FULL BODY");
  });

  it("builds the query from text, repo and date range, and sends the token", async () => {
    const f = fakeFetch({ body: page([]) });
    await run(f, { text: "hydration", repo: "withastro/astro", createdBetween: { from: "2026-01-01" }, limit: 5 });
    expect(f.calls[0]!.url.searchParams.get("q")).toBe("hydration repo:withastro/astro created:2026-01-01..*");
    expect(f.calls[0]!.auth).toBe("Bearer test-token");
  });
});

describe("empty results", () => {
  it("is a successful empty result, not a failure", async () => {
    expect(await run(fakeFetch({ body: page([]) }))).toMatchObject({ ok: true, refs: [], totalMatches: 0 });
  });
});

describe("limits and pagination", () => {
  it("respects the limit and stops requesting once satisfied", async () => {
    const f = fakeFetch({ body: page([1, 2, 3, 4, 5].map(item), 50) });
    const r = await run(f, { text: "x", limit: 3 });
    expect(r.ok && r.refs.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url.searchParams.get("per_page")).toBe("3");
  });

  it("fetches further pages until the limit is met", async () => {
    const full = (start: number) => page(Array.from({ length: 100 }, (_, i) => item(start + i)), 500);
    const f = fakeFetch({ body: full(0) }, { body: full(100) }, { body: full(200) });
    const r = await run(f, { text: "x", limit: 250 });
    expect(r.ok && r.refs).toHaveLength(250);
    expect(f.calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("stops at a short page even if the limit is not met", async () => {
    const f = fakeFetch({ body: page([item(1), item(2)], 2) });
    const r = await run(f, { text: "x", limit: 100 });
    expect(r.ok && r.refs).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  });
});

describe("interrupted pagination", () => {
  const full = (start: number) => page(Array.from({ length: 100 }, (_, i) => item(start + i)), 500);
  const want = { text: "x", limit: 250 };

  for (const [name, second, kind] of [
    ["rate limit", { status: 429, headers: { "retry-after": "5" } }, "rate_limited"],
    ["5xx", { status: 502, body: {} }, "service"],
    ["network error", new TypeError("socket hang up"), "network"],
    ["malformed page", { body: { items: "nope" } }, "unexpected_response"],
  ] as const) {
    it(`${name} on page 2 fails explicitly and returns page 1 as partial`, async () => {
      const r = await run(fakeFetch({ body: full(0) }, second), want);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure.kind).toBe(kind);
      expect(r.partial).toHaveLength(100);
      expect(r.partial!.map((x) => x.number)).toEqual(Array.from({ length: 100 }, (_, i) => i));
      expect("refs" in r).toBe(false); // can't be mistaken for a complete result
    });
  }

  it("partial refs are de-duplicated across pages and never exceed the limit", async () => {
    const f = fakeFetch({ body: full(0) }, { body: full(50) }, { status: 503, body: {} });
    const r = await run(f, { text: "x", limit: 140 }); // page 2 overlaps 50 refs → 150 unique, capped by limit later
    expect(r.ok && r.refs).toHaveLength(140); // limit reached before the 503 is ever requested
    const r2 = await run(fakeFetch({ body: full(0) }, { body: full(50) }, { status: 503, body: {} }), { text: "x", limit: 200 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.partial).toHaveLength(150);
  });
});

describe("source-reported incompleteness", () => {
  it("surfaces GitHub's incomplete_results as sourceIncomplete on a complete retrieval", async () => {
    const r = await run(fakeFetch({ body: { ...page([item(1)]), incomplete_results: true } }));
    expect(r).toMatchObject({ ok: true, sourceIncomplete: true });
  });
});

describe("de-duplication", () => {
  it("drops refs repeated within or across pages and keeps paging to fill the limit", async () => {
    const p1 = page([item(1), item(2), item(2)], 10); // per_page=3 → full page with an in-page duplicate
    const p2 = page([item(2), item(3), item(4)], 10); // overlaps previous page
    const f = fakeFetch({ body: p1 }, { body: p2 });
    const r = await run(f, { text: "x", limit: 3 });
    expect(r.ok && r.refs.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(2);
  });
});

describe("failures", () => {
  it("auth: missing token fails before any request", async () => {
    const f = fakeFetch({ body: page([]) });
    const saved = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      expect(await discoverGithub(q, { fetch: f.fn })).toMatchObject({ ok: false, failure: { kind: "auth" } });
    } finally {
      if (saved !== undefined) process.env["GITHUB_TOKEN"] = saved;
    }
    expect(f.calls).toHaveLength(0);
  });

  it("auth: 401 bad credentials", async () => {
    const r = await run(fakeFetch({ status: 401, body: { message: "Bad credentials" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "auth" } });
  });

  it("rate limit: 403 with exhausted quota reports reset time", async () => {
    const r = await run(fakeFetch({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "rate_limited", resetAt: "2027-01-15T08:00:00.000Z" } });
  });

  it("rate limit: 429 / secondary limit with Retry-After", async () => {
    const r = await run(fakeFetch({ status: 429, body: {}, headers: { "retry-after": "60" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "rate_limited", retryAfterSeconds: 60 } });
  });

  it("a plain 403 (quota remaining) is auth, not rate limiting", async () => {
    const r = await run(fakeFetch({ status: 403, body: { message: "Resource not accessible" }, headers: { "x-ratelimit-remaining": "10" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "auth" } });
  });

  it("rate limit hit mid-pagination fails explicitly", async () => {
    const full = page(Array.from({ length: 100 }, (_, i) => item(i)), 500);
    const r = await run(fakeFetch({ body: full }, { status: 429, headers: { "retry-after": "5" } }), { text: "x", limit: 200 });
    expect(r).toMatchObject({ ok: false, failure: { kind: "rate_limited" } });
  });

  it("failure on the first page carries no partial refs", async () => {
    const r = await run(fakeFetch({ status: 503, body: {} }));
    expect(r).toEqual({ ok: false, failure: expect.objectContaining({ kind: "service" }) });
    expect("partial" in r).toBe(false);
  });

  it("invalid query: rejected locally without a request", async () => {
    for (const bad of [{ text: "  ", limit: 5 }, { text: "x", limit: 0 }, { text: "x", limit: 1001 }, { text: "x", repo: "not-a-repo", limit: 5 }, { text: "x", createdBetween: { from: "yesterday" }, limit: 5 }]) {
      const f = fakeFetch({ body: page([]) });
      expect(await run(f, bad)).toMatchObject({ ok: false, failure: { kind: "invalid_query" } });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("invalid query: 422 from the API", async () => {
    const r = await run(fakeFetch({ status: 422, body: { message: "Validation Failed" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "invalid_query" } });
  });

  it("service: 503", async () => {
    expect(await run(fakeFetch({ status: 503, body: {} }))).toMatchObject({ ok: false, failure: { kind: "service", status: 503 } });
  });

  it("network: fetch rejects", async () => {
    expect(await run(fakeFetch(new TypeError("fetch failed")))).toMatchObject({ ok: false, failure: { kind: "network", message: "fetch failed" } });
  });

  it("unexpected response: wrong shape, malformed item, non-JSON body", async () => {
    const bad = [
      { body: { hello: "world" } },
      { body: page([{ ...fixture.items[0], html_url: "not a url" }]) },
      { body: page([{ ...fixture.items[0], node_id: undefined }]) },
      { body: "<html>gateway</html>" },
    ];
    for (const reply of bad) {
      expect(await run(fakeFetch(reply))).toMatchObject({ ok: false, failure: { kind: "unexpected_response" } });
    }
  });

  it("never leaks the token into failure messages", async () => {
    const r = await run(fakeFetch(new TypeError("boom")), q, "super-secret-token");
    expect(JSON.stringify(r)).not.toContain("super-secret-token");
  });
});
