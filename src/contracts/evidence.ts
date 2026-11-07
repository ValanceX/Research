/**
 * Evidence contract: the shape of one extracted evidence item and its Zod schema.
 *
 * An item is ONE speaker's statement: verbatim `support` passages (all by `speaker`),
 * optional `context` passages (any speaker), a `claim` restating only what the support
 * explicitly says, and a `kind` / `subject` label. There is deliberately no field for
 * interpretation: that belongs to later stages. Objects are strict, so unknown fields
 * (a smuggled "interpretation", say) are rejected, not silently dropped.
 *
 * Platform-independent: it uses only what `NormalizedSource` exposes outside its
 * `github` bags. Items are checked against their source by `verifyEvidence`.
 */
import { z } from "zod";
import type { NormalizedSource } from "./normalized.js";

/** Same as a normalized author minus platform bag. `null` = unavailable (e.g. deleted account). */
export const personSchema = z.strictObject({ handle: z.string().min(1), kind: z.enum(["user", "bot", "other"]) }).nullable();
export type Person = z.infer<typeof personSchema>;

/** Which text unit of the source a passage comes from. */
export const locationSchema = z.discriminatedUnion("unit", [
  z.strictObject({ unit: z.literal("title") }),
  z.strictObject({ unit: z.literal("body") }),
  z.strictObject({ unit: z.literal("comment"), commentId: z.string().min(1) }),
]);
export type Location = z.infer<typeof locationSchema>;

/** `text` is an EXACT substring of that unit's text: no trimming, ellipsis or edits. `url` is the unit's permalink. */
export const passageSchema = z.strictObject({ location: locationSchema, text: z.string().min(1), url: z.url() });
export type Passage = z.infer<typeof passageSchema>;

/**
 * Context also records `unitAuthor`: the author of the source UNIT containing the passage. It is NOT
 * necessarily who wrote the passage itself (e.g. quoted text inside a reply was written by someone else).
 */
export const contextPassageSchema = passageSchema.extend({ unitAuthor: personSchema });
export type ContextPassage = z.infer<typeof contextPassageSchema>;

export const evidenceKinds = ["problem", "workaround", "desired_outcome", "solution_request", "positive_experience", "resolution"] as const;

export const evidenceItemSchema = z.strictObject({
  /** Derived by `evidenceId`; verified, never trusted. */
  id: z.string().regex(/^ev1:[0-9a-f]{64}$/),
  /** What kind of statement this is. `resolution` = an explicit statement that something was fixed/resolved. */
  kind: z.enum(evidenceKinds),
  /** Copied from the NormalizedSource it was extracted from. */
  source: z.strictObject({ platform: z.string().min(1), id: z.string().min(1), url: z.url() }),
  /** Who made the statement ("reported by"). Every support passage must belong to this speaker. */
  speaker: personSchema,
  /** Establishes the claim. All by `speaker`; must not rest on quoted (`>`) text alone. */
  support: z.array(passageSchema).min(1),
  /** Needed to read the support (referents, repro steps). Any speaker. May be empty. */
  context: z.array(contextPassageSchema),
  /** Only what the support explicitly says; hedges kept; no generalizing. Not machine-verifiable. */
  claim: z.string().min(1),
  /** Whose experience/need/workaround the statement is about, AS STATED. Never assume the speaker. */
  subject: z.enum(["speaker", "speaker_and_others", "others", "unattributed"]),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

// Compile-time tie to the frozen contract: breaks the build if NormalizedSource.platform stops being a string.
type PlatformIsString = NormalizedSource["platform"] extends string ? true : never;
const platformIsString: PlatformIsString = true;
void platformIsString;
