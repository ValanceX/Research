import { describe, expect, it } from "vitest";
import { assembleEvidence, evidenceId, verifyEvidence, type EvidenceDraft } from "../src/index.js";
import { C10, C11, REAL, cm, variant } from "./helpers/sources.js";

const c10 = `comment:${C10}`, c11 = `comment:${C11}`;
const draft = (o: Partial<EvidenceDraft> & Pick<EvidenceDraft, "support">): EvidenceDraft =>
  ({ kind: "problem", subject: "unattributed", context: [], claim: "claim", ...o });
const failure = (r: ReturnType<typeof assembleEvidence>) => { if (r.ok) throw new Error("expected failure"); return r.failure; };
const items = (r: ReturnType<typeof assembleEvidence>) => { if (!r.ok) throw new Error(JSON.stringify(r.failure)); return r.items; };

// ---- REAL drafts (the probe's R1 and R2) ----
const r1 = draft({
  support: [{ unitId: "title", text: "Signals: effect runs twice on init" }, { unitId: "body", text: "2. observe **two** runs" }],
  context: [{ unitId: "body", text: "1. render `<App/>`" }],
  claim: "An effect runs twice during initialization; the steps given are to render <App/> and observe two runs.",
});
const r2 = draft({
  subject: "speaker", support: [{ unitId: c10, text: "I can reproduce." }], context: [{ unitId: "title", text: "Signals: effect runs twice on init" }],
  claim: "alice reports being able to reproduce the effect running twice on init.",
});

describe("successful assembly", () => {
  it("fills source ref, urls, speaker, context unit authors and id; result passes the verifier", () => {
    const [a, b] = items(assembleEvidence(REAL, [r1, r2]));
    expect(a).toEqual({
      id: evidenceId(a!), kind: "problem", subject: "unattributed", claim: r1.claim,
      source: { platform: "github", id: REAL.id, url: REAL.url },
      speaker: { handle: "octocat", kind: "user" },
      support: [{ location: { unit: "title" }, text: "Signals: effect runs twice on init", url: REAL.url }, { location: { unit: "body" }, text: "2. observe **two** runs", url: REAL.url }],
      context: [{ location: { unit: "body" }, text: "1. render `<App/>`", url: REAL.url, unitAuthor: { handle: "octocat", kind: "user" } }],
    });
    expect(b!.speaker).toEqual({ handle: "alice", kind: "user" });
    expect(b!.support[0]!.url).toBe(REAL.comments[0]!.url);
    expect(verifyEvidence(REAL, [a, b]).ok).toBe(true);
  });

  it("context from another unit gets THAT unit's author (alice's item, octocat's title)", () => {
    const [, b] = items(assembleEvidence(REAL, [r1, r2]));
    expect(b!.context[0]!.unitAuthor).toEqual({ handle: "octocat", kind: "user" });
    expect(b!.speaker).not.toEqual(b!.context[0]!.unitAuthor);
  });

  it("an exact multi-line excerpt with the source's own CRLF and trailing spaces resolves", () => {
    const d = draft({ support: [{ unitId: "body", text: "1. render `<App/>`  \r\n2. observe **two** runs" }] });
    expect(assembleEvidence(REAL, [d]).ok).toBe(true);
  });

  it("(hypothetical) different speakers produce separate items", () => {
    const s = variant(cm("i1", "bob", "effect runs twice in 17.1"), cm("i2", "carol", "I see it twice on 17.1 too"));
    const out = items(assembleEvidence(s, [
      draft({ support: [{ unitId: "comment:i1", text: "effect runs twice in 17.1" }] }),
      draft({ subject: "speaker", support: [{ unitId: "comment:i2", text: "I see it twice on 17.1 too" }], context: [{ unitId: "comment:i1", text: "effect runs twice in 17.1" }] }),
    ]));
    expect(out.map((i) => i.speaker?.handle)).toEqual(["bob", "carol"]);
    expect(out[1]!.context[0]!.unitAuthor?.handle).toBe("bob");
    expect(new Set(out.map((i) => i.id)).size).toBe(2);
  });

  it("(hypothetical) a quote line is accepted as context, with unitAuthor = the unit's author", () => {
    const s = variant(cm("q", "carol", "> This is fixed in 17.3\nNot for me, still double on 17.3."));
    const [it] = items(assembleEvidence(s, [draft({
      subject: "speaker", support: [{ unitId: "comment:q", text: "Not for me, still double on 17.3." }],
      context: [{ unitId: "comment:q", text: "This is fixed in 17.3" }],
    })]));
    // unitAuthor names who wrote the UNIT, not who wrote the quoted words.
    expect(it!.context[0]!.unitAuthor).toEqual({ handle: "carol", kind: "user" });
  });

  it("empty drafts are a successful empty result", () => {
    expect(assembleEvidence(REAL, [])).toEqual({ ok: true, items: [] });
  });
});

