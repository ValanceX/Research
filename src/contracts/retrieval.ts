/**
 * Retrieval contract: input/output shapes for fetching ONE GitHub issue or pull
 * request plus its ordinary conversation comments.
 *
 * Input is a `DiscoveryRef` (from discovery) — callers never rebuild repo names,
 * numbers or types. Bodies are returned verbatim: no summarizing, rewriting,
 * classification or evidence extraction happens here.
 *
 * Deliberately excluded: PR review comments, review submissions, inline threads,
 * diffs/files, and linked resources. GitHub-specific on purpose; there is no
 * cross-platform document format.
 */
import type { DiscoveryFailure, RateLimitInfo, SourceType } from "./discovery.js";

/** Who wrote something. `null` author = account deleted/unavailable. */
export interface GithubAuthor {
  login: string;
  /** GitHub numeric user id. */
  id: number;
  /** `User`, `Bot`, `Organization`, ... as reported by GitHub. */
  type: string;
}

/** The issue or pull request itself. */
export interface GithubSource {
  /** Same id as `DiscoveryRef.id` (GitHub node id); retrieval verifies they match. */
  id: string;
  type: SourceType;
  /** `owner/name`, as given in the reference. */
  repo: string;
  number: number;
  title: string;
  /** Verbatim markdown as written. `null` when the author left it empty. */
  body: string | null;
  author: GithubAuthor | null;
  /** `open` | `closed`. */
  state: string;
  url: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  meta: {
    closedAt: string | null;
    locked: boolean;
    authorAssociation: string;
    labels: string[];
    /**
     * Conversation-comment count GitHub reported at fetch time. Informational:
     * it can differ from `comments.length` if comments change during retrieval.
     */
    commentCount: number;
    /** Present only for pull requests. */
    pullRequest?: { draft: boolean; merged: boolean; mergedAt: string | null };
  };
}

/** One ordinary conversation comment (issue-style; NOT a PR review comment). */
export interface GithubComment {
  /** Stable GitHub node id. De-duplication key. */
  id: string;
  /** GitHub numeric comment id (what the REST API and `#issuecomment-<id>` use). */
  databaseId: number;
  author: GithubAuthor | null;
  /** Verbatim markdown as written. */
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  authorAssociation: string;
}

export interface RetrievedContent {
  source: GithubSource;
  /**
   * De-duplicated and sorted oldest first (by `createdAt`, ties by `databaseId`),
   * regardless of the order GitHub returned them in.
   */
  comments: GithubComment[];
}

export type RetrievalFailure =
  /** The input was not a valid reference, or `GITHUB_TOKEN` is missing (no request made). */
  | { kind: "invalid_reference"; message: string }
  /** 404/410. GitHub also answers 404 for private repos the token can't see. */
  | { kind: "not_found"; message: string }
  /** 403 without rate limiting: valid token, not allowed to read this resource. */
  | { kind: "forbidden"; message: string }
  // Same meanings and shapes as in discovery: auth (missing/401), rate_limited,
  // network, service, unexpected_response (incl. malformed payloads and id mismatch).
  | Exclude<DiscoveryFailure, { kind: "invalid_query" }>;

/**
 * How to read a result (check `ok` first):
 *
 * | `ok`    | `partial`  | meaning                                                       |
 * |---------|------------|---------------------------------------------------------------|
 * | `true`  | n/a        | source AND every comment page retrieved and validated          |
 * | `false` | absent     | failed before the source was retrieved: nothing usable         |
 * | `false` | present    | source retrieved, comment paging then failed: `partial.comments` are valid but INCOMPLETE (possibly empty) |
 *
 * Success means: the source validated, its id matched the reference, and comment
 * paging ran until GitHub returned a short (last) page. It is a point-in-time read,
 * not an atomic snapshot: comments added or deleted while paging may be missed.
 * Partial data is never returned under `ok: true`. No retry, resume or checkpoint.
 */
export type RetrievalResult =
  | ({ ok: true; rateLimit: RateLimitInfo } & RetrievedContent)
  | { ok: false; failure: RetrievalFailure; partial?: RetrievedContent };
