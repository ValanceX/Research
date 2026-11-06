/**
 * Normalized contract: a platform-independent view of one discussion thread
 * (an issue or pull request, plus its conversation comments) for downstream tools.
 *
 * Shape rule: top-level fields mean the same thing on any platform; anything that
 * only makes sense on GitHub lives in the `github` bag at that level. Content is
 * verbatim. Unavailable information is an explicit `null`, never a made-up value.
 *
 * Not carried over: the retrieval's `rateLimit` (operational, not content).
 * Not available from retrieval, so absent: when the source was fetched, author
 * profile URLs, reactions, edit history, PR review comments and diffs.
 */

export interface NormalizedAuthor {
  /** Login/handle as shown on the platform. */
  handle: string;
  /** `bot` matters downstream (automated comments are not human experience). `other` = organization, mannequin, etc. */
  kind: "user" | "bot" | "other";
  github: { id: number; /** Raw GitHub account type, e.g. `User`, `Bot`, `Organization`. */ type: string };
}

export interface NormalizedComment {
  /** Stable global id (GitHub node id). */
  id: string;
  /** Permalink to this comment. */
  url: string;
  /** `null` = account deleted/unavailable. */
  author: NormalizedAuthor | null;
  /** Verbatim markdown. */
  body: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  github: {
    /** Numeric id (the `#issuecomment-<id>` in `url`). */
    databaseId: number;
    /** `OWNER` | `MEMBER` | `COLLABORATOR` | `CONTRIBUTOR` | `NONE` | ... relation to the repository. */
    authorAssociation: string;
  };
}

export interface NormalizedSource {
  /** Where this came from. Only `github` exists; a union is added with a second platform, not before. */
  platform: "github";
  /** Stable global id (GitHub node id): the key for provenance and de-duplication. */
  id: string;
  /** The distinction survives normalization. */
  kind: "issue" | "pull_request";
  /** Permalink to the thread. */
  url: string;
  /** Where the thread lives (`owner/name`). */
  container: string;
  title: string;
  /** Verbatim markdown; `null` when the author left it empty. */
  body: string | null;
  /** `null` = account deleted/unavailable. */
  author: NormalizedAuthor | null;
  /** `merged` only for pull requests (a merged PR is also closed; see `closedAt`). */
  state: "open" | "closed" | "merged";
  createdAt: string;
  updatedAt: string;
  /** Close (or merge) time; `null` while open. */
  closedAt: string | null;
  labels: string[];
  /** Conversation comments in the order retrieval delivered them (oldest first). Never PR review comments. */
  comments: NormalizedComment[];
  github: {
    /** Issue/PR number within the repo. */
    number: number;
    locked: boolean;
    authorAssociation: string;
    /** GitHub's comment count at fetch time; may differ from `comments.length`. */
    commentCount: number;
    /** Present only when `kind` is `pull_request`. */
    pullRequest?: { draft: boolean; mergedAt: string | null };
  };
}

export type NormalizationFailure =
  /** The retrieval did not succeed. Failed and partial retrievals are never normalized. */
  | { kind: "retrieval_failed"; message: string }
  /** The input is not a well-formed successful retrieval result. */
  | { kind: "invalid_input"; message: string };

export type NormalizationResult =
  | { ok: true; source: NormalizedSource }
  | { ok: false; failure: NormalizationFailure };
