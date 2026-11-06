import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evidenceId, normalizeGithubSource, quotedLineRanges, retrieveGithubSource, textUnits, verifyEvidence,
  type DiscoveryRef, type EvidenceItem, type NormalizedComment, type NormalizedSource, type ViolationCode,
} from "../src/index.js";

// ---- Real source: the existing fixtures, run through real retrieval + normalization (no network). ----
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const [issue, comments] = [load("issue"), load("comments")];
const retrieved = await retrieveGithubSource(
  { source: "github", type: "issue", repo: "angular/angular", id: "I_kwDOAAAA1", number: 101 } as DiscoveryRef,
  { token: "t", fetch: (async (u: string | URL | Request) => new Response(JSON.stringify(String(u).includes("/comments") ? comments : issue))) as typeof fetch },
);
const normalized = normalizeGithubSource(retrieved);
if (!normalized.ok) throw new Error("fixture normalization failed");
const real = normalized.source; // comment 10 by alice (user), comment 11 by dependabot[bot]
const U = { thread: real.url, c10: real.comments[0]!.url, c11: real.comments[1]!.url };
const [C10, C11] = [real.comments[0]!.id, real.comments[1]!.id];
const octocat = { handle: "octocat", kind: "user" } as const;
const alice = { handle: "alice", kind: "user" } as const;

// ---- HYPOTHETICAL sources: invented test inputs, not research findings. ----
const cm = (id: string, handle: string | null, body: string, kind: "user" | "bot" = "user"): NormalizedComment => ({
  id, url: `${real.url}#issuecomment-${id}`, body, createdAt: "2026-03-05T00:00:00Z", updatedAt: "2026-03-05T00:00:00Z",
  author: handle === null ? null : { handle, kind, github: { id: 1, type: kind === "bot" ? "Bot" : "User" } },
  github: { databaseId: 1, authorAssociation: "NONE" },
});
const variant = (cs: NormalizedComment[], over: Partial<NormalizedSource> = {}): NormalizedSource => ({ ...real, ...over, comments: cs });

// ---- Item builder: fills source ref and the derived id unless overridden. ----
const P = (loc: EvidenceItem["support"][0]["location"], text: string, url: string) => ({ location: loc, text, url });
const title = { unit: "title" } as const, body = { unit: "body" } as const;
const com = (id: string) => ({ unit: "comment", commentId: id }) as const;
function item(src: NormalizedSource, o: Partial<EvidenceItem> & Pick<EvidenceItem, "support" | "speaker">): EvidenceItem {
  const base = { kind: "problem" as const, source: { platform: src.platform, id: src.id, url: src.url }, context: [], claim: "claim", subject: "unattributed" as const, ...o };
  return { ...base, id: o.id ?? evidenceId(base) };
}
const codes = (src: NormalizedSource, ...items: unknown[]) => [...new Set(verifyEvidence(src, items).violations.map((v) => v.code))].sort() as ViolationCode[];
const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// Real items
const e1 = item(real, {
  speaker: octocat, subject: "unattributed", claim: "An effect runs twice during initialization when rendering <App/>.",
  support: [P(title, "Signals: effect runs twice on init", U.thread), P(body, "2. observe **two** runs", U.thread)],
  context: [{ ...P(body, "1. render `<App/>`", U.thread), author: octocat }],
});
const e2 = item(real, {
  speaker: alice, subject: "speaker", claim: "alice reports reproducing the effect running twice on init.",
  support: [P(com(C10), "I can reproduce.", U.c10)],
  context: [{ ...P(title, "Signals: effect runs twice on init", U.thread), author: octocat }],
});

