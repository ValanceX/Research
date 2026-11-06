import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeGithubSource, retrieveGithubSource, type DiscoveryRef, type RetrievalResult } from "../src/index.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const issue = load("issue"), pull = load("pull"), comments = load("comments");

/** Realistic input: run the real retrieval over the existing fixtures (no network). */
async function retrieved(type: "issue" | "pull_request", payload: object, commentPayload: object[] = comments): Promise<RetrievalResult> {
  const fakeFetch = async (input: string | URL | Request) => {
    const body = String(input).includes("/comments") ? commentPayload : payload;
    return new Response(JSON.stringify(body));
  };
  const ref = type === "issue"
    ? { id: "I_kwDOAAAA1", number: 101 }
    : { id: "PR_kwDOAAAA2", number: 202 };
  return retrieveGithubSource({ source: "github", type, repo: "angular/angular", ...ref } as DiscoveryRef, { token: "t", fetch: fakeFetch as typeof fetch });
}

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};
const ok = (r: ReturnType<typeof normalizeGithubSource>) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.source; };

describe("issue", () => {
  it("maps identity, content, metadata and comments; platform bits stay in `github`", async () => {
    const s = ok(normalizeGithubSource(await retrieved("issue", issue)));
    expect(s).toEqual({
      platform: "github", id: "I_kwDOAAAA1", kind: "issue", url: "https://github.com/angular/angular/issues/101", container: "angular/angular",
      title: "Signals: effect runs twice on init", body: issue.body,
      author: { handle: "octocat", kind: "user", github: { id: 583231, type: "User" } },
      state: "open", createdAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-02T11:30:00Z", closedAt: null,
      labels: ["area: core", "bug"],
      comments: [
        {
          id: "IC_kwDOAAAA10", url: "https://github.com/angular/angular/issues/101#issuecomment-10",
          author: { handle: "alice", kind: "user", github: { id: 1, type: "User" } }, body: comments[0].body,
          createdAt: "2026-03-01T12:00:00Z", updatedAt: "2026-03-01T12:05:00Z", github: { databaseId: 10, authorAssociation: "MEMBER" },
        },
        expect.objectContaining({ id: "IC_kwDOAAAA11", author: { handle: "dependabot[bot]", kind: "bot", github: { id: 2, type: "Bot" } }, github: { databaseId: 11, authorAssociation: "NONE" } }),
      ],
      github: { number: 101, locked: false, authorAssociation: "CONTRIBUTOR", commentCount: 2 },
    });
    expect(s.body).toBe(issue.body); // CRLF, trailing space, unicode untouched
    expect("pullRequest" in s.github).toBe(false);
  });

  it("keeps comments in the order retrieval delivered them, and keeps an empty list empty", async () => {
    const r = await retrieved("issue", issue);
    if (!r.ok) throw new Error();
    const reversed = { ...r, comments: [...r.comments].reverse() };
    expect(ok(normalizeGithubSource(reversed)).comments.map((c) => c.github.databaseId)).toEqual([11, 10]); // not re-sorted
    expect(ok(normalizeGithubSource(await retrieved("issue", issue, []))).comments).toEqual([]);
  });
});

describe("pull request", () => {
  it("merged PR: kind preserved, state `merged`, null body/author explicit, PR facts in github", async () => {
    const s = ok(normalizeGithubSource(await retrieved("pull_request", pull)));
    expect(s).toMatchObject({
      kind: "pull_request", state: "merged", body: null, author: null, closedAt: "2026-03-04T09:00:00Z", labels: [],
      github: { number: 202, authorAssociation: "MEMBER", pullRequest: { draft: false, mergedAt: "2026-03-04T09:00:00Z" } },
    });
  });

  it("closedAt and mergedAt are preserved independently when they differ", async () => {
    const r = await retrieved("pull_request", { ...pull, closed_at: "2026-03-05T10:00:00Z", merged_at: "2026-03-04T09:30:00Z" });
    if (!r.ok) throw new Error();
    // Guard the premise: the retrieved values really differ.
    expect(r.source.meta.closedAt).toBe("2026-03-05T10:00:00Z");
    expect(r.source.meta.pullRequest?.mergedAt).toBe("2026-03-04T09:30:00Z");
    const s = ok(normalizeGithubSource(r));
    expect(s.closedAt).toBe(r.source.meta.closedAt);
    expect(s.github.pullRequest?.mergedAt).toBe(r.source.meta.pullRequest?.mergedAt);
    expect(s.state).toBe("merged");
    expect(s.createdAt).toBe(r.source.createdAt); // no timestamp rewritten
    expect(s.updatedAt).toBe(r.source.updatedAt);
  });

  it("closed-without-merge stays `closed`", async () => {
    const s = ok(normalizeGithubSource(await retrieved("pull_request", { ...pull, merged: false, merged_at: null })));
    expect(s.state).toBe("closed");
    expect(s.github.pullRequest).toEqual({ draft: false, mergedAt: null });
  });
});

