/**
 * Parsing for retrieval: validates GitHub issue / pull request / comment payloads
 * with Zod and normalizes them into the retrieval contract. Pure; no I/O.
 * A malformed payload (or any malformed comment in a page) fails the whole parse.
 */
import { z } from "zod";
import type { SourceType } from "../contracts/discovery.js";
import type { GithubAuthor, GithubComment, GithubSource } from "../contracts/retrieval.js";

const user = z.object({ login: z.string(), id: z.number().int(), type: z.string() }).nullable();
const when = z.iso.datetime();

const sourceSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  user,
  state: z.string(),
  html_url: z.url(),
  created_at: when,
  updated_at: when,
  closed_at: when.nullable(),
  locked: z.boolean(),
  author_association: z.string(),
  comments: z.number().int().nonnegative(),
  labels: z.array(z.object({ name: z.string() })),
});
// The pulls endpoint additionally reports these; they are required for type "pull_request".
const pullSchema = sourceSchema.extend({ draft: z.boolean(), merged: z.boolean(), merged_at: when.nullable() });

const commentSchema = z.object({
  node_id: z.string().min(1),
  id: z.number().int(),
  user,
  body: z.string(),
  created_at: when,
  updated_at: when,
  html_url: z.url(),
  author_association: z.string(),
});

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const author = (u: z.infer<typeof user>): GithubAuthor | null =>
  u === null ? null : { login: u.login, id: u.id, type: u.type };

export function parseSource(json: unknown, type: SourceType, repo: string): Parsed<GithubSource> {
  const r = (type === "pull_request" ? pullSchema : sourceSchema).safeParse(json);
  if (!r.success) return { ok: false, message: `${type} response did not match expected shape: ${r.error.message}` };
  const d = r.data as z.infer<typeof pullSchema>; // draft/merged/merged_at are only read for PRs
  return {
    ok: true,
    value: {
      id: d.node_id, type, repo, number: d.number, title: d.title, body: d.body,
      author: author(d.user), state: d.state, url: d.html_url, createdAt: d.created_at, updatedAt: d.updated_at,
      meta: {
        closedAt: d.closed_at, locked: d.locked, authorAssociation: d.author_association,
        labels: d.labels.map((l) => l.name), commentCount: d.comments,
        ...(type === "pull_request" && { pullRequest: { draft: d.draft, merged: d.merged, mergedAt: d.merged_at } }),
      },
    },
  };
}

export function parseComments(json: unknown): Parsed<GithubComment[]> {
  const r = z.array(commentSchema).safeParse(json);
  if (!r.success) return { ok: false, message: `comments response did not match expected shape: ${r.error.message}` };
  return {
    ok: true,
    value: r.data.map((c) => ({
      id: c.node_id, databaseId: c.id, author: author(c.user), body: c.body,
      createdAt: c.created_at, updatedAt: c.updated_at, url: c.html_url, authorAssociation: c.author_association,
    })),
  };
}
