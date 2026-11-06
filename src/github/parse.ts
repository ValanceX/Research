/**
 * GitHub-specific response parsing: validates the `GET /search/issues` payload
 * with Zod and normalizes items into `DiscoveryRef`. Pure; no I/O.
 *
 * Only fields we actually emit are required. A malformed item fails the whole
 * page (`unexpected_response`) rather than yielding a half-filled record.
 */
import { z } from "zod";
import type { DiscoveryRef } from "../contracts/discovery.js";

const itemSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int(),
  title: z.string(),
  html_url: z.url(),
  repository_url: z.url(), // https://api.github.com/repos/{owner}/{name}
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  state: z.string(),
  comments: z.number().int().nonnegative(),
  score: z.number(),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.unknown().optional(), // present only on pull requests
});

const searchPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(itemSchema),
});

export type ParsedPage =
  | { ok: true; refs: DiscoveryRef[]; totalMatches: number; incomplete: boolean }
  | { ok: false; message: string };

export function parseSearchPage(json: unknown): ParsedPage {
  const parsed = searchPageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, message: `search response did not match expected shape: ${parsed.error.message}` };
  }
  const refs: DiscoveryRef[] = [];
  for (const i of parsed.data.items) {
    const repo = new URL(i.repository_url).pathname.replace(/^\/repos\//, "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      return { ok: false, message: `unrecognized repository_url: ${i.repository_url}` };
    }
    refs.push({
      id: i.node_id,
      source: "github",
      type: i.pull_request !== undefined ? "pull_request" : "issue",
      title: i.title,
      url: i.html_url,
      repo,
      number: i.number,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      meta: { state: i.state, commentCount: i.comments, labels: i.labels.map((l) => l.name), score: i.score },
    });
  }
  return { ok: true, refs, totalMatches: parsed.data.total_count, incomplete: parsed.data.incomplete_results };
}
