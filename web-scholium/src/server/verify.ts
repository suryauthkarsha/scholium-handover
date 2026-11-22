// Verifies a Rork Auth access token on the server: signature against the published keys, issuer, audience,
// algorithm and expiry. Nothing here trusts a value the browser could have made up.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { JWKS_URL, TOKEN_AUDIENCE, TOKEN_ISSUER } from "../shared/gate";

export type Verified =
  | { ok: true; sub: string; email: string; emailVerified?: boolean; provider?: string; name?: string; picture?: string; exp: number }
  | { ok: false; reason: string };

export interface VerifierOptions {
  /** Key lookup. Defaults to the issuer's published key set. Tests pass a local key set. */
  key?: JWTVerifyGetKey;
  issuer?: string;
  audience?: string;
}

const REASONS: Record<string, string> = {
  ERR_JWT_EXPIRED: "expired",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "claims",
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "signature",
  ERR_JOSE_ALG_NOT_ALLOWED: "algorithm",
  ERR_JWKS_NO_MATCHING_KEY: "unknown_key",
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: "unknown_key",
  ERR_JWKS_TIMEOUT: "keys_unavailable",
  ERR_JWKS_INVALID: "keys_unavailable",
  ERR_JWS_INVALID: "malformed",
  ERR_JWT_INVALID: "malformed",
  ERR_JOSE_NOT_SUPPORTED: "algorithm",
};

export function makeVerifier(opts: VerifierOptions = {}): (token: string) => Promise<Verified> {
  const key = opts.key ?? createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000, timeoutDuration: 5000 });
  const issuer = opts.issuer ?? TOKEN_ISSUER;
  const audience = opts.audience ?? TOKEN_AUDIENCE;
  return async (token) => {
    if (typeof token !== "string" || token.length < 20 || token.length > 8192 || token.split(".").length !== 3) return { ok: false, reason: "malformed" };
    try {
      const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp", "sub"], clockTolerance: 5 });
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      const email = typeof payload.email === "string" ? payload.email : "";
      if (!sub || !email || typeof payload.exp !== "number") return { ok: false, reason: "claims" };
      return {
        ok: true,
        sub,
        email,
        emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
        provider: typeof payload.provider === "string" ? payload.provider : undefined,
        name: typeof payload.name === "string" ? payload.name.slice(0, 120) : undefined,
        picture: typeof payload.picture === "string" && /^https:\/\//.test(payload.picture) ? payload.picture.slice(0, 500) : undefined,
        exp: payload.exp,
      };
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "";
      return { ok: false, reason: REASONS[code] ?? "rejected" };
    }
  };
}
