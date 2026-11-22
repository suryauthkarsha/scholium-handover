// Sign-in with Google through Rork Auth, plus the server's verdict on whether this account may use the workspace.
// The browser only ever decides what to show. Every request is authorised again on the server.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const AUTH_URL = import.meta.env.EXPO_PUBLIC_RORK_AUTH_URL as string;
const APP_KEY = import.meta.env.EXPO_PUBLIC_RORK_APP_KEY as string;

const ACCESS_TOKEN_KEY = "rork:access_token";
const REFRESH_TOKEN_KEY = "rork:refresh_token";
const CODE_VERIFIER_KEY = "rork:pkce_verifier";

/** Tells the provider that the server refused a request, so it asks the server again who is signed in. */
export const AUTH_EVENT = "scholium:auth";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function generateCodeVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// A token this close to expiring is refreshed first, so a request never leaves with one about to die.
const EXPIRY_MARGIN_MS = 60_000;
// How long to wait before asking Rork again after a refresh that could not be answered.
const REFRESH_RETRY_MS = 30_000;
// A refresh that takes longer than this counts as not answered, so nothing waits on it forever.
const REFRESH_TIMEOUT_MS = 15_000;

export interface User {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

/** What the server said about this session. Only "allowed" opens the workspace. */
export type Access =
  | { state: "none" }
  | { state: "checking" }
  | { state: "allowed"; email: string; name: string | null; picture: string | null; expiresAt: number }
  | { state: "denied"; email: string }
  | { state: "error"; code: string; detail: string };

/** Reads who a token belongs to, for display only. An expired token gives null unless `allowExpired` is set. */
function userFromToken(token: string, allowExpired = false): User | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!allowExpired && payload.exp && payload.exp * 1000 < Date.now() + EXPIRY_MARGIN_MS) return null;
    return { id: payload.sub, email: payload.email ?? "", name: payload.name, picture: payload.picture };
  } catch {
    return null;
  }
}

let showUser: (user: User | null) => void = () => {};
let refreshInFlight: Promise<string | null> | null = null;
let retryRefreshAfter = 0;

/**
 * A valid access token for a request to the backend, refreshed first when it has expired or is about to.
 * Pass `rejected`, the token the backend just answered 401 for, to get a new one.
 * Null when signed out, or when Rork cannot be reached right now.
 */
export async function getAccessToken(rejected?: string): Promise<string | null> {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  const usable = accessToken && accessToken !== rejected && userFromToken(accessToken);
  const token = usable ? accessToken : await refreshToken();
  // A request is only retried for the user it was made for.
  if (token && rejected && userFromToken(token)?.id !== userFromToken(rejected, true)?.id) return null;
  return token;
}

function refreshToken(): Promise<string | null> {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function requestRefresh(): Promise<string | null> {
  const stored = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!stored) {
    showUser(null);
    return null;
  }
  if (Date.now() < retryRefreshAfter) return null;

  const response = await fetch(`${AUTH_URL}/oauth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_key: APP_KEY, refresh_token: stored }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  }).catch(() => null);
  const body = response?.ok ? await response.json().catch(() => null) : null;

  // The user signed out, or signed in again, while Rork was answering: this answer is for a session that is gone.
  if (localStorage.getItem(REFRESH_TOKEN_KEY) !== stored) return null;

  // Only a 401 says the session is over.
  if (response?.status === 401) {
    signOut();
    return null;
  }

  // Anything else that is not a token says nothing about the session: stay signed in and wait before asking again.
  const access_token: unknown = body?.access_token;
  if (typeof access_token !== "string") {
    retryRefreshAfter = Date.now() + REFRESH_RETRY_MS;
    const stale = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (stale) showUser(userFromToken(stale, true));
    return null;
  }

  localStorage.setItem(ACCESS_TOKEN_KEY, access_token);
  showUser(userFromToken(access_token));
  return access_token;
}

export function signOut(): void {
  const stored = localStorage.getItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(CODE_VERIFIER_KEY);
  showUser(null);
  // End the session on Rork too. Sign-out never waits for it or fails because of it.
  if (stored) {
    fetch(`${AUTH_URL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: APP_KEY, refresh_token: stored }),
      keepalive: true,
    }).catch(() => {});
  }
}

const REASONS: Record<string, string> = {
  network: "The server could not be reached. Check the connection and try again.",
  session: "The session could not be renewed just now. It will be tried again shortly.",
  not_configured: "The server is missing its sign-in configuration, so it refuses every request.",
  expired: "The sign-in token had expired.",
};

