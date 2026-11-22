# For any agent opening this repository

Read `README.md` in full before doing anything. It is the handover guide for this site, and it
is all the context you need: the owner will give you this repository's link and nothing else.

The essentials:

- This is **Scholium** (`web-scholium/`), a finished, private research site. Publish it
  **unchanged**. Do not rebuild or redesign it.
- The research itself is **not in this repository**. It lives in a permanent store that belongs
  to the owner's email, `suryauthkarsha1@gmail.com`: every project, agent, subagent, checkpoint,
  file and every message of every conversation.
- The only thing to ask the owner for is one secret, `SCHOLIUM_MOVE_KEY`, through the secrets
  widget, as your first action (they copy it from the old site: Settings → "Move to another Rork
  account" → "Copy the move key"). Never print it, never commit it, never ask for it in chat.
  Do everything else without asking.
- Do **not** create a database or backend, do **not** run `supabase/migrations/`, do **not**
  write to the store, and do **not** press or script "Continue here". That press is the owner's.
- Do **not** change `ALLOWED_EMAIL`, the sign-in code or `src/shared/modelAccount.ts`.

The whole job, in order:

```bash
cd web-scholium && bun install && cd ..
rork env run -- bun web-scholium/scripts/fill-from-store.ts        # files listed as differing: leave them, the repository wins
rork auth enable --json
rork ai keys get --json
rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all  # Rork does not set this; without it sign-in answers 401 "claims"
rork checks --app web-scholium --json
rork web publish web-scholium --json
rork env run -e production -- bun web-scholium/scripts/preflight.ts https://<published address>
```

- `preflight.ts` is read-only and must end with **Ready**. If it lists fixes, do them, publish
  again, run it again.
- No secret named `MODEL_ACCOUNT_KEY` may be set: the models use the Rork AI Cloud of whichever
  account runs the site, with no code change.
- Then run `rork env run -- bun web-scholium/scripts/check-store.ts` (read-only; must end with
  "Nothing is missing") and ask the owner to sign in on the **published** address and press
  **Continue here**.
- You cannot see behind sign-in. Say so, and say what only the owner can confirm.