describe("author kinds and null comment author", () => {
  it("maps Organization to `other` but keeps the raw type; deleted comment author stays null", async () => {
    const s = ok(normalizeGithubSource(await retrieved("issue", { ...issue, user: { login: "acme", id: 9, type: "Organization" } },
      [{ ...comments[0], user: null }])));
    expect(s.author).toEqual({ handle: "acme", kind: "other", github: { id: 9, type: "Organization" } });
    expect(s.comments[0]!.author).toBeNull();
  });
});

describe("purity", () => {
  it("does not mutate its input, and its output shares no references with it", async () => {
    const r = deepFreeze(await retrieved("issue", issue)); // would throw on any write
    const before = JSON.stringify(r);
    const s = ok(normalizeGithubSource(r));
    expect(JSON.stringify(r)).toBe(before);
    s.labels.push("tampered");
    s.comments[0]!.body = "tampered";
    expect(JSON.stringify(r)).toBe(before);
    expect(normalizeGithubSource(r)).toEqual(normalizeGithubSource(r)); // deterministic
  });
});

describe("rejected input", () => {
  it("a failed retrieval is not normalized", async () => {
    const r = await retrieveGithubSource({ source: "github", type: "issue", repo: "a/b", id: "x", number: 1 } as DiscoveryRef, {
      token: "t", fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(normalizeGithubSource(r)).toEqual({ ok: false, failure: { kind: "retrieval_failed", message: expect.stringContaining("not_found") } });
  });

  it("a partial retrieval (failure carrying partial content) is not normalized either", async () => {
    const good = await retrieved("issue", issue);
    if (!good.ok) throw new Error();
    const partial: RetrievalResult = { ok: false, failure: { kind: "service", message: "x", status: 502 }, partial: { source: good.source, comments: good.comments } };
    expect(normalizeGithubSource(partial)).toMatchObject({ ok: false, failure: { kind: "retrieval_failed" } });
  });

  it.each([
    ["null", null],
    ["empty object", {}],
    ["success without source", { ok: true, comments: [] }],
    ["unknown state", { source: { state: "weird" } }],
    ["PR without pullRequest meta", { source: { type: "pull_request", meta: { pullRequest: undefined } } }],
    ["issue with pullRequest meta", { source: { meta: { pullRequest: { draft: false, merged: false, mergedAt: null } } } }],
    ["open PR flagged merged", { source: { state: "open", type: "pull_request", meta: { pullRequest: { draft: false, merged: true, mergedAt: "2026-03-04T09:00:00Z" } } } }],
    ["malformed comment", { comments: [{ id: "" }] }],
  ])("invalid input: %s", async (_n, patch) => {
    const good = await retrieved("issue", issue);
    if (!good.ok) throw new Error();
    const bad = patch === null || Object.keys(patch).length === 0 || (patch as { ok?: boolean }).ok
      ? patch
      : { ...good, ...patch, source: { ...good.source, ...(patch as { source?: object }).source, meta: { ...good.source.meta, ...((patch as { source?: { meta?: object } }).source?.meta ?? {}) } } };
    expect(normalizeGithubSource(bad as never)).toMatchObject({ ok: false, failure: { kind: "invalid_input" } });
  });
});