describe("valid evidence", () => {
  it("accepts the real fixture items (multi-passage same-speaker support; cross-speaker context)", () => {
    expect(verifyEvidence(real, [e1, e2])).toEqual({ ok: true, violations: [] });
  });

  it("accepts every statement kind and every subject value", () => {
    for (const kind of ["problem", "workaround", "desired_outcome", "solution_request", "positive_experience", "resolution"] as const) {
      expect(verifyEvidence(real, [item(real, { kind, speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10)] })]).ok).toBe(true);
    }
    for (const subject of ["speaker", "speaker_and_others", "others", "unattributed"] as const) {
      expect(verifyEvidence(real, [item(real, { subject, speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10)] })]).ok).toBe(true);
    }
  });

  it("(hypothetical) two people on the same problem are two valid items", () => {
    const s = variant([cm("IC_bob", "bob", "effect runs twice in 17.1"), cm("IC_carol", "carol", "I see it twice on 17.1 too")]);
    const bob = item(s, { speaker: { handle: "bob", kind: "user" }, support: [P(com("IC_bob"), "effect runs twice in 17.1", s.comments[0]!.url)] });
    const carol = item(s, { speaker: { handle: "carol", kind: "user" }, subject: "speaker", support: [P(com("IC_carol"), "I see it twice on 17.1 too", s.comments[1]!.url)] });
    expect(verifyEvidence(s, [bob, carol]).ok).toBe(true);
  });

  it("(hypothetical) own commentary on a quote is valid support; the quote is context", () => {
    const s = variant([cm("IC_q", "carol", "> effect runs twice on init\nsame here on 17.2")]);
    const carol = { handle: "carol", kind: "user" } as const;
    const ok = item(s, {
      speaker: carol, subject: "speaker", support: [P(com("IC_q"), "same here on 17.2", s.comments[0]!.url)],
      context: [{ ...P(com("IC_q"), "effect runs twice on init", s.comments[0]!.url), author: carol }],
    });
    expect(verifyEvidence(s, [ok]).ok).toBe(true);
  });

  it("(hypothetical) a resolution by a human maintainer is valid; a null speaker with one author slot is valid", () => {
    const s = variant([cm("IC_m", "maint", "Fixed in #202.")]);
    expect(verifyEvidence(s, [item(s, { kind: "resolution", speaker: { handle: "maint", kind: "user" }, support: [P(com("IC_m"), "Fixed in #202.", s.comments[0]!.url)] })]).ok).toBe(true);
    const nullThread = variant([], { author: null }); // title + body share the one thread-author slot
    expect(verifyEvidence(nullThread, [item(nullThread, { speaker: null, support: [P(title, "Signals: effect runs twice on init", nullThread.url), P(body, "2. observe **two** runs", nullThread.url)] })]).ok).toBe(true);
    const nullComment = variant([cm("IC_n", null, "same here")]);
    expect(verifyEvidence(nullComment, [item(nullComment, { speaker: null, support: [P(com("IC_n"), "same here", nullComment.comments[0]!.url)] })]).ok).toBe(true);
  });

  it("accepts support whose text also occurs outside the quote (occurrence ambiguity is accepted)", () => {
    const s = variant([cm("IC_d", "carol", "> same here\nsame here")]);
    expect(verifyEvidence(s, [item(s, { speaker: { handle: "carol", kind: "user" }, support: [P(com("IC_d"), "same here", s.comments[0]!.url)] })]).ok).toBe(true);
  });
});

describe("schema", () => {
  const base = () => structuredClone(e2) as Record<string, unknown>;
  it.each([
    ["non-object", null],
    ["unknown kind", { ...base(), kind: "complaint" }],
    ["unknown subject", { ...base(), subject: "everyone" }],
    ["empty support", { ...base(), support: [] }],
    ["empty claim", { ...base(), claim: "" }],
    ["malformed id", { ...base(), id: "abc" }],
    ["unknown field (no room for interpretation)", { ...base(), interpretation: "developers struggle" }],
    ["missing speaker", (() => { const b = base(); delete b["speaker"]; return b; })()],
    ["bad passage url", { ...base(), support: [{ ...(e2.support[0]!), url: "nope" }] }],
  ])("rejects %s", (_n, bad) => {
    expect(codes(real, bad)).toEqual(["schema"]);
  });
});

describe("source identity and locations", () => {
  it("flags platform, id and url mismatches individually", () => {
    const v = verifyEvidence(real, [{ ...e2, source: { platform: "gitlab", id: "other", url: "https://example.com/x" } }]).violations;
    expect(v.filter((x) => x.code === "source_mismatch")).toHaveLength(3);
  });
  it("flags a comment that does not exist, and a body that is absent", () => {
    expect(codes(real, item(real, { speaker: alice, support: [P(com("IC_nope"), "x", U.c10)] }))).toEqual(["location_missing"]);
    const noBody = { ...real, body: null };
    expect(codes(noBody, item(noBody, { speaker: octocat, support: [P(body, "2. observe **two** runs", U.thread)] }))).toEqual(["location_missing"]);
  });
});

