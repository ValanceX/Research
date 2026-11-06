import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retrieveGithubSource, type DiscoveryRef } from "../src/index.js";
import type { FetchLike } from "../src/github/transport.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const issue = load("issue"), pull = load("pull"), comments = load("comments");

const ref = (over: Partial<DiscoveryRef> = {}): DiscoveryRef => ({
  id: "I_kwDOAAAA1", source: "github", type: "issue", title: "t", url: "https://github.com/angular/angular/issues/101",
  repo: "angular/angular", number: 101, createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-02T11:30:00Z",
  meta: { state: "open", commentCount: 2, labels: [], score: 1 }, ...over,
});
const prRef = ref({ id: "PR_kwDOAAAA2", type: "pull_request", number: 202 });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Fake fetch routed by path (+ `?page=N` for comments). Records every requested path. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const fn: FetchLike = async (input) => {
    const u = new URL(String(input));
    const key = u.pathname + (u.searchParams.has("page") ? `?page=${u.searchParams.get("page")}` : "");
    calls.push(key);
    const r = routes[key] ?? { status: 599, body: { message: `unrouted ${key}` } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { fn, calls };
}
const SRC = "/repos/angular/angular/issues/101";
const CMT = (p: number) => `/repos/angular/angular/issues/101/comments?page=${p}`;
const run = (f: ReturnType<typeof fakeFetch>, r: DiscoveryRef = ref(), token: string | undefined = "test-token") =>
  retrieveGithubSource(r, { token, fetch: f.fn });

// n synthetic comments, ids start..start+n-1, created one minute apart in id order.
const mk = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ...comments[0], node_id: `IC_${start + i}`, id: start + i,
    created_at: new Date(Date.UTC(2026, 2, 5, 0, start + i)).toISOString().replace(".000Z", "Z"),
  }));

describe("sources", () => {
  it("retrieves an issue via /issues/{n} and normalizes it, preserving the body byte-for-byte", async () => {
    const f = fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: comments, headers: { "x-ratelimit-remaining": "40" } } });
    const r = await run(f);
    expect(f.calls).toEqual([SRC, CMT(1)]);
    expect(r).toMatchObject({ ok: true, rateLimit: { remaining: 40 } });
    if (!r.ok) throw new Error();
    expect(r.source).toEqual({
      id: "I_kwDOAAAA1", type: "issue", repo: "angular/angular", number: 101, title: "Signals: effect runs twice on init",
      body: issue.body, author: { login: "octocat", id: 583231, type: "User" }, state: "open",
      url: "https://github.com/angular/angular/issues/101", createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-02T11:30:00Z",
      meta: { closedAt: null, locked: false, authorAssociation: "CONTRIBUTOR", labels: ["area: core", "bug"], commentCount: 2 },
    });
    expect(r.source.body).toBe(issue.body); // \r\n, trailing spaces, unicode intact
  });

  it("retrieves a pull request via /pulls/{n}, comments still via /issues/{n}/comments", async () => {
    const f = fakeFetch({ "/repos/angular/angular/pulls/202": { body: pull }, "/repos/angular/angular/issues/202/comments?page=1": { body: [] } });
    const r = await run(f, prRef);
    expect(f.calls).toEqual(["/repos/angular/angular/pulls/202", "/repos/angular/angular/issues/202/comments?page=1"]);
    expect(r).toMatchObject({
      ok: true, comments: [],
      source: { type: "pull_request", body: null, author: null, state: "closed", meta: { pullRequest: { draft: false, merged: true, mergedAt: "2026-03-04T09:00:00Z" } } },
    });
  });

  it("rejects a response whose id differs from the reference", async () => {
    const r = await run(fakeFetch({ [SRC]: { body: issue } }), ref({ id: "I_someone_else" }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "unexpected_response" } });
  });
});

describe("comments", () => {
  it("normalizes comments verbatim with ids, authors, urls and association", async () => {
    const r = await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: comments } }));
    if (!r.ok) throw new Error();
    expect(r.comments).toEqual([
      {
        id: "IC_kwDOAAAA10", databaseId: 10, author: { login: "alice", id: 1, type: "User" }, body: comments[0].body,
        createdAt: "2026-03-01T12:00:00Z", updatedAt: "2026-03-01T12:05:00Z",
        url: "https://github.com/angular/angular/issues/101#issuecomment-10", authorAssociation: "MEMBER",
      },
      expect.objectContaining({ databaseId: 11, author: { login: "dependabot[bot]", id: 2, type: "Bot" }, authorAssociation: "NONE" }),
    ]);
  });

  it("an empty comment collection is a complete success", async () => {
    const r = await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: [] } }));
    expect(r).toMatchObject({ ok: true, comments: [] });
  });

  it("pages until a short page and removes duplicates that shift between pages", async () => {
    const f = fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: mk(0, 100) }, [CMT(2)]: { body: mk(95, 100) }, [CMT(3)]: { body: mk(190, 5) } });
    const r = await run(f);
    expect(f.calls).toEqual([SRC, CMT(1), CMT(2), CMT(3)]);
    if (!r.ok) throw new Error();
    expect(r.comments.map((c) => c.databaseId)).toEqual(Array.from({ length: 195 }, (_, i) => i)); // 0..194, each once
  });

  it("a full last page costs one extra empty request, then completes", async () => {
    const f = fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: mk(0, 100) }, [CMT(2)]: { body: [] } });
    const r = await run(f);
    expect(r.ok && r.comments).toHaveLength(100);
  });

  it("orders oldest-first by createdAt then id, whatever order GitHub returns", async () => {
    const same = { ...comments[1], created_at: comments[0].created_at };
    const r = await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { body: [comments[1], same, comments[0]].map((c, i) => ({ ...c, node_id: `IC_${i}`, id: [11, 12, 10][i] })) } }));
    expect(r.ok && r.comments.map((c) => c.databaseId)).toEqual([10, 12, 11]); // 10 & 12 share a timestamp → id; 11 is later
  });
});

