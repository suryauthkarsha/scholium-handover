# For any agent opening this repository

Read `README.md` in full before doing anything. It is the handover guide for this site.

The essentials:

- This is **Scholium** (`web-scholium/`), a finished, private research site. Publish it
  **unchanged**. Do not rebuild or redesign it.
- The research itself is **not in this repository**. It lives in a permanent store that belongs
  to the owner's email, `suryauthkarsha1@gmail.com`.
- The only thing to ask the owner for is one secret, `SCHOLIUM_MOVE_KEY`, through the secrets
  widget, as your first action (they copy it from the old site: Settings → "Move to another Rork
  account" → "Copy the move key"). Never print it, never commit it, never ask for it in chat.
  Do everything else without asking.
- The AI models already use the Rork AI Cloud of whichever account runs the site. Run
  `rork ai keys get --json`, make sure no secret named `MODEL_ACCOUNT_KEY` is set, and change no
  code.
- Do **not** create a database or backend, do **not** run `supabase/migrations/`, do **not**
  write to the store, and do **not** press or script "Continue here". That press is the owner's.
- Sign-in keys and model keys come from the new Rork project itself (`rork auth enable --json`,
  `rork ai keys get --json`).
- Then: `rork checks --app web-scholium --json`, publish, run
  `bun web-scholium/scripts/check-store.ts` (read-only; must end with "Nothing is missing"), and
  ask the owner to sign in on the published address and press **Continue here**.
