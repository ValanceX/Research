/**
 * Normalizes a successful GitHub retrieval into the platform-independent
 * `NormalizedSource`. Pure and deterministic: no I/O, never mutates its input, and
 * never alters content (bodies are copied verbatim, comment order is preserved).
 *
 * Depends only on the retrieval *contract*; it does not import retrieval code.
 * The input is re-validated because it may have been loaded from disk or JSON.
 */
import { z } from "zod";
import type { NormalizationResult, NormalizedAuthor } from "../contracts/normalized.js";
import type { RetrievalResult } from "../contracts/retrieval.js";

const when = z.iso.datetime();
const author = z.object({ login: z.string(), id: z.number().int(), type: z.string() }).nullable();

const successSchema = z.object({
  ok: z.literal(true),
  source: z.object({
    id: z.string().min(1),
    type: z.enum(["issue", "pull_request"]),
    repo: z.string().min(1),
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    author,
    state: z.enum(["open", "closed"]),
    url: z.url(),
    createdAt: when,
    updatedAt: when,
    meta: z.object({
      closedAt: when.nullable(),
      locked: z.boolean(),
      authorAssociation: z.string(),
      labels: z.array(z.string()),
      commentCount: z.number().int().nonnegative(),
      pullRequest: z.object({ draft: z.boolean(), merged: z.boolean(), mergedAt: when.nullable() }).optional(),
    }),
  }),
  comments: z.array(
    z.object({
      id: z.string().min(1),
      databaseId: z.number().int(),
      author,
      body: z.string(),
      createdAt: when,
      updatedAt: when,
      url: z.url(),
      authorAssociation: z.string(),
    }),
  ),
});

const toAuthor = (a: z.infer<typeof author>): NormalizedAuthor | null =>
  a === null
    ? null
    : { handle: a.login, kind: a.type === "User" ? "user" : a.type === "Bot" ? "bot" : "other", github: { id: a.id, type: a.type } };

export function normalizeGithubSource(retrieval: RetrievalResult): NormalizationResult {
  // Checked before validation so a failed (even partial) retrieval gets a precise answer.
  if (typeof retrieval === "object" && retrieval !== null && (retrieval as { ok?: unknown }).ok === false) {
    const kind = (retrieval as { failure?: { kind?: unknown } }).failure?.kind;
    return { ok: false, failure: { kind: "retrieval_failed", message: `retrieval failed${typeof kind === "string" ? ` (${kind})` : ""}; failed or partial retrievals are not normalized` } };
  }
  const parsed = successSchema.safeParse(retrieval);
  if (!parsed.success) return invalid(z.prettifyError(parsed.error));
  const { source: s, comments } = parsed.data;

  const pr = s.meta.pullRequest;
  if (s.type === "pull_request" && pr === undefined) return invalid("pull_request source is missing meta.pullRequest");
  if (s.state === "open" && pr?.merged) return invalid("pull request is open but marked merged");
  if (s.type === "issue" && pr !== undefined) return invalid("issue source must not have meta.pullRequest");

  return {
    ok: true,
    source: {
      platform: "github",
      id: s.id,
      kind: s.type,
      url: s.url,
      container: s.repo,
      title: s.title,
      body: s.body,
      author: toAuthor(s.author),
      state: s.state === "closed" && pr?.merged ? "merged" : s.state,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      closedAt: s.meta.closedAt,
      labels: s.meta.labels,
      comments: comments.map((c) => ({
        id: c.id,
        url: c.url,
        author: toAuthor(c.author),
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        github: { databaseId: c.databaseId, authorAssociation: c.authorAssociation },
      })),
      github: {
        number: s.number,
        locked: s.meta.locked,
        authorAssociation: s.meta.authorAssociation,
        commentCount: s.meta.commentCount,
        ...(pr !== undefined && { pullRequest: { draft: pr.draft, mergedAt: pr.mergedAt } }),
      },
    },
  };
}

const invalid = (message: string): NormalizationResult => ({ ok: false, failure: { kind: "invalid_input", message } });
