// Checks, without printing any secret, whether a backend accepts short-lived tokens signed with this project's
// SCHOLIUM_SECRET. It names a run that does not exist, so nothing is read or changed.
// Usage: rork env run -- bun web-scholium/scripts/probe-signing.ts
import { ownerHashFor, ALLOWED_EMAIL, signDriveState, signTicket } from "../src/shared/gate";

const secret = process.env.SCHOLIUM_SECRET ?? "";
if (secret.length < 16) throw new Error("SCHOLIUM_SECRET is not available here.");
const hosts = ["https://scholium.rork.app", "https://s04v1awd9en3668b6hy1l-web-scholium.rork.live"];
const run = "probe000000000000000";
const up = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
for (const h of hosts) {
  const good = await signTicket(secret, run, await ownerHashFor(ALLOWED_EMAIL), "probenonce1", Date.now());
  const bad = await signTicket("not-the-secret-0123456789", run, await ownerHashFor(ALLOWED_EMAIL), "probenonce1", Date.now());
  const a = await fetch(`${h}/api/runs/${run}/ws?ticket=${good}`, { headers: up });
  const b = await fetch(`${h}/api/runs/${run}/ws?ticket=${bad}`, { headers: up });
  console.log(h, "| ticket signed here:", a.status, (await a.text()).slice(0, 90), "| wrongly signed:", b.status);
  if (process.argv.includes("--callback")) {
    // A correctly signed state that was never issued: reaches the workspace, which must refuse it.
    const st = await signDriveState(secret, "neverissuednonce1", Date.now());
    const c = await fetch(`${h}/api/drive/callback?error=probe&state=${st}`);
    console.log("   callback with a signed but never-issued state:", c.status, (await c.text()).replace(/<style>.*<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200));
  }
}