describe("exact excerpts and permalinks", () => {
  it("rejects paraphrase, case change, and trimmed/extended text", () => {
    for (const text of ["I can repro it.", "i can reproduce.", "I can reproduce. Thanks", " I can reproduce."]) {
      expect(codes(real, item(real, { speaker: alice, support: [P(com(C10), text, U.c10)] }))).toEqual(["text_not_found"]);
    }
  });
  it("rejects the wrong permalink (thread url on a comment passage)", () => {
    expect(codes(real, item(real, { speaker: alice, support: [P(com(C10), "I can reproduce.", U.thread)] }))).toEqual(["url_mismatch"]);
  });
  it("reports several problems in one item together", () => {
    expect(codes(real, item(real, { speaker: alice, support: [P(com(C10), "nope", U.thread)] }))).toEqual(["text_not_found", "url_mismatch"]);
  });
});

describe("speakers", () => {
  it("rejects support mixing speakers (real: alice's comment + octocat's title)", () => {
    expect(codes(real, item(real, { speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10), P(title, "Signals: effect runs twice on init", U.thread)] }))).toEqual(["speaker_mismatch"]);
  });
  it("rejects (hypothetical) two people's statements merged into one item", () => {
    const s = variant([cm("IC_bob", "bob", "effect runs twice in 17.1"), cm("IC_carol", "carol", "I see it twice on 17.1 too")]);
    const merged = item(s, { speaker: { handle: "bob", kind: "user" }, support: [P(com("IC_bob"), "effect runs twice in 17.1", s.comments[0]!.url), P(com("IC_carol"), "I see it twice on 17.1 too", s.comments[1]!.url)] });
    expect(codes(s, merged)).toEqual(["speaker_mismatch"]);
  });
  it("compares handle AND kind (same handle, different kind is a different speaker)", () => {
    expect(codes(real, item(real, { speaker: { handle: "alice", kind: "bot" }, support: [P(com(C10), "I can reproduce.", U.c10)] }))).toEqual(["bot_speaker", "speaker_mismatch"]);
  });
  it("restricts a null speaker to one author slot, since two null authors may differ", () => {
    const s = variant([cm("IC_1", null, "same here"), cm("IC_2", null, "me too")]);
    const two = item(s, { speaker: null, support: [P(com("IC_1"), "same here", s.comments[0]!.url), P(com("IC_2"), "me too", s.comments[1]!.url)] });
    expect(codes(s, two)).toEqual(["null_speaker_multi_slot"]);
  });
  it("a null speaker cannot cover a known author's unit", () => {
    expect(codes(real, item(real, { speaker: null, support: [P(com(C10), "I can reproduce.", U.c10)] }))).toEqual(["speaker_mismatch"]);
  });
  it("excludes bot speakers (real: comment 11 is by dependabot[bot])", () => {
    const botItem = item(real, { kind: "resolution", speaker: { handle: "dependabot[bot]", kind: "bot" }, support: [P(com(C11), "Thanks — fixed in #202.", U.c11)] });
    expect(codes(real, botItem)).toEqual(["bot_speaker"]);
  });
});

describe("quoted material", () => {
  it("rejects support that is only the `> quoted` line of real comment 10", () => {
    expect(codes(real, item(real, { speaker: alice, support: [P(com(C10), "quoted", U.c10)] }))).toEqual(["quote_only_support"]);
  });
  it("rejects support that spans from a quote into the speaker's own text (hypothetical)", () => {
    const s = variant([cm("IC_q", "carol", "> effect runs twice on init\nsame here on 17.2")]);
    const spans = item(s, { speaker: { handle: "carol", kind: "user" }, support: [P(com("IC_q"), "effect runs twice on init\nsame here", s.comments[0]!.url)] });
    expect(codes(s, spans)).toEqual(["quote_only_support"]);
  });
  it("does not treat an indented-code `>` (4 spaces) as a quote, and handles CRLF", () => {
    expect(quotedLineRanges("a\n    > code\nb")).toEqual([]);
    expect(quotedLineRanges("a\r\n> q\r\nb")).toEqual([[3, 6]]);
    expect(quotedLineRanges("> a\n   > b\n>\nc\n>> d")).toEqual([[0, 3], [4, 10], [11, 12], [15, 19]]);
    expect(quotedLineRanges("")).toEqual([]);
  });
  it("does NOT detect quotes without a `>` marker (documented limit)", () => {
    const s = variant([cm("IC_u", "carol", 'bob said: "effect runs twice"\nI agree')]);
    expect(verifyEvidence(s, [item(s, { speaker: { handle: "carol", kind: "user" }, support: [P(com("IC_u"), "effect runs twice", s.comments[0]!.url)] })]).ok).toBe(true);
  });
});