describe("unresolved units and excerpts", () => {
  it("missing unit ids fail, in support and in context, without guessing", () => {
    const f = failure(assembleEvidence(REAL, [draft({ support: [{ unitId: "comment:IC_nope", text: "x" }], context: [{ unitId: "bogus", text: "y" }] })]));
    expect(f).toMatchObject({ kind: "unresolved", problems: [{ draft: 0, where: "support[0]", code: "unit_not_found" }, { draft: 0, where: "context[0]", code: "unit_not_found" }] });
  });

  it("a body unit on a source without a body is not found", () => {
    const f = failure(assembleEvidence({ ...REAL, body: null }, [draft({ support: [{ unitId: "body", text: "2. observe **two** runs" }] })]));
    expect(f).toMatchObject({ kind: "unresolved", problems: [{ code: "unit_not_found" }] });
  });

  it("does not repair near-misses: paraphrase, case, trimming, newline normalization", () => {
    for (const [unitId, text] of [[c10, "I can repro it."], [c10, "i can reproduce."], [c10, " I can reproduce."], ["body", "1. render `<App/>`\n2. observe **two** runs"], ["body", "1. render `<App/>`\r\n2. observe **two** runs"]] as const) {
      expect(failure(assembleEvidence(REAL, [draft({ support: [{ unitId, text }] })]))).toMatchObject({ kind: "unresolved", problems: [{ code: "excerpt_not_found" }] });
    }
  });

  it("(hypothetical) an excerpt occurring more than once is ambiguous, including overlapping repeats", () => {
    const s = variant(cm("d", "carol", "same here\nsame here"), cm("e", "carol", "aaa"));
    expect(failure(assembleEvidence(s, [draft({ support: [{ unitId: "comment:d", text: "same here" }] })]))).toMatchObject({ problems: [{ code: "excerpt_ambiguous" }] });
    expect(failure(assembleEvidence(s, [draft({ support: [{ unitId: "comment:e", text: "aa" }] })]))).toMatchObject({ problems: [{ code: "excerpt_ambiguous" }] });
    // a longer excerpt that occurs once resolves
    expect(assembleEvidence(s, [draft({ support: [{ unitId: "comment:d", text: "same here\nsame" }] })]).ok).toBe(true);
  });

  it("reports every unresolved excerpt across drafts together", () => {
    const f = failure(assembleEvidence(REAL, [r2, draft({ support: [{ unitId: c10, text: "nope" }] }), draft({ support: [{ unitId: "zzz", text: "x" }] })]));
    expect(f).toMatchObject({ kind: "unresolved", problems: [{ draft: 1, code: "excerpt_not_found" }, { draft: 2, code: "unit_not_found" }] });
  });
});

describe("invalid input", () => {
  it.each([
    ["not an array", { kind: "problem" }],
    ["empty support", [{ ...r2, support: [] }]],
    ["unknown kind", [{ ...r2, kind: "complaint" }]],
    ["unknown subject", [{ ...r2, subject: "everyone" }]],
    ["empty unit id", [{ ...r2, support: [{ unitId: "", text: "x" }] }]],
    ["empty claim", [{ ...r2, claim: "" }]],
    ["draft carrying an id", [{ ...r2, id: "ev1:" + "0".repeat(64) }]],
    ["draft carrying a speaker", [{ ...r2, speaker: { handle: "alice", kind: "user" } }]],
    ["excerpt carrying a url", [{ ...r2, support: [{ unitId: c10, text: "I can reproduce.", url: REAL.url }] }]],
    ["null", null],
  ])("rejects drafts: %s", (_n, bad) => {
    expect(failure(assembleEvidence(REAL, bad)).kind).toBe("invalid_drafts");
  });

  it("rejects a malformed source, even for empty drafts", () => {
    expect(failure(assembleEvidence({} as never, [])).kind).toBe("invalid_source");
    expect(failure(assembleEvidence({ ...REAL, comments: [{ id: "" }] } as never, [r2])).kind).toBe("invalid_source");
  });
});

describe("verifier violations prevent success", () => {
  it("quote-only support: quoted text in context does not become support", () => {
    const s = variant(cm("q", "carol", "> This is fixed in 17.3\nNot for me, still double on 17.3."));
    const f = failure(assembleEvidence(s, [draft({ kind: "resolution", support: [{ unitId: "comment:q", text: "This is fixed in 17.3" }] })]));
    expect(f).toMatchObject({ kind: "verification_failed", violations: [{ code: "quote_only_support" }] });
  });

  it("(real) a bot-authored unit cannot be extracted as evidence", () => {
    const f = failure(assembleEvidence(REAL, [draft({ kind: "resolution", support: [{ unitId: c11, text: "Thanks — fixed in #202." }] })]));
    expect(f).toMatchObject({ kind: "verification_failed", violations: [{ code: "bot_speaker" }] });
  });

  it("support spanning two speakers is rejected (speaker comes from the first support unit)", () => {
    const f = failure(assembleEvidence(REAL, [draft({ support: [{ unitId: c10, text: "I can reproduce." }, { unitId: "title", text: "Signals: effect runs twice on init" }] })]));
    expect(f).toMatchObject({ kind: "verification_failed", violations: [{ code: "speaker_mismatch" }] });
  });

  it("duplicate drafts collide on identity", () => {
    expect(failure(assembleEvidence(REAL, [r2, r2]))).toMatchObject({ kind: "verification_failed", violations: [{ index: 1, code: "duplicate_id" }] });
  });

  it("is all-or-nothing: one bad draft means no items, even if others are fine", () => {
    const r = assembleEvidence(REAL, [r1, r2, draft({ support: [{ unitId: c10, text: "nope" }] })]);
    expect(r.ok).toBe(false);
    expect("items" in r).toBe(false);
  });
});

describe("purity", () => {
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  it("does not mutate frozen inputs and is deterministic", () => {
    const s = deepFreeze(structuredClone(REAL)), d = deepFreeze(structuredClone([r1, r2]));
    expect(assembleEvidence(s, d)).toEqual(assembleEvidence(s, d));
    expect(assembleEvidence(s, d).ok).toBe(true);
  });
});
