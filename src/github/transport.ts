/**
 * GitHub HTTP transport: one authenticated GET, mapped to either parsed JSON
 * or an explicit `DiscoveryFailure`. Knows nothing about search semantics or
 * response shapes — that is parse.ts's job.
 */
import type { DiscoveryFailure, RateLimitInfo } from "../contracts/discovery.js";

export type FetchLike = typeof fetch;

export type TransportResult =
  | { ok: true; json: unknown; rateLimit: RateLimitInfo }
  // `status` is set when GitHub answered with an HTTP error (absent for network/parse failures).
  | { ok: false; failure: DiscoveryFailure; status?: number };

function readRateLimit(h: Headers): RateLimitInfo {
  const remaining = h.get("x-ratelimit-remaining");
  const reset = h.get("x-ratelimit-reset"); // epoch seconds
  return {
    ...(remaining !== null && !Number.isNaN(Number(remaining)) && { remaining: Number(remaining) }),
    ...(reset !== null && !Number.isNaN(Number(reset)) && {
      resetAt: new Date(Number(reset) * 1000).toISOString(),
    }),
  };
}

export async function githubGet(
  url: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<TransportResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "valancex-research-discovery",
      },
    });
  } catch (e) {
    // Message only — never echo request details, which include the token.
    return fail({ kind: "network", message: e instanceof Error ? e.message : "request failed" });
  }

  const rateLimit = readRateLimit(res.headers);
  if (res.ok) {
    try {
      return { ok: true, json: await res.json(), rateLimit };
    } catch {
      return fail({ kind: "unexpected_response", message: "response body was not valid JSON" });
    }
  }

  const apiMessage = await res.text().then(extractMessage, () => "");
  const message = `GitHub responded ${res.status}${apiMessage ? `: ${apiMessage}` : ""}`;

  // GitHub signals rate limiting with 429, or 403 + exhausted quota / Retry-After.
  const retryAfter = res.headers.get("retry-after");
  const limited =
    res.status === 429 ||
    (res.status === 403 && (rateLimit.remaining === 0 || retryAfter !== null));
  if (limited) {
    return fail({
      kind: "rate_limited",
      message,
      ...(retryAfter !== null && !Number.isNaN(Number(retryAfter)) && {
        retryAfterSeconds: Number(retryAfter),
      }),
      ...(rateLimit.resetAt !== undefined && { resetAt: rateLimit.resetAt }),
    }, res.status);
  }
  if (res.status === 401 || res.status === 403) return fail({ kind: "auth", message }, res.status);
  if (res.status >= 500) return fail({ kind: "service", message, status: res.status }, res.status);
  return fail({ kind: "invalid_query", message }, res.status); // 400, 404, 422, ...
}

function fail(failure: DiscoveryFailure, status?: number): TransportResult {
  return { ok: false, failure, ...(status !== undefined && { status }) };
}

function extractMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    return typeof m === "string" ? m : "";
  } catch {
    return "";
  }
}
