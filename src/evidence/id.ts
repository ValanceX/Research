import { createHash } from "node:crypto";
import type { EvidenceItem } from "../contracts/evidence.js";
import { locationKey } from "./units.js";

/**
 * Stable identity of an evidence item: sha256 over platform, source id, kind and the SET of
 * support passages (location + exact text, sorted). Claim, context, subject and speaker are
 * excluded so revising wording or judgments does not fork the item; changing the kind, the
 * support text/boundaries, or the source does. Pure: no storage.
 */
export function evidenceId(item: Pick<EvidenceItem, "source" | "kind" | "support">): string {
  const support = [...new Set(item.support.map((p) => JSON.stringify([locationKey(p.location), p.text])))].sort(); // code-unit order, locale-independent
  const canonical = JSON.stringify([item.source.platform, item.source.id, item.kind, support]);
  return `ev1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
