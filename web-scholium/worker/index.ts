// The Worker's front door. It only hands requests to the router, which authorises every one of them
// before anything else happens. Everything that is not under /api/ is a static file of the web app.
import { handle, type RouterEnv } from "../src/server/router";
import { makeVerifier } from "../src/server/verify";
import { TOKEN_AUDIENCE } from "../src/shared/gate";
import { type Env, withMoveKey } from "./env";

export { ResearchRun } from "./run-do";
export { Workspace } from "./workspace-do";
export { ModelCaller } from "./caller-do";

// Sign-in tokens are issued for the Rork project the site is published from. Rork gives every project its own
// id, so a copy published from another account checks tokens against that account's project with no change here.
const verifiers = new Map<string, ReturnType<typeof makeVerifier>>();
function verifierFor(env: Env): ReturnType<typeof makeVerifier> {
  const id = (env.EXPO_PUBLIC_PROJECT_ID ?? "").trim();
  const audience = /^[a-z0-9]{12,40}$/.test(id) ? id : TOKEN_AUDIENCE;
  let v = verifiers.get(audience);
  if (!v) verifiers.set(audience, (v = makeVerifier({ audience })));
  return v;
}

/** 26 random lower-case letters and digits: about 134 bits. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = "";
  for (const b of bytes) out += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return out;
}

export default {
  async fetch(request: Request, raw: Env): Promise<Response> {
    const env = withMoveKey(raw);
    const res = await handle(request, env as unknown as RouterEnv, { verify: verifierFor(env), now: Date.now, randomId });
    return res ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
