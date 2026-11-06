/**
 * Discovery contract: the shared input/output shapes for any tool that
 * *finds references* to public developer discussions.
 *
 * Discovery only locates things. It never fetches bodies/comments, extracts
 * problems, classifies, or summarizes — those belong to later tools, which
 * will consume `DiscoveryRef`.
 */

/** What to search for. */
export interface DiscoveryQuery {
  /** Free-text search. Source-native qualifiers (e.g. `label:bug`) pass through. */
  text: string;
  /** Optional scope, `owner/name`. Omit to search all of GitHub. */
  repo?: string;
  /** Optional inclusive range on creation date, ISO `YYYY-MM-DD`. */
  createdBetween?: { from?: string; to?: string };
  /** Max references to return. Integer, 1..1000 (GitHub search never exposes more). */
  limit: number;
}

/** Only what GitHub's issue search returns. Add members when a tool actually produces them. */
export type SourceType = "issue" | "pull_request";

/** A pointer to one public discussion item, traceable to its origin. */
export interface DiscoveryRef {
  /** Stable, globally unique id (GitHub GraphQL node id). Used for de-duplication. */
  id: string;
  source: "github";
  type: SourceType;
  title: string;
  url: string;
  /** `owner/name` */
  repo: string;
  /** Issue/PR/discussion number within the repo. */
  number: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  /** Cheap listing-level signals only; never body text. */
  meta: {
    state: string;
    commentCount: number;
    labels: string[];
    /** Search relevance score reported by the source. */
    score: number;
  };
}

export interface RateLimitInfo {
  /** Requests left in the current window, if the source reported it. */
  remaining?: number;
  /** When the window resets, ISO 8601. */
  resetAt?: string;
}

/** Every way discovery can fail. `zero results` is NOT a failure — see below. */
export type DiscoveryFailure =
  | { kind: "auth"; message: string } // missing/invalid/insufficient token
  | { kind: "rate_limited"; message: string; retryAfterSeconds?: number; resetAt?: string }
  | { kind: "invalid_query"; message: string } // rejected locally or by the API
  | { kind: "network"; message: string } // no HTTP response at all
  | { kind: "service"; message: string; status: number } // 5xx from the API
  | { kind: "unexpected_response"; message: string }; // response didn't match what we validate

/**
 * How to read a result (check `ok` first):
 *
 * | `ok`    | `refs` / `partial`  | meaning                                              |
 * |---------|---------------------|------------------------------------------------------|
 * | `true`  | `refs` non-empty    | complete retrieval: every page needed was fetched    |
 * | `true`  | `refs` empty        | search succeeded, zero matches                       |
 * | `false` | no `partial`        | failed, nothing retrieved                            |
 * | `false` | `partial` non-empty | failed mid-pagination; `partial` are valid but INCOMPLETE |
 *
 * `ok: true` always means retrieval was complete. Partial data is never returned
 * under `ok: true`; callers must opt in to it by reading `partial` on a failure.
 */
export type DiscoveryResult =
  | {
      ok: true;
      /** De-duplicated, at most `query.limit`. Empty array = successful search, no matches. */
      refs: DiscoveryRef[];
      /** Total matches the source claims exist (may exceed refs.length). */
      totalMatches: number;
      /**
       * GitHub's own `incomplete_results` flag: its search timed out server-side, so
       * the matches may be missing items. This is about the SOURCE's index, not our
       * retrieval — retrieval was still complete. Retrying later may yield more.
       */
      sourceIncomplete: boolean;
      rateLimit: RateLimitInfo;
    }
  | {
      ok: false;
      failure: DiscoveryFailure;
      /**
       * Present only when at least one page was fetched and validated before the
       * failure. Never empty. Valid, de-duplicated refs, but NOT the full answer:
       * retrieval was interrupted and the query was not finished.
       */
      partial?: DiscoveryRef[];
    };
