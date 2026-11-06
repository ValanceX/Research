/**
 * GitHub discovery: validates the query, pages through `GET /search/issues`,
 * de-duplicates, and honors the limit. Returns a `DiscoveryResult`; never throws
 * for expected failure modes.
 *
 * Covers issues and pull requests. Discussions need GitHub's GraphQL API and are
 * not implemented yet (see README, "Known limitations").
 */
import { z } from "zod";
import type { DiscoveryFailure, DiscoveryQuery, DiscoveryRef, DiscoveryResult, RateLimitInfo } from "../contracts/discovery.js";
import { parseSearchPage } from "./parse.js";
import { githubGet, type FetchLike } from "./transport.js";

const PER_PAGE_MAX = 100; // GitHub's cap
const API = "https://api.github.com/search/issues";

const date = z.iso.date();
const querySchema = z.object({
  text: z.string().trim().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name").optional(),
  createdBetween: z.object({ from: date.optional(), to: date.optional() }).optional(),
  limit: z.number().int().min(1).max(1000),
});

export interface DiscoverOptions {
  /** Defaults to `process.env.GITHUB_TOKEN`. */
  token?: string | undefined;
  /** Defaults to global `fetch`. Injectable for tests. */
  fetch?: FetchLike;
}

export async function discoverGithub(
  query: DiscoveryQuery,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const valid = querySchema.safeParse(query);
  if (!valid.success) {
    return { ok: false, failure: { kind: "invalid_query", message: z.prettifyError(valid.error) } };
  }
  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    return { ok: false, failure: { kind: "auth", message: "no GitHub token: set GITHUB_TOKEN" } };
  }
  const doFetch = options.fetch ?? fetch;

  const q = buildQ(valid.data);
  const { limit } = valid.data;
  const perPage = Math.min(limit, PER_PAGE_MAX);
  const lastPage = Math.ceil(1000 / perPage); // search exposes only the first 1000 hits

  const seen = new Map<string, DiscoveryRef>();
  let totalMatches = 0;
  let sourceIncomplete = false;
  let rateLimit: RateLimitInfo = {};

  for (let page = 1; page <= lastPage && seen.size < limit; page++) {
    const params = new URLSearchParams({ q, per_page: String(perPage), page: String(page), sort: "created", order: "desc" });
    const res = await githubGet(`${API}?${params}`, token, doFetch);
    // A failure after earlier pages succeeded carries what we already have (never as ok:true).
    const interrupted = (failure: DiscoveryFailure): DiscoveryResult =>
      seen.size > 0 ? { ok: false, failure, partial: [...seen.values()].slice(0, limit) } : { ok: false, failure };
    if (!res.ok) return interrupted(res.failure);

    const parsed = parseSearchPage(res.json);
    if (!parsed.ok) return interrupted({ kind: "unexpected_response", message: parsed.message });

    rateLimit = res.rateLimit;
    totalMatches = parsed.totalMatches;
    sourceIncomplete ||= parsed.incomplete;
    // Pages can overlap when results shift mid-pagination, so de-dupe by stable id.
    for (const ref of parsed.refs) if (!seen.has(ref.id)) seen.set(ref.id, ref);
    if (parsed.refs.length < perPage) break; // short page = last page
  }

  return { ok: true, refs: [...seen.values()].slice(0, limit), totalMatches, sourceIncomplete, rateLimit };
}

function buildQ(q: z.infer<typeof querySchema>): string {
  const parts = [q.text];
  if (q.repo) parts.push(`repo:${q.repo}`);
  const { from, to } = q.createdBetween ?? {};
  if (from || to) parts.push(`created:${from ?? "*"}..${to ?? "*"}`);
  return parts.join(" ");
}