/** Asks the backend who this is. The answer comes from a token the server verified itself. */
async function askServer(): Promise<Access> {
  let token = await getAccessToken();
  if (!token) return localStorage.getItem(REFRESH_TOKEN_KEY) ? { state: "error", code: "session", detail: REASONS.session } : { state: "none" };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
    } catch {
      return { state: "error", code: "network", detail: REASONS.network };
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { state: "allowed", email: String(body.email ?? ""), name: body.name ?? null, picture: body.picture ?? null, expiresAt: Number(body.expiresAt ?? 0) };
    if (res.status === 403) return { state: "denied", email: userFromToken(token, true)?.email ?? "" };
    if (res.status === 401 && attempt === 0) {
      const fresh = await getAccessToken(token);
      if (fresh) {
        token = fresh;
        continue;
      }
    }
    const code = String(body.reason ?? body.error ?? res.status);
    return { state: "error", code, detail: REASONS[code] ?? `The server refused this session (${res.status}).` };
  }
}

interface AuthContextType {
  user: User | null;
  access: Access;
  isLoading: boolean;
  isSigningIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
  clearError: () => void;
  recheck: () => void;
  /** Exchanges a `code` for tokens. The /auth/callback route calls this when a redirect returns from sign-in. */
  exchangeCode: (code: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<Access>({ state: "none" });
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listener = useRef<((event: MessageEvent) => void) | null>(null);
  const checkNo = useRef(0);
  const userId = user?.id ?? null;

  const clearError = useCallback(() => setError(null), []);

  const recheck = useCallback(() => {
    const mine = ++checkNo.current;
    void askServer().then((a) => {
      if (mine === checkNo.current) setAccess(a);
    });
  }, []);

  useEffect(() => {
    showUser = setUser;
    void (async () => {
      try {
        const token = localStorage.getItem(ACCESS_TOKEN_KEY);
        const current = token ? userFromToken(token) : null;
        if (current) setUser(current);
        else await refreshToken();
      } finally {
        setIsLoading(false);
      }
    })();
    return () => {
      showUser = () => {};
      if (listener.current) window.removeEventListener("message", listener.current);
    };
  }, []);

  // Whenever the signed-in person changes, the server is asked again.
  useEffect(() => {
    if (!userId) {
      checkNo.current++;
      setAccess({ state: "none" });
      return;
    }
    setAccess({ state: "checking" });
    recheck();
  }, [userId, recheck]);

  useEffect(() => {
    window.addEventListener(AUTH_EVENT, recheck);
    return () => window.removeEventListener(AUTH_EVENT, recheck);
  }, [recheck]);

  const exchangeCode = useCallback(async (code: string) => {
    const verifier = localStorage.getItem(CODE_VERIFIER_KEY);
    if (!verifier) {
      setError("The sign-in attempt was lost. Start it again.");
      return;
    }
    localStorage.removeItem(CODE_VERIFIER_KEY);
    const response = await fetch(`${AUTH_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: APP_KEY, code, code_verifier: verifier }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || `Sign-in failed (${response.status}).`);
      return;
    }
    const { access_token, refresh_token } = await response.json();
    localStorage.setItem(ACCESS_TOKEN_KEY, access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, refresh_token);
    setUser(userFromToken(access_token, true));
  }, []);

  const signIn = useCallback(async () => {
    setIsSigningIn(true);
    setError(null);
    try {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      localStorage.setItem(CODE_VERIFIER_KEY, verifier);
      const isPreview = window.parent !== window;
      const response = await fetch(`${AUTH_URL}/oauth/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Google is the only provider this workspace offers.
        body: JSON.stringify({ app_key: APP_KEY, provider: "google", code_challenge: challenge, target: "web", env: isPreview ? "preview" : "production", app_path: "web-scholium" }),
      });
      if (!response.ok) {
        localStorage.removeItem(CODE_VERIFIER_KEY);
        const body = await response.json().catch(() => ({}));
        setError(body.error || `Sign-in could not be started (${response.status}).`);
        return;
      }
      const { auth_url } = await response.json();
      if (!isPreview) {
        // Standalone site: a full redirect. The /auth/callback route picks up the returned code.
        window.location.href = auth_url;
        return;
      }
      // Inside the Rork preview: a popup, which posts the code back to this window.
      const popup = window.open(auth_url, "_blank", "width=500,height=650");
      if (!popup) {
        setError("The sign-in window was blocked. Allow pop-ups for this site and try again.");
        localStorage.removeItem(CODE_VERIFIER_KEY);
        return;
      }
      await new Promise<void>((resolve) => {
        const onMessage = async (event: MessageEvent) => {
          if (event.data?.type !== "rork_auth_callback") return;
          window.removeEventListener("message", onMessage);
          listener.current = null;
          clearInterval(poll);
          if (event.data.code) await exchangeCode(String(event.data.code));
          resolve();
        };
        listener.current = onMessage;
        window.addEventListener("message", onMessage);
        const poll = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(poll);
          window.removeEventListener("message", onMessage);
          listener.current = null;
          localStorage.removeItem(CODE_VERIFIER_KEY);
          resolve();
        }, 500);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      localStorage.removeItem(CODE_VERIFIER_KEY);
    } finally {
      setIsSigningIn(false);
    }
  }, [exchangeCode]);

  return <AuthContext.Provider value={{ user, access, isLoading, isSigningIn, error, signIn, signOut, clearError, recheck, exchangeCode }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
