// Checks the email and Google Drive credentials against the real services, the way the app uses them.
// Run from the project root:  rork env run -- bun web-scholium/scripts/verify-integrations.ts [--send]
// Prints verdicts only. No secret value, client id or address is ever written out.
// Costs nothing: one email on Resend's free plan (only with --send) and a few unauthenticated Google requests.

const ALLOWED = "suryauthkarsha1@gmail.com";
const HOSTS = ["https://s04v1awd9en3668b6hy1l-web-scholium.rork.live", "https://autonomous-ai-research-lab.rork.app"];
const env = process.env;
const say = (name: string, ok: boolean | null, detail: string): void => console.log(`${ok === null ? "NOTE" : ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);

/** Removes anything that could identify the account or the credentials from a provider's message. */
function scrub(s: string): string {
  let out = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<address>");
  for (const k of ["RESEND_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALERT_EMAIL_TO"]) {
    const v = env[k];
    if (v) out = out.split(v).join(`<${k}>`);
  }
  return out.slice(0, 300);
}

async function email(send: boolean): Promise<void> {
  const key = env.RESEND_API_KEY ?? "";
  const to = (env.ALERT_EMAIL_TO ?? "").trim();
  say("email: key present", !!key, key ? `set, ${key.startsWith("re_") ? "has the Resend prefix" : "does NOT start with re_"}, ${key === key.trim() ? "no stray spaces" : "has leading or trailing spaces"}` : "missing");
  say("email: recipient", !!to, to ? `set; ${to.toLowerCase() === ALLOWED ? "it is the allowed Google account" : "it is NOT the allowed Google account"}` : "ALERT_EMAIL_TO is missing");
  if (!key || !to) return;
  if (!send) return say("email: delivery", null, "not attempted (run with --send)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Scholium <onboarding@resend.dev>",
      to: [to],
      subject: "Scholium: email delivery check",
      text: `This is a delivery check sent on ${new Date().toISOString()} with the key stored for Scholium. If you can read it, run alerts and reports can reach this inbox. Nothing else was sent.`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
  if (res.ok && body.id) {
    say("email: accepted by Resend", true, `HTTP ${res.status}, message id ends in …${body.id.slice(-6)}`);
    const st = await fetch(`https://api.resend.com/emails/${body.id}`, { headers: { authorization: `Bearer ${key}` } });
    const sb = (await st.json().catch(() => ({}))) as { last_event?: string; name?: string };
    if (st.ok) say("email: delivery status", sb.last_event !== "bounced", `Resend reports "${sb.last_event ?? "unknown"}"`);
    else say("email: delivery status", null, `the key cannot read it (HTTP ${st.status} ${sb.name ?? ""}), as expected for a sending-only key`);
  } else say("email: accepted by Resend", false, `HTTP ${res.status} ${body.name ?? ""}: ${scrub(body.message ?? "")}`);
}

/** Follows Google's consent redirects without signing in, and reports whether it accepted the request or named an error. */
async function consent(id: string, redirectUri: string): Promise<string> {
  const p = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/drive.file openid email", access_type: "offline", prompt: "consent select_account", include_granted_scopes: "false", login_hint: ALLOWED, state: "check" });
  let url = `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } });
    const loc = res.headers.get("location");
    const here = new URL(url);
    if (here.pathname.includes("/oauth/error") || here.searchParams.has("authError")) {
      const raw = here.searchParams.get("authError") ?? "";
      let text = "";
      try {
        text = Buffer.from(raw, "base64").toString("utf8");
      } catch {
        text = "";
      }
      const m = /(redirect_uri_mismatch|invalid_client|deleted_client|unauthorized_client|invalid_scope|access_denied|invalid_request|org_internal|disabled_client)/.exec(text + here.search);
      return `error:${m ? m[1] : "unknown"}`;
    }
    if (!loc) {
      if (res.status !== 200) return `http:${res.status}`;
      const html = await res.text();
      const m = /(redirect_uri_mismatch|invalid_client|deleted_client|unauthorized_client|disabled_client)/.exec(html);
      return m ? `error:${m[1]}` : "accepted";
    }
    url = new URL(loc, url).toString();
    if (new URL(url).pathname.startsWith("/v3/signin") || new URL(url).pathname.includes("/signin/identifier") || new URL(url).pathname.includes("/accountchooser")) return "accepted";
  }
  return "unclear";
}

async function drive(): Promise<void> {
  const id = env.GOOGLE_CLIENT_ID ?? "";
  const secret = env.GOOGLE_CLIENT_SECRET ?? "";
  say("drive: client id present", !!id, id ? `set, ${id.endsWith(".apps.googleusercontent.com") ? "has the Google client-id form" : "does NOT end in .apps.googleusercontent.com"}, ${id === id.trim() ? "no stray spaces" : "has stray spaces"}` : "missing");
  say("drive: client secret present", !!secret, secret ? `set, ${secret.startsWith("GOCSPX-") ? "has the Google secret prefix" : "does not start with GOCSPX-"}, ${secret === secret.trim() ? "no stray spaces" : "has stray spaces"}` : "missing");
  if (!id || !secret) return;

  // A made-up code can never be exchanged. Google answers invalid_client when the id/secret pair is wrong, and invalid_grant when the pair is right.
  const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: "4/not-a-real-code", client_id: id, client_secret: secret, redirect_uri: `${HOSTS[0]}/api/drive/callback` }) });
  const tb = (await t.json().catch(() => ({}))) as { error?: string; error_description?: string };
  say("drive: id and secret belong together", tb.error === "invalid_grant", `Google answered "${tb.error ?? `HTTP ${t.status}`}"${tb.error === "invalid_grant" ? " to a made-up code, which means the client itself was accepted" : `: ${scrub(tb.error_description ?? "")}`}`);

  const control = await consent(id, `${HOSTS[0]}/api/drive/not-the-callback`);
  say("drive: control (an address that is not registered)", control === "error:redirect_uri_mismatch", `Google answered "${control}"${control === "error:redirect_uri_mismatch" ? ", so a wrong address is detected" : ", so the redirect results below are not conclusive"}`);
  for (const h of HOSTS) {
    const r = await consent(id, `${h}/api/drive/callback`);
    say(`drive: redirect ${h}/api/drive/callback`, r === "accepted", r === "accepted" ? "Google accepted it and went on to its sign-in page" : `Google answered "${r}"`);
  }
}

async function app(): Promise<void> {
  for (const h of HOSTS) {
    try {
      const health = await fetch(`${h}/api/health`);
      const cb = await fetch(`${h}/api/drive/callback?error=access_denied&state=x`, { redirect: "manual" });
      const start = await fetch(`${h}/api/drive/start`, { method: "POST" });
      say(`app: ${h}`, health.status === 200, `health ${health.status}; callback without a valid state ${cb.status}${cb.headers.get("location") ? ` → ${new URL(cb.headers.get("location") ?? "", h).pathname}${new URL(cb.headers.get("location") ?? "", h).search.slice(0, 60)}` : ""}; starting a Drive connection signed out ${start.status}`);
    } catch (e) {
      say(`app: ${h}`, false, `not reachable (${e instanceof Error ? e.message.slice(0, 80) : "error"})`);
    }
  }
}

await email(process.argv.includes("--send"));
await drive();
await app();
