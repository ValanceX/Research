/**
 * Opt-in smoke test for retrieval against the real GitHub API (read-only GETs).
 * Run: GITHUB_TOKEN=... pnpm test:live      (skips without a token; excluded from `pnpm test`)
 *
 * Sources are old, closed, high-profile microsoft/TypeScript threads. Their node ids
 * are permanent identifiers. Assertions are lower bounds / structural, never exact
 * comment text, so edits and later comments don't break them.
 */
import { describe, expect, it } from "vitest";
import { discoverGithub, retrieveGithubSource, type DiscoveryRef, type GithubComment, type RetrievalResult } from "../../src/index.js";

const REPO = "microsoft/TypeScript";
const stub = (over: Partial<DiscoveryRef>): DiscoveryRef => ({
  source: "github", title: "", createdAt: "2016-01-01T00:00:00Z", updatedAt: "2016-01-01T00:00:00Z",
  meta: { state: "closed", commentCount: 0, labels: [], score: 0 }, repo: REPO, id: "", type: "issue", number: 0, url: "https://github.com/", ...over,
});
// #9998 "Trade-offs in Control Flow Analysis": ~110 comments, so it needs a second page (100 per page).
const MANY = stub({ id: "MDU6SXNzdWUxNjc5ODQ2MzQ=", number: 9998, url: `https://github.com/${REPO}/issues/9998` });
// #4276: an old pull request.
const PR = stub({ id: "MDExOlB1bGxSZXF1ZXN0NDIxNDE4ODg=", type: "pull_request", number: 4276, url: `https://github.com/${REPO}/pull/4276` });

function expectComments(comments: GithubComment[], number: number) {
  expect(new Set(comments.map((c) => c.id)).size).toBe(comments.length);
  for (const [i, c] of comments.entries()) {
    expect(c.id).not.toBe("");
    expect(c.databaseId).toBeGreaterThan(0);
    expect(typeof c.body).toBe("string");
    const u = new URL(c.url);
    expect(u.hostname).toBe("github.com");
    expect(u.pathname.toLowerCase()).toMatch(new RegExp(`^/${REPO.toLowerCase()}/(issues|pull)/${number}$`));
    expect(u.hash).toBe(`#issuecomment-${c.databaseId}`);
    if (i > 0) expect(c.createdAt >= comments[i - 1]!.createdAt).toBe(true); // oldest first
  }
}
function expectComplete(r: RetrievalResult): asserts r is Extract<RetrievalResult, { ok: true }> {
  expect(r.ok, JSON.stringify(r.ok ? {} : { failure: r.failure })).toBe(true);
}

describe.skipIf(!process.env["GITHUB_TOKEN"])("GitHub retrieval (live)", () => {
  it("retrieves a reference produced by real discovery (source + comments, possibly none)", async () => {
    const found = await discoverGithub({ text: "bug", repo: REPO, limit: 3 });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const target = found.refs[0]!;
    const r = await retrieveGithubSource(target);
    expectComplete(r);
    expect(r.source.id).toBe(target.id); // provenance holds end to end
    expect(r.source.url).toBe(target.url);
    expect(r.source.title).toBe(target.title);
    expect(r.source.createdAt).toBe(target.createdAt);
    expect(typeof r.source.state).toBe("string");
    expect(r.rateLimit.remaining).toBeTypeOf("number");
    expectComments(r.comments, target.number); // empty is valid
  });

  it("pages through >100 comments without duplicates, oldest first", async () => {
    const r = await retrieveGithubSource(MANY);
    expectComplete(r);
    expect(r.source).toMatchObject({ id: MANY.id, number: 9998, type: "issue", repo: REPO });
    expect(r.source.body).toBeTypeOf("string");
    expect(r.source.author?.login).toBeTypeOf("string");
    expect(r.comments.length).toBeGreaterThan(100); // proves page 2 was fetched
    expectComments(r.comments, 9998);
  });

  it("retrieves a pull request with PR metadata and conversation comments only", async () => {
    const r = await retrieveGithubSource(PR);
    expectComplete(r);
    expect(r.source).toMatchObject({ id: PR.id, type: "pull_request", number: 4276 });
    expect(r.source.meta.pullRequest).toMatchObject({ draft: expect.any(Boolean), merged: expect.any(Boolean) });
    expectComments(r.comments, 4276);
  });

  it("reports not_found for a nonexistent issue number", async () => {
    const r = await retrieveGithubSource(stub({ id: "X", number: 999_999_999 }));
    expect(r).toMatchObject({ ok: false, failure: { kind: "not_found" } });
  });

  it("reports auth failure for a bad token", async () => {
    expect(await retrieveGithubSource(MANY, { token: "not-a-real-token" })).toMatchObject({ ok: false, failure: { kind: "auth" } });
  });
});
