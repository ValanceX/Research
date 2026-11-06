/**
 * GitHub source retrieval: given a `DiscoveryRef`, fetch the issue or pull request
 * and all of its ordinary conversation comments. Returns a `RetrievalResult`;
 * never throws for expected failure modes. See contracts/retrieval.ts for semantics.
 *
 * Endpoints: issue → GET /repos/{r}/issues/{n}; pull request → GET /repos/{r}/pulls/{n};
 * comments (both) → GET /repos/{r}/issues/{n}/comments, 100 per page.
 */
import { z } from "zod";
import type { DiscoveryFailure, DiscoveryRef } from "../contracts/discovery.js";
import type { GithubComment, RetrievalFailure, RetrievalResult } from "../contracts/retrieval.js";
import { parseComments, parseSource } from "./parse-source.js";
import { githubGet, type FetchLike, type TransportResult } from "./transport.js";

const API = "https://api.github.com/repos";
const PER_PAGE = 100; // GitHub's cap

// Only what retrieval needs; validated at runtime because refs may come from JSON.
const refSchema = z.object({
  id: z.string().min(1),
  source: z.literal("github"),
  type: z.enum(["issue", "pull_request"]),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  number: z.number().int().positive(),
});

export interface RetrieveOptions {
  /** Defaults to `process.env.GITHUB_TOKEN`. */
  token?: string | undefined;
  /** Defaults to global `fetch`. Injectable for tests. */
  fetch?: FetchLike;
}

export async function retrieveGithubSource(
  reference: DiscoveryRef,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const valid = refSchema.safeParse(reference);
  if (!valid.success) {
    return { ok: false, failure: { kind: "invalid_reference", message: z.prettifyError(valid.error) } };
  }
  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (!token) return { ok: false, failure: { kind: "auth", message: "no GitHub token: set GITHUB_TOKEN" } };
  const doFetch = options.fetch ?? fetch;
  const { id, type, repo, number } = valid.data;
  const base = `${API}/${repo}`;

  // 1. The source itself. Any failure here means nothing usable was retrieved.
  const srcRes = await githubGet(`${base}/${type === "issue" ? "issues" : "pulls"}/${number}`, token, doFetch);
  if (!srcRes.ok) return { ok: false, failure: toFailure(srcRes) };
  const parsed = parseSource(srcRes.json, type, repo);
  if (!parsed.ok) return { ok: false, failure: { kind: "unexpected_response", message: parsed.message } };
  const source = parsed.value;
  if (source.id !== id) {
    return { ok: false, failure: { kind: "unexpected_response", message: `retrieved id ${source.id} does not match reference id ${id}` } };
  }

  // 2. Comments, page by page. From here on, failures keep what we already hold.
  const byId = new Map<string, GithubComment>();
  const sorted = () => [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.databaseId - b.databaseId);
  let rateLimit = srcRes.rateLimit;

  for (let page = 1; ; page++) {
    const res = await githubGet(`${base}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`, token, doFetch);
    if (!res.ok) return { ok: false, failure: toFailure(res), partial: { source, comments: sorted() } };
    const comments = parseComments(res.json);
    if (!comments.ok) {
      return { ok: false, failure: { kind: "unexpected_response", message: comments.message }, partial: { source, comments: sorted() } };
    }
    rateLimit = res.rateLimit;
    // Comments added/deleted mid-paging can shift pages, so de-dupe by stable id.
    for (const c of comments.value) if (!byId.has(c.id)) byId.set(c.id, c);
    if (comments.value.length < PER_PAGE) break; // short page = last page
  }
  return { ok: true, source, comments: sorted(), rateLimit };
}

/** Transport collapses 404 into `invalid_query` and 403 into `auth`; split them back out by status. */
function toFailure(res: Extract<TransportResult, { ok: false }>): RetrievalFailure {
  const f: DiscoveryFailure = res.failure;
  if (f.kind === "auth") return res.status === 403 ? { kind: "forbidden", message: f.message } : f;
  if (f.kind === "invalid_query") {
    return res.status === 404 || res.status === 410
      ? { kind: "not_found", message: f.message }
      : { kind: "unexpected_response", message: f.message }; // 400/422 etc. aren't meaningful for a ref we built
  }
  return f;
}
