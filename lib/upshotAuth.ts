// In-memory store for an Upshot bearer token captured at runtime (via the
// browser bookmarklet → paste flow). Lets the user authenticate the server
// without restarting it or editing .env.local.
//
// Process-local on purpose: tokens never touch disk. Restarting the dev/prod
// server clears it. `UPSHOT_BEARER` from .env still works as a fallback.

export interface RuntimeAuth {
  bearer: string;
  /** Unix ms; null if unknown. Expired tokens are treated as absent. */
  expiresAt: number | null;
  /** Optional metadata surfaced in the UI status pill. */
  wallet?: string;
  userId?: string;
}

let auth: RuntimeAuth | null = null;

export function setRuntimeAuth(a: RuntimeAuth): void {
  auth = a;
}

export function clearRuntimeAuth(): void {
  auth = null;
}

/** Returns the live auth, or null if absent / expired. */
export function getRuntimeAuth(): RuntimeAuth | null {
  if (!auth) return null;
  if (auth.expiresAt != null && Date.now() > auth.expiresAt) {
    auth = null;
    return null;
  }
  return auth;
}

/**
 * Parse the bookmarklet output (or a bare JWT) and produce a RuntimeAuth.
 * Throws with a human-readable message on bad input. Supports:
 *  - the full bookmarklet JSON: { token, expires_at, wallet, user_id, … }
 *  - a `{ accessToken: "…" }` blob (raw global-store contents)
 *  - a bare JWT string (we then read `exp` / `walletAddress` from the payload)
 */
export function parseAuthInput(input: string): RuntimeAuth {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Paste your token JSON or the bearer string.");

  // Try JSON first; otherwise treat the input as a raw JWT.
  let bearer: string | null = null;
  let expiresAt: number | null = null;
  let wallet: string | undefined;
  let userId: string | undefined;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("That doesn't look like valid JSON.");
    }
    const obj = (parsed ?? {}) as Record<string, unknown>;
    bearer =
      (typeof obj.token === "string" && obj.token) ||
      (typeof obj.accessToken === "string" && obj.accessToken) ||
      (typeof obj.bearer === "string" && obj.bearer) ||
      // Nested under state.authState (the raw global-store shape from localStorage).
      ((obj.state as Record<string, unknown> | undefined)?.authState as Record<string, unknown> | undefined)?.accessToken as string | undefined ||
      null;
    if (typeof obj.expires_at === "string") {
      const ms = Date.parse(obj.expires_at);
      if (!Number.isNaN(ms)) expiresAt = ms;
    }
    if (typeof obj.wallet === "string") wallet = obj.wallet;
    if (typeof obj.user_id === "string") userId = obj.user_id;
  } else {
    bearer = trimmed.replace(/^Bearer\s+/i, "");
  }

  if (!bearer) throw new Error("No bearer token found in that input.");
  bearer = bearer.replace(/^Bearer\s+/i, "");
  // Sanity check: Upshot bearers are JWTs (`header.payload.signature`). Catches
  // pastes of random text / wallet addresses / "not a token" typos early
  // instead of failing on the next API call with an opaque 401.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) {
    throw new Error(
      "That doesn't look like a JWT bearer (expected three dot-separated segments)."
    );
  }

  // If we didn't get expiry/wallet from the wrapper, try the JWT payload.
  if ((expiresAt == null || !wallet) && bearer.split(".").length === 3) {
    try {
      const payloadB64 = bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = Buffer.from(payloadB64, "base64").toString("utf8");
      const payload = JSON.parse(json) as Record<string, unknown>;
      if (expiresAt == null && typeof payload.exp === "number") expiresAt = payload.exp * 1000;
      if (!wallet && typeof payload.walletAddress === "string") wallet = payload.walletAddress;
      if (!userId && typeof payload.id === "string") userId = payload.id;
    } catch {
      // Not a parseable JWT — fall through; the token may still be valid.
    }
  }

  if (expiresAt != null && Date.now() > expiresAt) {
    throw new Error("That token is already expired — run the bookmarklet again.");
  }
  return { bearer, expiresAt, wallet, userId };
}
