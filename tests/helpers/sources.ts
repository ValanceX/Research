// Shared test inputs. REAL = existing fixtures through real retrieval + normalization (no network).
// Everything built with `cm`/`variant` is HYPOTHETICAL: invented test input, not a research finding.
import { readFileSync } from "node:fs";
import { normalizeGithubSource, retrieveGithubSource, type DiscoveryRef, type NormalizedComment, type NormalizedSource } from "../../src/index.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), "utf8"));
const [issue, comments] = [load("issue"), load("comments")];

const retrieved = await retrieveGithubSource(
  { source: "github", type: "issue", repo: "angular/angular", id: "I_kwDOAAAA1", number: 101 } as DiscoveryRef,
  { token: "t", fetch: (async (u: string | URL | Request) => new Response(JSON.stringify(String(u).includes("/comments") ? comments : issue))) as typeof fetch },
);
const n = normalizeGithubSource(retrieved);
if (!n.ok) throw new Error("fixture normalization failed");

/** Real: issue 101 by octocat; comment 10 by alice (user); comment 11 by dependabot[bot]. */
export const REAL: NormalizedSource = n.source;
export const C10 = REAL.comments[0]!.id;
export const C11 = REAL.comments[1]!.id;

/** Hypothetical comment. */
export const cm = (id: string, handle: string, body: string, kind: "user" | "bot" = "user"): NormalizedComment => ({
  id, url: `${REAL.url}#issuecomment-${id}`, body, createdAt: "2026-03-05T00:00:00Z", updatedAt: "2026-03-05T00:00:00Z",
  author: { handle, kind, github: { id: 1, type: kind === "bot" ? "Bot" : "User" } }, github: { databaseId: 1, authorAssociation: "NONE" },
});
/** Real issue title/body with hypothetical comments. */
export const variant = (...cs: NormalizedComment[]): NormalizedSource => ({ ...REAL, comments: cs });
