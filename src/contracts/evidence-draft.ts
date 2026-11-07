/**
 * Evidence draft: the ONLY thing an extractor (model or otherwise) has to produce.
 *
 * It names where text came from (unit id) and gives exact excerpts plus the judgments
 * (kind, subject, claim). It carries no source reference, urls, author objects or ids:
 * `assembleEvidence` derives all of those deterministically from the NormalizedSource.
 *
 * A unit id is the opaque key from `locationKey(textUnits(source)[i].location)`:
 * `"title"`, `"body"`, or `"comment:<commentId>"`.
 */
import { z } from "zod";
import { evidenceKinds } from "./evidence.js";

export const draftExcerptSchema = z.strictObject({
  /** Which unit the text was copied from: "title" | "body" | "comment:<id>". */
  unitId: z.string().min(1),
  /** EXACT substring of that unit's text, occurring exactly once in it. */
  text: z.string().min(1),
});

export const evidenceDraftSchema = z.strictObject({
  kind: z.enum(evidenceKinds),
  subject: z.enum(["speaker", "speaker_and_others", "others", "unattributed"]),
  /** Establishes the claim. All excerpts must be from units written by one speaker. */
  support: z.array(draftExcerptSchema).min(1),
  /** Reading aids; may come from any unit. */
  context: z.array(draftExcerptSchema),
  claim: z.string().min(1),
});
export type EvidenceDraft = z.infer<typeof evidenceDraftSchema>;