describe("failures", () => {
  const src = (r: Reply) => fakeFetch({ [SRC]: r });

  it("invalid input is rejected without any request", async () => {
    for (const bad of [ref({ repo: "nope" }), ref({ number: 0 }), ref({ id: "" }), ref({ type: "discussion" as never }), null as never, {} as never]) {
      const f = fakeFetch({});
      expect(await run(f, bad)).toMatchObject({ ok: false, failure: { kind: "invalid_reference" } });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("missing token fails as auth without any request", async () => {
    const f = fakeFetch({});
    const saved = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      expect(await retrieveGithubSource(ref(), { fetch: f.fn })).toMatchObject({ ok: false, failure: { kind: "auth" } });
    } finally {
      if (saved !== undefined) process.env["GITHUB_TOKEN"] = saved;
    }
    expect(f.calls).toHaveLength(0);
  });

  const PULL = "/repos/angular/angular/pulls/202";
  it.each([
    ["401 → auth", { status: 401, body: { message: "Bad credentials" } }, "auth"],
    ["403 (quota left) → forbidden", { status: 403, body: { message: "Resource not accessible" }, headers: { "x-ratelimit-remaining": "9" } }, "forbidden"],
    ["404 → not_found", { status: 404, body: { message: "Not Found" } }, "not_found"],
    ["410 → not_found", { status: 410, body: { message: "Gone" } }, "not_found"],
    ["403 + exhausted quota → rate_limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }, "rate_limited"],
    ["429 → rate_limited", { status: 429, headers: { "retry-after": "30" } }, "rate_limited"],
    ["503 → service", { status: 503 }, "service"],
    ["network error", new TypeError("fetch failed"), "network"],
    ["malformed source", { body: { ...issue, created_at: "yesterday" } }, "unexpected_response"],
    ["source missing required field", { body: { ...issue, node_id: undefined } }, "unexpected_response"],
    ["422 → unexpected_response", { status: 422, body: { message: "weird" } }, "unexpected_response"],
  ] as [string, Reply, string][])("source %s: no usable content", async (_n, reply, kind) => {
    const r = await run(src(reply));
    expect(r).toMatchObject({ ok: false, failure: { kind } });
    expect("partial" in r).toBe(false);
  });

  it("a pull request response missing the merged flag is malformed", async () => {
    const r = await run(fakeFetch({ [PULL]: { body: { ...pull, merged: undefined } } }), prRef);
    expect(r).toMatchObject({ ok: false, failure: { kind: "unexpected_response" } });
    expect("partial" in r).toBe(false);
  });

  it("rate-limit failure carries reset info", async () => {
    const r = await run(src({ status: 429, headers: { "retry-after": "30" } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "rate_limited", retryAfterSeconds: 30 } });
  });
});

describe("partial retrieval", () => {
  const routes = (page3: Reply) => ({ [SRC]: { body: issue }, [CMT(1)]: { body: mk(0, 100) }, [CMT(2)]: { body: mk(100, 100) }, [CMT(3)]: page3 });

  it.each([
    ["rate limit", { status: 429, headers: { "retry-after": "5" } }, "rate_limited"],
    ["5xx", { status: 502 }, "service"],
    ["network error", new TypeError("socket hang up"), "network"],
    ["malformed comment page", { body: [{ ...comments[0], html_url: "nope" }] }, "unexpected_response"],
    ["comment page that is not an array", { body: { message: "hi" } }, "unexpected_response"],
  ] as [string, Reply, string][])("%s on page 3 keeps the source and pages 1–2 as partial, never as ok", async (_n, reply, kind) => {
    const r = await run(fakeFetch(routes(reply)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe(kind);
    expect(r.partial?.source.id).toBe("I_kwDOAAAA1");
    expect(r.partial?.comments.map((c) => c.databaseId)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect("comments" in r).toBe(false); // can't be mistaken for a complete result
  });

  it("failure on the first comment page keeps the source with an empty comment list", async () => {
    const r = await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { status: 500 } }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "service" }, partial: { comments: [], source: { number: 101 } } });
  });

  it("403 / 404 on the comments endpoint map to forbidden / not_found, with the source retained", async () => {
    expect(await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { status: 403, body: {} } }))).toMatchObject({ failure: { kind: "forbidden" }, partial: {} });
    expect(await run(fakeFetch({ [SRC]: { body: issue }, [CMT(1)]: { status: 404, body: {} } }))).toMatchObject({ failure: { kind: "not_found" }, partial: {} });
  });

  it("never leaks the token into failure output", async () => {
    const r = await run(fakeFetch({ [SRC]: new TypeError("boom") }), ref(), "super-secret-token");
    expect(JSON.stringify(r)).not.toContain("super-secret-token");
  });
});
