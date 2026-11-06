# research

An independent Git repository (own history, own package). It has no dependency on, and no imports from, `nexus/`, `mesh/`, `port/` or `valance/`; it merely sits next to them in the `@Valance` namespace folder.

Independently testable tools for investigating developer problems. This package currently contains **one tool: GitHub discovery** (plus the shared contract it speaks).

Discovery only *locates* public issues / pull requests and returns references. It does not fetch bodies or comments, extract problems, classify, summarize, persist, or schedule.

## Configure

```sh
pnpm install
export GITHUB_TOKEN=...   # any token that can read public repos; never commit it
```

Without a token, discovery returns an `auth` failure and makes no request.

## Invoke

```ts
import { discoverGithub } from "./src/index.js";

const result = await discoverGithub({
  text: "hydration mismatch",
  repo: "withastro/astro",                       // optional, owner/name
  createdBetween: { from: "2026-01-01" },        // optional, inclusive, YYYY-MM-DD
  limit: 50,                                     // 1..1000
});

if (result.ok) {
  result.refs;        // complete: de-duplicated, ≤ limit; [] means the search matched nothing
  result.totalMatches; result.rateLimit;
  result.sourceIncomplete; // GitHub says its own search timed out (not about our paging)
} else {
  result.failure.kind; // auth | rate_limited | invalid_query | network | service | unexpected_response
  result.partial;      // only if paging was interrupted: valid refs so far, NOT the full answer
}
```

`ok: true` always means retrieval finished — **not** that you have every matching record. Interrupted paging is `ok: false` with `partial` set, so partial data can never be mistaken for a complete result. Discovery does not retry or resume; re-run the query if you want the rest. Scope: issues and pull requests only.

The contract lives in [`src/contracts/discovery.ts`](src/contracts/discovery.ts) and is documented inline. `discoverGithub(query, { token?, fetch? })` — both options default to `process.env.GITHUB_TOKEN` and global `fetch`.

Rate limits are **reported, not waited out**: a `rate_limited` failure carries `retryAfterSeconds` / `resetAt`, and successes carry the remaining quota. Retrying is the caller's decision.

## What "successful" does and doesn't mean

Three separate limits apply; don't conflate them.

| Signal | Where | Meaning |
|---|---|---|
| **`limit`** | your input | We stop after this many refs. If `totalMatches > refs.length`, GitHub reports more matches than you asked for. |
| **1,000-result ceiling** | GitHub Search API | Only the first 1,000 hits of any query are ever served, even if `totalMatches` is 40,000. `limit: 1000` cannot reach hit 1,001. To cover more, split the query (e.g. several `createdBetween` windows) and run each. |
| **`sourceIncomplete`** | result | GitHub's own `incomplete_results`: its search timed out and may have skipped matches *within* what it returned. Says nothing about our paging. |

Interrupted paging is a fourth, different case: it's `ok: false` + `partial`, never `ok: true`.

To check you saw everything the query matches: `totalMatches <= 1000 && refs.length === totalMatches && !sourceIncomplete`. Otherwise treat the result as a sample. Discovery does not set a "complete" flag, because that answer is derived from these fields.

## Layout

| File | Responsibility |
|---|---|
| `src/contracts/discovery.ts` | Shared query / ref / failure / result types |
| `src/github/transport.ts` | One authenticated GET → JSON or explicit failure (HTTP status mapping, rate-limit headers) |
| `src/github/parse.ts` | Zod validation + normalization of a search page (pure) |
| `src/github/discover.ts` | Query validation, paging, de-dup, limit |

## Test

```sh
pnpm typecheck
pnpm test          # deterministic; no network
GITHUB_TOKEN=... pnpm test:live   # opt-in, read-only: auth, paging past 100, date window, bad-token; skips without a token
```
