/**
 * Opt-in smoke test against the real GitHub API (read-only searches).
 * Run: GITHUB_TOKEN=... pnpm test:live
 * Skips when no token is present; excluded from `pnpm test`.
 *
 * Uses microsoft/TypeScript (huge, long-lived) with a broad query and a closed
 * historical date window, so no assertion depends on any specific issue existing.
 */
import { describe, expect, it } from "vitest";
import { discoverGithub, type DiscoveryRef } from "../../src/index.js";

const REPO = "microsoft/TypeScript";

function expectWellFormed(refs: DiscoveryRef[]) {
  expect(new Set(refs.map((x) => x.id)).size).toBe(refs.length);
  for (const ref of refs) {
    expect(ref.id).not.toBe("");
    expect(["issue", "pull_request"]).toContain(ref.type);
    expect(ref.repo.toLowerCase()).toBe(REPO.toLowerCase());
    const url = new URL(ref.url);
    expect(url.hostname).toBe("github.com");
    expect(url.pathname.toLowerCase()).toBe(`/${REPO.toLowerCase()}/${ref.type === "issue" ? "issues" : "pull"}/${ref.number}`);
    expect(Number.isNaN(Date.parse(ref.createdAt))).toBe(false);
    expect(Date.parse(ref.updatedAt)).toBeGreaterThanOrEqual(Date.parse(ref.createdAt));
  }
}

describe.skipIf(!process.env["GITHUB_TOKEN"])("GitHub discovery (live)", () => {
  it("authenticates and returns well-formed refs, with rate-limit info", async () => {
    const r = await discoverGithub({ text: "bug", repo: REPO, limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs.length).toBeGreaterThan(0);
    expect(r.refs.length).toBeLessThanOrEqual(5);
    expectWellFormed(r.refs);
    expect(r.rateLimit.remaining).toBeTypeOf("number"); // proves the real API answered an authenticated call
  });

  it("rejects a bad token as an auth failure", async () => {
    const r = await discoverGithub({ text: "bug", repo: REPO, limit: 1 }, { token: "not-a-real-token" });
    expect(r).toMatchObject({ ok: false, failure: { kind: "auth" } });
  });

  it("pages past 100 results without duplicates", async () => {
    const r = await discoverGithub({ text: "bug", repo: REPO, limit: 120 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs).toHaveLength(120); // 2 real requests
    expectWellFormed(r.refs);
  });

  it("applies the creation-date window (inclusive, UTC)", async () => {
    const from = "2023-03-01", to = "2023-03-31";
    const r = await discoverGithub({ text: "bug", repo: REPO, createdBetween: { from, to }, limit: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs.length).toBeGreaterThan(0);
    for (const ref of r.refs) {
      expect(Date.parse(ref.createdAt)).toBeGreaterThanOrEqual(Date.parse(`${from}T00:00:00Z`));
      expect(Date.parse(ref.createdAt)).toBeLessThan(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
    }
  });
});
