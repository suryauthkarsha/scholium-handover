// The only screen a signed-out visitor, or any other account, can ever see. It loads nothing from the workspace.
import { Loader2, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/hooks/useAuth";
import { ThemeToggle } from "@/lib/theme";
import { LABELS, LABEL_NAMES } from "@/shared/types";

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-[18px] w-[18px]" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

const LADDER_NOTES: Record<string, string> = {
  conjecture: "stated, not yet supported",
  numerical: "computed, with the code and its output kept",
  partial: "a proved piece of something larger",
  candidate: "a full argument awaiting review",
  reviewed: "survived review by a different model",
  formal: "accepted by the Lean kernel",
};

/** The right-hand folio: how the workspace grades what it claims. Fixed product behaviour, not sample data. */
function Folio() {
  const leaf = useRef<HTMLDivElement>(null);
  const lean = (x: number, y: number): void => {
    leaf.current?.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
    leaf.current?.style.setProperty("--rx", `${(-y * 4).toFixed(2)}deg`);
  };
  return (
    <div
      className="relative hidden lg:block"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        lean(
          (e.clientX - r.left) / r.width - 0.5,
          (e.clientY - r.top) / r.height - 0.5,
        );
      }}
      onPointerLeave={() => lean(0, 0)}
    >
      <div className="rise absolute inset-y-10 left-6 right-10">
        <div className="float h-full" style={{ perspective: "1600px" }}>
          <div ref={leaf} className="folio relative h-full">
            <div
              aria-hidden="true"
              className="sheet absolute inset-0 rounded-sm border bg-card opacity-60"
              style={{ transform: "rotate(-2.4deg) translate(-10px, 10px)" }}
            />
            <div
              aria-hidden="true"
              className="sheet absolute inset-0 rounded-sm border bg-card opacity-80"
              style={{ transform: "rotate(3deg) translate(8px, 4px)" }}
            />
            <div
              className="sheet absolute inset-0 rounded-sm border bg-card shadow-[0_30px_60px_-30px_hsl(var(--shade)/0.5)]"
              style={{ transform: "rotate(1.2deg)" }}
            >
              <div className="absolute inset-y-0 left-16 w-px bg-rubric/40" />
              <div className="flex h-full flex-col px-10 pb-10 pl-24 pt-12">
                <p className="rubric">The standing of a claim</p>
                <h2 className="mt-3 text-[2rem] font-normal leading-[1.12]">
                  Nothing here is called a theorem until{" "}
                  <em>something other than its author</em> has checked it.
                </h2>
                <ol className="stagger mt-8 space-y-0">
                  {LABELS.map((l, i) => (
                    <li key={l} className="hairline relative border-t py-3">
                      <span className="absolute -left-[3.25rem] top-3 font-serif text-xl italic text-rubric">
                        {["i", "ii", "iii", "iv", "v", "vi"][i]}
                      </span>
                      <p className="font-serif text-[1.16rem] leading-tight">
                        {LABEL_NAMES[l]}
                      </p>
                      <p className="mt-0.5 text-[0.86rem] text-muted-foreground">
                        {LADDER_NOTES[l]}
                      </p>
                    </li>
                  ))}
                </ol>
                <p className="mt-auto pt-6 font-serif text-[0.98rem] italic text-muted-foreground">
                  Only the last two are granted by the platform itself. A model
                  cannot award them to its own work.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rise mt-6 rounded-sm border border-rubric/40 bg-rubric-soft/60 p-4"
      role="alert"
    >
      <p className="rubric">{title}</p>
      <div className="mt-1.5 space-y-2 text-[0.93rem] leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export default function SignIn() {
  const {
    user,
    access,
    isLoading,
    isSigningIn,
    error,
    signIn,
    signOut,
    recheck,
  } = useAuth();
  const waiting = isLoading || access.state === "checking";

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <main className="flex flex-col px-6 py-6 sm:px-12 lg:px-16">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/icon.png" alt="" className="h-8 w-8 rounded-[7px]" />
            <span className="font-serif text-xl">Scholium</span>
          </div>
          <ThemeToggle />
        </header>

        <div className="my-auto max-w-[30rem] py-12">
          <p className="rubric rise">Private research workspace</p>
          <h1 className="rise mt-3 text-[2.7rem] font-normal leading-[1.04] sm:text-[3.4rem]">
            Hard problems, worked in the open{" "}
            <em className="relative whitespace-nowrap text-rubric">
              margin
              <svg
                aria-hidden="true"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
                className="draw-clip pointer-events-none absolute -bottom-[0.1em] left-0 h-[0.2em] w-full overflow-visible"
              >
                <path
                  d="M1 6.5 C 18 2.5, 34 8.5, 52 5 S 84 3, 99 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </em>
            .
          </h1>
          <p className="rise mt-5 text-[1.02rem] leading-relaxed text-muted-foreground">
            Frontier models take independent lines of attack on one problem,
            review each other step by step, and keep every computation, source
            and objection on the record.
          </p>

          {waiting ? (
            <p className="mt-9 flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your session
              with the server…
            </p>
          ) : access.state === "denied" ? (
            <Notice title="Not this account">
              <p>
                You are signed in as{" "}
                <span className="font-mono text-[0.86rem]">
                  {access.email || "an unknown account"}
                </span>
                . This workspace belongs to a different Google account, so the
                server refused it and nothing was loaded.
              </p>
              <button
                type="button"
                onClick={signOut}
                className="press rounded-sm border bg-card px-3 py-1.5 font-medium"
              >
                Sign out and use another account
              </button>
            </Notice>
          ) : access.state === "error" ? (
            <Notice title="The server did not accept this session">
              <p>{access.detail}</p>
              <p className="font-mono text-[0.8rem] text-muted-foreground">
                reason: {access.code}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={recheck}
                  className="press rounded-sm bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={signOut}
                  className="press rounded-sm border bg-card px-3 py-1.5 font-medium"
                >
                  Sign out
                </button>
              </div>
            </Notice>
          ) : (
            <div className="rise mt-9">
              <button
                type="button"
                onClick={() => void signIn()}
                disabled={isSigningIn || !!user}
                className="press inline-flex h-12 w-full items-center justify-center gap-3 rounded-sm bg-primary px-5 text-[1rem] font-medium text-primary-foreground shadow-sm transition-opacity disabled:opacity-60 sm:w-auto"
              >
                {isSigningIn ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-white">
                    <GoogleMark />
                  </span>
                )}
                {isSigningIn ? "Waiting for Google…" : "Continue with Google"}
              </button>
              {error && (
                <p
                  className="mt-3 text-[0.93rem] text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          <p className="mt-8 flex items-start gap-2 text-[0.86rem] leading-relaxed text-muted-foreground">
            <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              One Google account can open this workspace. The server verifies it
              on every request, file and live stream. Nothing is decided in the
              browser.
            </span>
          </p>
        </div>
      </main>
      <Folio />
    </div>
  );
}

/** Where Google sends the browser back to on the published site. It trades the returned code for a session. */
export function AuthCallback() {
  const { exchangeCode, error } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) {
      setProblem(
        params.get("error_description") ??
          params.get("error") ??
          "Google did not return a sign-in code.",
      );
      return;
    }
    // Rork sign-in only returns to the Rork-hosted site. When the attempt was started on the one other site named here
    // (the Vercel copy; VITE_SIGNIN_RELAY_ORIGIN overrides it at build time), this browser holds no verifier for it here, so the code is handed on to
    // that site, which holds the verifier. The code is useless to anyone without it.
    const relay = (
      (import.meta.env.VITE_SIGNIN_RELAY_ORIGIN as string | undefined) ??
      "https://scholium-math.vercel.app"
    )
      .trim()
      .replace(/\/+$/, "");
    if (
      !localStorage.getItem("rork:pkce_verifier") &&
      /^https:\/\/[^/]+$/.test(relay) &&
      relay !== window.location.origin
    ) {
      window.location.replace(
        `${relay}/auth/callback?code=${encodeURIComponent(code)}`,
      );
      return;
    }
    void exchangeCode(code).then(() => navigate("/", { replace: true }));
  }, [exchangeCode, navigate]);

  const message = problem ?? error;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      {message ? (
        <>
          <p className="rubric">Sign-in did not complete</p>
          <p className="max-w-md">{message}</p>
          <a href="/" className="underline underline-offset-4">
            Back to the sign-in screen
          </a>
        </>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Completing sign-in…
        </p>
      )}
    </div>
  );
}