describe("context", () => {
  it("rejects a context author that differs from the unit's author", () => {
    const bad = item(real, { speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10)], context: [{ ...P(title, "Signals: effect runs twice on init", U.thread), author: alice }] });
    expect(codes(real, bad)).toEqual(["context_author_mismatch"]);
  });
  it("applies location/text/url checks to context too", () => {
    const bad = item(real, { speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10)], context: [{ ...P(title, "not the title", U.thread), author: octocat }] });
    expect(codes(real, bad)).toEqual(["text_not_found"]);
  });
});

describe("identity", () => {
  it("rejects a tampered id, and duplicate ids in one batch", () => {
    expect(codes(real, { ...e2, id: `ev1:${"0".repeat(64)}` })).toEqual(["id_mismatch"]);
    const v = verifyEvidence(real, [e2, e2]).violations;
    expect(v.map((x) => [x.index, x.code])).toEqual([[1, "duplicate_id"]]);
  });
  it("is stable when claim, context or subject change, and independent of support order", () => {
    const id = evidenceId(e1);
    expect(id).toMatch(/^ev1:[0-9a-f]{64}$/);
    expect(evidenceId({ ...e1, claim: "reworded entirely" } as EvidenceItem)).toBe(id);
    expect(evidenceId({ ...e1, context: [] } as EvidenceItem)).toBe(id);
    expect(evidenceId({ ...e1, subject: "others" } as EvidenceItem)).toBe(id);
    expect(evidenceId({ ...e1, support: [...e1.support].reverse() })).toBe(id);
    expect(evidenceId({ ...e1, support: [...e1.support, e1.support[0]!] })).toBe(id); // a set, not a list
    expect(verifyEvidence(real, [{ ...e1, claim: "reworded entirely", subject: "others", context: [] }]).ok).toBe(true); // and still verifies
  });
  it("changes when kind, support text/location, source id or platform change", () => {
    const id = evidenceId(e1);
    expect(evidenceId({ ...e1, kind: "workaround" })).not.toBe(id);
    expect(evidenceId({ ...e1, support: [e1.support[0]!] })).not.toBe(id);
    expect(evidenceId({ ...e1, support: [{ ...e1.support[0]!, text: "Signals: effect runs twice" }, e1.support[1]!] })).not.toBe(id);
    expect(evidenceId({ ...e1, support: [{ ...e1.support[1]!, location: title }, e1.support[0]!] })).not.toBe(id);
    expect(evidenceId({ ...e1, source: { ...e1.source, id: "other" } })).not.toBe(id);
    expect(evidenceId({ ...e1, source: { ...e1.source, platform: "gitlab" } })).not.toBe(id);
  });
});

describe("platform independence and purity", () => {
  it("never reads GitHub-specific metadata: verifies with every `github` bag removed", () => {
    const stripped = JSON.parse(JSON.stringify(real));
    delete stripped.github;
    for (const c of stripped.comments) delete c.github;
    for (const a of [stripped.author, ...stripped.comments.map((c: { author: unknown }) => c.author)]) if (a) delete a.github;
    expect(verifyEvidence(stripped, [e1, e2]).ok).toBe(true);
  });
  it("(hypothetical) works for another platform string, and rejects an item that names the wrong one", () => {
    const other = { ...real, platform: "gitlab" } as unknown as NormalizedSource;
    const asGitlab = item(other, { speaker: alice, support: [P(com(C10), "I can reproduce.", U.c10)] });
    expect(asGitlab.source.platform).toBe("gitlab");
    expect(verifyEvidence(other, [asGitlab]).ok).toBe(true);
    expect(codes(real, asGitlab)).toEqual(["source_mismatch"]); // platform differs from the source (the id is consistent with the item's own platform)
  });
  it("textUnits lists title, body, then comments with author slots; skips a null body", () => {
    expect(textUnits(real).map((u) => [u.location.unit, u.slot])).toEqual([["title", "thread"], ["body", "thread"], ["comment", `comment:${C10}`], ["comment", `comment:${C11}`]]);
    expect(textUnits({ ...real, body: null }).map((u) => u.location.unit)).toEqual(["title", "comment", "comment"]);
  });
  it("does not mutate frozen inputs and is deterministic", () => {
    const s = deepFreeze(structuredClone(real)), items = deepFreeze(structuredClone([e1, e2]));
    expect(verifyEvidence(s, items)).toEqual(verifyEvidence(s, items));
    expect(verifyEvidence(s, items).ok).toBe(true);
  });
});
