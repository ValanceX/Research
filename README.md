# research

An independent Git repository (own history, own package). It has no dependency on, and no imports from, `nexus/`, `mesh/`, `port/` or `valance/`; it merely sits next to them in the `@Valance` namespace folder.

Independently testable tools for investigating developer problems. This package currently contains **two tools**, each usable on its own: **GitHub discovery** (find references) and **GitHub source retrieval** (fetch one referenced issue/PR and its conversation comments).

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

## Retrieve a source

```ts
import { discoverGithub, retrieveGithubSource } from "./src/index.js";

const found = await discoverGithub({ text: "hydration", repo: "withastro/astro", limit: 5 });
if (found.ok && found.refs[0]) {
  const r = await retrieveGithubSource(found.refs[0]);   // takes a DiscoveryRef as-is
  if (r.ok) {
    r.source;    // id, type, repo, number, title, body (verbatim, or null), author, state, url, timestamps, meta
    r.comments;  // conversation comments, oldest first, de-duplicated: id, databaseId, author, body, url, timestamps, authorAssociation
  } else {
    r.failure.kind; // invalid_reference | auth | forbidden | not_found | rate_limited | network | service | unexpected_response
    r.partial;      // only if the source was fetched and comment paging then failed: valid but INCOMPLETE
  }
}
```

Options: `retrieveGithubSource(ref, { token?, fetch? })`, same defaults as discovery. Reference types are validated at runtime, so refs deserialized from JSON are fine.

**Endpoints:** issue → `GET /repos/{r}/issues/{n}`; pull request → `GET /repos/{r}/pulls/{n}`; comments for both → `GET /repos/{r}/issues/{n}/comments` (100 per page, until a short page).

**What "success" means:** the source validated, its id matched the reference, and every comment page was fetched and validated. It is a point-in-time read, not an atomic snapshot: comments added or deleted during paging can be missed, and `source.meta.commentCount` is GitHub's count at fetch time, so it can differ from `comments.length`.

| `ok` | `partial` | meaning |
|---|---|---|
| `true` | n/a | complete |
| `false` | absent | failed before the source was retrieved; nothing usable |
| `false` | present | source retrieved, comment paging failed; `partial.comments` may be empty or incomplete |

`not_found` also covers private repos the token cannot see (GitHub answers 404). `forbidden` is a 403 that is not rate limiting. No retry, resume or checkpointing; re-run to get the rest.

**Not retrieved:** PR review comments, review submissions, inline threads, diffs/files, linked resources. Bodies are returned verbatim; nothing is summarized or classified.

## Normalize a retrieved source

```ts
import { retrieveGithubSource, normalizeGithubSource } from "./src/index.js";

const n = normalizeGithubSource(await retrieveGithubSource(ref)); // pure: no network, no mutation
if (n.ok) n.source;      // NormalizedSource: platform-independent, `github` bags hold GitHub-only facts
else n.failure.kind;     // retrieval_failed (incl. partial retrievals) | invalid_input
```

Only a *successful, complete* retrieval is normalized. Content is verbatim; unavailable values are explicit `null`; comment order is preserved. See `src/contracts/normalized.ts` for what each field means, what is deliberately dropped (`rateLimit`) and what retrieval never supplied (fetch time, reactions, edit history, review comments).

## Evidence contract and verifier (no extractor yet)

`src/contracts/evidence.ts` defines `EvidenceItem` (Zod, strict): one speaker's statement as verbatim `support` passages, optional `context`, a `claim`, a `kind` (`problem | workaround | desired_outcome | solution_request | positive_experience | resolution`) and a `subject` (`speaker | speaker_and_others | others | unattributed`). There is no interpretation field.

```ts
import { verifyEvidence, evidenceId } from "./src/index.js";
const { ok, violations } = verifyEvidence(normalizedSource, items); // pure; items may be untrusted
```

The verifier checks structure and traceability only: source identity, locations, exact excerpts, permalinks, single-speaker support (null speaker = one author slot), bot exclusion, `>`-quote-only support, context authors, derived ids and duplicates. Violation codes: `schema`, `source_mismatch`, `location_missing`, `text_not_found`, `url_mismatch`, `speaker_mismatch`, `null_speaker_multi_slot`, `bot_speaker`, `quote_only_support`, `context_author_mismatch`, `id_mismatch`, `duplicate_id`.

Context passages carry `unitAuthor`: the author of the *unit* containing the passage, not necessarily of quoted words inside it.

### Draft assembly

An extractor produces only `EvidenceDraft`s (`unitId` + exact `text` excerpts, `kind`, `subject`, `claim`). `assembleEvidence(source, drafts)` derives everything else (source ref, urls, speaker, `unitAuthor`, id) and runs `verifyEvidence`. It is all-or-nothing and never repairs excerpts:

```ts
const r = assembleEvidence(normalizedSource, drafts); // drafts: unknown (e.g. parsed model output)
// r.ok ? r.items (verified; [] is valid) : r.failure
```

Failures: `invalid_source`, `invalid_drafts`, `unresolved` (per excerpt: `unit_not_found`, `excerpt_not_found`, `excerpt_ambiguous` when the text occurs more than once in its unit) and `verification_failed` (the verifier's violations). Unit ids are `title`, `body`, `comment:<id>`.

It cannot judge claim fidelity, kind, `subject`, or quotes that lack a `>` marker (quote detection is deliberately limited to `>` lines). `evidenceId` = sha256 of platform, source id, kind and the sorted support set; claim, context, subject are excluded.

## Layout

| File | Responsibility |
|---|---|
| `src/contracts/discovery.ts` | Shared query / ref / failure / result types |
| `src/github/transport.ts` | One authenticated GET → JSON or explicit failure (HTTP status mapping, rate-limit headers) |
| `src/github/parse.ts` | Zod validation + normalization of a search page (pure) |
| `src/github/discover.ts` | Query validation, paging, de-dup, limit |
| `src/contracts/retrieval.ts` | Retrieval source / comment / failure / result types |
| `src/github/parse-source.ts` | Zod validation + normalization of issue, PR and comment payloads (pure) |
| `src/contracts/normalized.ts` | Platform-independent thread/comment/author types |
| `src/normalize/github.ts` | Pure retrieval-result → `NormalizedSource` (validates input, no I/O) |
| `src/contracts/evidence.ts` | Evidence item Zod schema and types |
| `src/contracts/evidence-draft.ts` | `EvidenceDraft`: what an extractor must produce |
| `src/evidence/assemble.ts` | `assembleEvidence`: drafts → verified items, all-or-nothing |
| `src/evidence/{units,id,verify}.ts` | `textUnits`/`quotedLineRanges`, `evidenceId`, `verifyEvidence` |
| `src/github/retrieve.ts` | Reference validation, endpoint choice, comment paging, de-dup, ordering, failure mapping |

## Test

```sh
pnpm typecheck
pnpm test          # deterministic; no network
GITHUB_TOKEN=... pnpm test:live   # opt-in, read-only: discovery (4 tests) + retrieval (5 tests); skips without a token
```
