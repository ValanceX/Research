/**
 * Verifies evidence items against the NormalizedSource they claim to come from.
 * Pure and deterministic. It checks structure and traceability only; it cannot judge whether
 * a claim is faithful, a kind is right, `subject` is right, or quoted text outside `>` lines.
 */
import { z } from "zod";
import { evidenceItemSchema, type Person } from "../contracts/evidence.js";
import type { NormalizedSource } from "../contracts/normalized.js";
import { evidenceId } from "./id.js";
import { locationKey, quotedLineRanges, textUnits } from "./units.js";

export type ViolationCode =
  | "schema" // not a well-formed item (incl. unknown fields)
  | "source_mismatch" // platform / id / url differ from the source
  | "location_missing" // no such title/body/comment in the source
  | "text_not_found" // passage text is not an exact substring of its unit
  | "url_mismatch" // passage url is not the unit's permalink
  | "speaker_mismatch" // a support passage's unit author is not `speaker`
  | "null_speaker_multi_slot" // speaker is null but support spans more than one author slot
  | "bot_speaker" // speaker is a bot
  | "quote_only_support" // every occurrence of a support passage touches a `>` line
  | "context_author_mismatch" // context.author differs from the unit's author
  | "id_mismatch" // id is not the derived id
  | "duplicate_id"; // same id earlier in this batch

export interface Violation {
  /** Position in the input array. */
  index: number;
  /** The item's claimed id when readable, else null. */
  itemId: string | null;
  code: ViolationCode;
  message: string;
}
export interface VerificationResult {
  ok: boolean;
  violations: Violation[];
}

const samePerson = (a: Person, b: Person) => (a === null || b === null ? a === b : a.handle === b.handle && a.kind === b.kind);

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export function verifyEvidence(source: NormalizedSource, items: readonly unknown[]): VerificationResult {
  const units = new Map(textUnits(source).map((u) => [locationKey(u.location), u]));
  const quoted = new Map(textUnits(source).map((u) => [locationKey(u.location), quotedLineRanges(u.text)]));
  const violations: Violation[] = [];
  const seen = new Set<string>();

  items.forEach((raw, index) => {
    const parsed = evidenceItemSchema.safeParse(raw);
    const claimedId = parsed.success ? parsed.data.id : typeof (raw as { id?: unknown } | null)?.id === "string" ? (raw as { id: string }).id : null;
    const add = (code: ViolationCode, message: string) => violations.push({ index, itemId: claimedId, code, message });
    if (!parsed.success) return add("schema", z.prettifyError(parsed.error));
    const it = parsed.data;

    for (const k of ["platform", "id", "url"] as const) {
      if (it.source[k] !== source[k]) add("source_mismatch", `source.${k} is ${JSON.stringify(it.source[k])}, source has ${JSON.stringify(source[k])}`);
    }
    if (it.speaker?.kind === "bot") add("bot_speaker", `speaker ${it.speaker.handle} is a bot`);

    /** Shared checks: unit exists, url matches, text is an exact substring. */
    const locate = (p: { location: Parameters<typeof locationKey>[0]; text: string; url: string }, label: string) => {
      const key = locationKey(p.location);
      const unit = units.get(key);
      if (!unit) return add("location_missing", `${label}: no unit ${key} in source`), null;
      if (p.url !== unit.url) add("url_mismatch", `${label}: url ${p.url} is not the permalink ${unit.url}`);
      const at = occurrences(unit.text, p.text);
      if (at.length === 0) add("text_not_found", `${label}: text is not an exact substring of ${key}`);
      return { unit, key, at };
    };

    const slots = new Set<string>();
    it.support.forEach((p, i) => {
      const found = locate(p, `support[${i}]`);
      if (!found) return;
      slots.add(found.unit.slot);
      if (!samePerson(found.unit.author, it.speaker)) add("speaker_mismatch", `support[${i}] is by ${JSON.stringify(found.unit.author)}, not speaker ${JSON.stringify(it.speaker)}`);
      if (found.at.length > 0) {
        const ranges = quoted.get(found.key) ?? [];
        // An occurrence is quote-free if it overlaps no `>` line. One quote-free occurrence is enough
        // (the occurrence meant is not identifiable without offsets; see README).
        const free = found.at.some((s) => ranges.every(([a, b]) => !(s < b && s + p.text.length > a)));
        if (!free) add("quote_only_support", `support[${i}] occurs only inside or across \`>\` quoted lines of ${found.key}`);
      }
    });
    if (it.speaker === null && slots.size > 1) add("null_speaker_multi_slot", "speaker is null, so support must come from a single author slot");

    it.context.forEach((p, i) => {
      const found = locate(p, `context[${i}]`);
      if (found && !samePerson(found.unit.author, p.author)) add("context_author_mismatch", `context[${i}].author is ${JSON.stringify(p.author)}, unit author is ${JSON.stringify(found.unit.author)}`);
    });

    if (it.id !== evidenceId(it)) add("id_mismatch", `id ${it.id} is not the derived id`);
    if (seen.has(it.id)) add("duplicate_id", `id ${it.id} already appears earlier in this batch`);
    seen.add(it.id);
  });

  return { ok: violations.length === 0, violations };
}
