/**
 * Text units of a NormalizedSource (the places evidence can come from) and the
 * limited Markdown quote rule. Reads only platform-independent fields.
 */
import type { Location, Person } from "../contracts/evidence.js";
import type { NormalizedSource } from "../contracts/normalized.js";

export interface TextUnit {
  location: Location;
  text: string;
  /** Permalink to this unit (the thread url for title and body). */
  url: string;
  author: Person;
  /**
   * Which single human author wrote this. Title and body share the slot "thread" (same author);
   * each comment has its own. Lets us tell "one deleted account" from "two".
   */
  slot: string;
}

export function locationKey(l: Location): string {
  return l.unit === "comment" ? `comment:${l.commentId}` : l.unit;
}

const person = (a: { handle: string; kind: "user" | "bot" | "other" } | null): Person => (a === null ? null : { handle: a.handle, kind: a.kind });

/** Title, body (if any), then comments in source order. */
export function textUnits(source: NormalizedSource): TextUnit[] {
  const author = person(source.author);
  const units: TextUnit[] = [{ location: { unit: "title" }, text: source.title, url: source.url, author, slot: "thread" }];
  if (source.body !== null) units.push({ location: { unit: "body" }, text: source.body, url: source.url, author, slot: "thread" });
  for (const c of source.comments) {
    units.push({ location: { unit: "comment", commentId: c.id }, text: c.body, url: c.url, author: person(c.author), slot: `comment:${c.id}` });
  }
  return units;
}

/**
 * [start, end) offsets of lines that start with a Markdown blockquote marker (`>`, after up to
 * 3 spaces). LIMITED on purpose: it does not model lazy continuation, code fences, quotation
 * marks, "as X said", or text pasted without markup. It cannot claim to find all quoted material.
 */
export function quotedLineRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  for (const m of [...text.matchAll(/\r\n|\n|\r/g), null]) {
    const end = m ? m.index : text.length;
    if (/^ {0,3}>/.test(text.slice(pos, end))) ranges.push([pos, end]);
    pos = m ? m.index + m[0].length : end;
  }
  return ranges;
}
