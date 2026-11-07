/**
 * Turns extractor drafts into verified EvidenceItems. Pure and deterministic; all-or-nothing:
 * any problem returns a structured failure and NO items. It never repairs excerpts (no whitespace
 * normalization, no fuzzy matching) and never guesses unit ids.
 */
import { z } from "zod";
import { evidenceDraftSchema } from "../contracts/evidence-draft.js";
import type { ContextPassage, EvidenceItem, Passage } from "../contracts/evidence.js";
import type { NormalizedSource } from "../contracts/normalized.js";
import { evidenceId } from "./id.js";
import { locationKey, textUnits, type TextUnit } from "./units.js";
import { verifyEvidence, type Violation } from "./verify.js";

export interface UnresolvedExcerpt {
  /** Index of the draft in the input array. */
  draft: number;
  where: string; // e.g. "support[0]", "context[1]"
  code: "unit_not_found" | "excerpt_not_found" | "excerpt_ambiguous";
  message: string;
}

export type AssemblyFailure =
  | { kind: "invalid_source"; message: string } // the NormalizedSource is not well-formed
  | { kind: "invalid_drafts"; message: string } // drafts do not match the draft schema
  | { kind: "unresolved"; problems: UnresolvedExcerpt[] } // a unit id or excerpt could not be resolved exactly
  | { kind: "verification_failed"; violations: Violation[] }; // assembled, but verifyEvidence rejected it

export type AssemblyResult = { ok: true; items: EvidenceItem[] } | { ok: false; failure: AssemblyFailure };

// Only what assembly and verification read. Loose objects: platform bags etc. are ignored.
const author = z.object({ handle: z.string().min(1), kind: z.enum(["user", "bot", "other"]) }).nullable();
const sourceSchema = z.object({
  platform: z.string().min(1), id: z.string().min(1), url: z.url(), title: z.string(), body: z.string().nullable(), author,
  comments: z.array(z.object({ id: z.string().min(1), url: z.url(), body: z.string(), author })),
});

/** Overlapping occurrences count, so "aa" in "aaa" is ambiguous. */
function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

export function assembleEvidence(source: NormalizedSource, drafts: unknown): AssemblyResult {
  const src = sourceSchema.safeParse(source);
  if (!src.success) return { ok: false, failure: { kind: "invalid_source", message: z.prettifyError(src.error) } };
  const parsed = z.array(evidenceDraftSchema).safeParse(drafts);
  if (!parsed.success) return { ok: false, failure: { kind: "invalid_drafts", message: z.prettifyError(parsed.error) } };

  const units = new Map(textUnits(source).map((u) => [locationKey(u.location), u]));
  const problems: UnresolvedExcerpt[] = [];
  const items: EvidenceItem[] = [];

  parsed.data.forEach((draft, di) => {
    let ok = true;
    const resolve = (e: { unitId: string; text: string }, where: string): TextUnit | null => {
      const unit = units.get(e.unitId);
      const fail = (code: UnresolvedExcerpt["code"], message: string) => { ok = false; problems.push({ draft: di, where, code, message }); return null; };
      if (!unit) return fail("unit_not_found", `no unit "${e.unitId}" in source`);
      const n = count(unit.text, e.text);
      if (n === 0) return fail("excerpt_not_found", `text is not an exact substring of ${e.unitId}`);
      if (n > 1) return fail("excerpt_ambiguous", `text occurs ${n} times in ${e.unitId}; use a longer excerpt that occurs once`);
      return unit;
    };

    const support = draft.support.map((e, i) => ({ e, unit: resolve(e, `support[${i}]`) }));
    const context = draft.context.map((e, i) => ({ e, unit: resolve(e, `context[${i}]`) }));
    if (!ok) return;

    const passages: Passage[] = support.map(({ e, unit }) => ({ location: unit!.location, text: e.text, url: unit!.url }));
    const ctx: ContextPassage[] = context.map(({ e, unit }) => ({ location: unit!.location, text: e.text, url: unit!.url, unitAuthor: unit!.author }));
    const base = {
      kind: draft.kind,
      source: { platform: source.platform, id: source.id, url: source.url },
      speaker: support[0]!.unit!.author, // the speaker is whoever wrote the first support unit; the verifier checks the rest match
      support: passages, context: ctx, claim: draft.claim, subject: draft.subject,
    };
    items.push({ ...base, id: evidenceId(base) });
  });

  if (problems.length > 0) return { ok: false, failure: { kind: "unresolved", problems } };
  const verified = verifyEvidence(source, items);
  if (!verified.ok) return { ok: false, failure: { kind: "verification_failed", violations: verified.violations } };
  return { ok: true, items };
}
