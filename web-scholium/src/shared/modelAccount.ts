// The one place that decides which Rork account pays for and serves the model calls.
//
// To send every model call to another Rork account, set the secret MODEL_ACCOUNT_KEY to that
// account's Rork AI key (the value of EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY in a project that
// belongs to it). Remove the secret, or leave it blank, to go back to this project's own account.
// Nothing else needs to change: no code, no model names, no saved data.

export interface ModelAccountEnv {
  /** Optional. A Rork AI key from another account; when set, it is used for every model call. */
  MODEL_ACCOUNT_KEY?: string;
  /** This project's own Rork AI key, provided by Rork. */
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
}

export type ModelAccountSource = "project" | "other";

export interface ModelAccount {
  /** Server-side only. Never sent to the browser, logged, or handed to a sandbox. */
  secret: string;
  source: ModelAccountSource;
}

export function modelAccount(env: ModelAccountEnv): ModelAccount {
  const other = (env.MODEL_ACCOUNT_KEY ?? "").trim();
  if (other) return { secret: other, source: "other" };
  return { secret: (env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? "").trim(), source: "project" };
}
