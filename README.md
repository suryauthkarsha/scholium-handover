# Scholium: handover guide

This repository holds the code of **Scholium**, a private research site owned by one person
(`suryauthkarsha1@gmail.com`). It is written so that a fresh Rork account, given only this
repository and one secret, can carry on from exactly where the previous account stopped.

**If you are a Rork agent and the owner has just handed you this repository: read this whole
file before you touch anything.** The short version is at the top; the rest explains why.

---

## The prompt the owner pastes

The owner starts every move by pasting this, and only this, into a new Rork account. It can be
used any number of times; each move carries on from the last saved letter and number.

```text
Clone https://github.com/suryauthkarsha/scholium-handover, read AGENTS.md and README.md in full
and follow them exactly. Publish the Scholium site (web-scholium/) unchanged as a web app: do
not rebuild, redesign, create a database or write to the store. Ask me for one thing only,
SCHOLIUM_MOVE_KEY, through the secrets form. Use this account's own Rork AI for the models
(never set MODEL_ACCOUNT_KEY). Finish with preflight.ts ending in "Ready" and check-store.ts
ending in "Nothing is missing", then give me the published address so I can sign in and press
"Continue here".
```

---

## The short version

1. The **work is not in this repository.** Every project, agent, subagent, objective, finding,
   transcript, checkpoint, source and uploaded file lives in a permanent store (a Postgres
   database) that belongs to the owner's email, not to any Rork account. This repository is only
   the site's code.
2. To carry on, a new copy of the site needs exactly **two things from the owner**:
   - this repository, and
   - one secret called the **move key** (`SCHOLIUM_MOVE_KEY`). It is *not* in this repository
     and must never be. The owner copies it from the old site: Settings → "Move to another Rork
     account" → "Copy the move key". The owner expects to hand over only the link to this
     repository, so **ask for this one value yourself**, as your first action, with the secrets
     widget, and say in one sentence where to copy it from. Do everything else without asking.
3. Your job is to **publish this code unchanged**, with that one secret set. Then the owner opens
   the published site, signs in with `suryauthkarsha1@gmail.com`, and presses **Continue here**
   in the bar at the top. Everything comes back and paused projects start working again.

You do not rebuild, redesign, re-create a database, or re-enter any research. If you find
yourself writing code, stop: something in the steps below was skipped.

This has been done for real twice (22 and 25 November 2026, see the end of this file). The whole job,
in order, is one question, eight commands and one press:

```bash
# 1. ask the owner for SCHOLIUM_MOVE_KEY with the secrets widget (the only question you ask)
cd web-scholium && bun install && cd ..
rork env run -- bun web-scholium/scripts/fill-from-store.ts        # three images come from the store
rork auth enable --json                                            # Google sign-in for this project
rork ai keys get --json                                            # this account's own model key
rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all  # NOT set by Rork; sign-in fails without it
rork checks --app web-scholium --json
rork web publish web-scholium --json
rork env run -e production -- bun web-scholium/scripts/preflight.ts https://<published address>
# must end with "Ready". Then the owner signs in there and presses "Continue here".
```

Each line is explained in "Steps" below. Do not skip `preflight.ts`: it is the one command that
catches every mistake made in the first real move before the owner meets it.

---

## Rules for the agent

Do:

- Keep `web-scholium/` byte-for-byte as it is in this repository.
- Ask for `SCHOLIUM_MOVE_KEY` with the secrets widget (`requestEnvs`, server-only, not public).
  It must reach the **published** site, so it has to be set for both environments (the widget
  does this; `rork env ls -e production` must list it).
- Verify with the read-only checks listed under "Step 6", `preflight.ts` first.
- Tell the owner plainly what you saw working and what only they can test (anything behind
  sign-in).

Do not:

- Do **not** create a new backend, database or Supabase project, and do **not** run the files in
  `supabase/migrations/`. The store already exists and already holds the work. Those files are
  kept only as a record of how the store was set up.
- Do **not** write to the store's tables (`scholium_rows`, `scholium_lease`, `scholium_code`)
  from scripts or SQL. Only the site writes there, and only the copy that holds the turn.
- Do **not** call `/api/vault/takeover` yourself or script the "Continue here" press. Taking the
  turn is the owner's decision, made by the owner's own press.
- Do **not** print, log, echo, commit or paste the move key or anything decoded from it. Never
  put it in a file that is tracked by git. Never ask for it in chat.
- Do **not** ask the owner for the nine separate keys the move key contains. One value is enough.
- Do **not** change `ALLOWED_EMAIL` in `web-scholium/src/shared/gate.ts`. The owner's email is
  what names the work in the store; change it and the site will look at an empty workspace.
- Do **not** change the look, the wording, the models, the limits or the prompts while moving.
- Do **not** leave two copies running projects. The design already prevents it (see "One copy
  works at a time"), so do not work around the standby bar.

---

## Steps

### Step 1: get the code into the project, unchanged

How the repository arrived decides what to do:

- **The project was created from this repository** (its root already has `rork.json`,
  `web-scholium/`, `supabase/`): nothing to do. Go to step 2.
- **The repository was linked as a folder inside another project** (for example with
  `rork connect clone <url>`): linked folders are read-only and are not built. Copy
  `web-scholium/` (and `supabase/` for the record) from the linked folder to the project root,
  without `node_modules`, `dist` or any `.env`.
- **There is no repository at hand:** the same code is kept in the store. The owner can download
  it from the old site (Settings → "Move to another Rork account" → "Download the site's code"),
  or you can read it once the move key is set (table `scholium_code`, one row, a base64 `.tar.gz`).

`rork.json` at the project root must list the app:

```json
{ "name": "Scholium", "path": "web-scholium", "framework": "web" }
```

`web/` ("Model Bench") is a separate small tool that happens to live in the same project. It is
not part of the move and holds no research. Leave it or drop it.

### Step 2: install

```bash
cd web-scholium && bun install
```

bun only, never npm or yarn.

Three image files (`web-scholium/public/favicon.png`, `web-scholium/public/icon.png`,
`web-scholium/assets/generated/icon.png`) could not be sent to GitHub with the rest and are
missing from this repository. The site works without them; only the small icon in the browser
tab is absent. They are filled in from the store in step 3.

### Step 3: the one secret

Ask the owner for `SCHOLIUM_MOVE_KEY` through the secrets widget. It starts with
`scholium-move-1.` and is long. It carries where the store is and its key, the workspace secret,
and the Google Drive and email settings, so files keep going to the same Drive folders and
alerts keep arriving.

Nothing else from the old account is needed.

Once it is set, fill in the three image files and confirm the code is the same as the copy the
store keeps (read-only for the store; a file already here is never overwritten):

```bash
rork env run -- bun web-scholium/scripts/fill-from-store.ts
```

It should report the three images filled in. Every other file is either identical or listed as
"differ from the store's copy (left as they are)". **Differing files are expected and are not a
problem: this repository is newer than the store's copy of the code, and the repository wins.**
Do not copy the store's version over them. (The store's copy of the *code* is only a spare; the
store's copy of the *work* is always current.)

### Step 4: what this account supplies by itself

These belong to the new Rork project and are different on every account. Do not copy them from
anywhere. Run these three commands; none of them happens by itself:

```bash
rork auth enable --json
rork ai keys get --json
rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all
```

| Name | What it is | How it appears |
| --- | --- | --- |
| `EXPO_PUBLIC_RORK_APP_KEY`, `RORK_AUTH_SECRET_KEY`, `RORK_AUTH_URL` | Google sign-in through Rork Auth | `rork auth enable --json` |
| `EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY` | The models the research uses | `rork ai keys get --json` |
| `EXPO_PUBLIC_PROJECT_ID` | This project's id; sign-in tokens are checked against it | **You set it**, with the third command |

**`EXPO_PUBLIC_PROJECT_ID` is the trap of this move.** Rork does not set it. `$RORK_PROJECT` in
the sandbox holds this project's id (it is also the first part of the preview address). Without
it the site checks sign-in against the *old* account's project, and the owner, correctly signed
in with the right address, gets `401` with the word "claims" on every request and an empty page.
Nothing in the signed-out checks shows this; only `preflight.ts` does. It happened in the first
real move.

**The AI models use this account's own Rork AI Cloud, with no rerouting and no code change.**
The site sends every model call with this project's own key
(`EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY`), which `rork ai keys get --json` creates. The move key
carries no model key from the old account, on purpose. The one thing to check: the optional
secret `MODEL_ACCOUNT_KEY` must **not** be set (it would send model calls to some other
account). `web-scholium/src/shared/modelAccount.ts` is the single place that decides this; do
not edit it. If the owner says "route the models to the current AI cloud", this paragraph is
all that is meant, and it is already how the site behaves.

Model use is therefore billed to the account that runs the site. After the move, that is the
new account. The project's own budget and what it has spent so far come over from the store.

Sign-in: Google sign-in must be switched on for the project (the `auth` skill). Do not change
the sign-in code. Only `suryauthkarsha1@gmail.com` is let in; that is intended.

### Step 5: check and publish

```bash
rork checks --app web-scholium --json
rork web publish web-scholium --json
```

Publish the real site, not only the preview. The preview address and the published address are
two separate copies with separate working data; the owner should press "Continue here" on the
**published** address only.

Settings reach the site only when it is built: after changing any setting, run both commands
again. Once the owner has pressed "Continue here", remember that every `rork checks` restarts
the live site. The project carries on by itself afterwards (a model answer in flight is asked
again), so it is safe, but do not run it without a reason while a project is working.

### Step 6: verify without touching anything

Replace `<site>` with the published address. First the one command that checks the setup:

```bash
rork env run -e production -- bun web-scholium/scripts/preflight.ts <site>
```

It reads only. It checks that every setting the published site needs is there (by name, never
printing a value), that `EXPO_PUBLIC_PROJECT_ID` is this project's id, that `MODEL_ACCOUNT_KEY`
is absent, that the move key opens and reaches the store, that the store holds the owner's
workspace, and that the published site answers and lets nobody in without sign-in. It ends with
**Ready**, or with a numbered list of exact commands to fix. Fix them, publish again, run it
again. Do not send the owner to the site before it says Ready.

Then the store and the site, piece by piece:

```bash
curl -s <site>/api/health                                   # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' <site>/api/workspace   # 401 while signed out
bun web-scholium/scripts/check-store.ts                     # ends with "Nothing is missing: every stored project is whole."
```

Then rehearse the move itself, still without touching anything:

```bash
rork env run -- bun web-scholium/scripts/rehearse-move.ts   # ends with "Rehearsal passed"
```

`rehearse-move.ts` reads every project out of the store the way a new copy does, opens it with
the site's own research engine (no model is called, no work is done), and confirms letter for
letter that every record and every message of every agent's and subagent's conversation,
including the model's saved reasoning, is what the store holds. It lists each unfinished task
and exactly where its agent stands. Show the owner its output before they press "Continue here".

`check-store.ts` only reads. It walks the whole store and confirms that every project record,
every agent and subagent, every task with its transcript complete to the last message, the
activity log without a gap, the checkpoints, the source texts and the uploaded files are all
there. It needs `SCHOLIUM_MOVE_KEY` in the environment (for example
`rork env run -- bun web-scholium/scripts/check-store.ts`). Add an agent id to see one agent's
saved context in detail: `bun web-scholium/scripts/check-store.ts sub-152`.

### Step 7: the owner's one press

Only the owner can do this, because it needs their Google sign-in:

1. Open the published address and sign in as `suryauthkarsha1@gmail.com`.
2. A bar at the top says the work is saved and ready to carry on here. Press **Continue here**.
3. The bar shows "Bringing your projects over: N of M" and then goes away. Projects that were
   paused or working on the old copy start working again by themselves.
4. Optional: Settings → "Check the store against this site" confirms the site and the store agree.

From that moment the old copy is on standby and stops working by itself. Nothing needs to be
switched off there.

After the press, `preflight.ts` says "The turn is already with this site", and `check-store.ts`
shows the new address on its "Working copy" line. That is how you confirm the press without
being able to sign in.

### Before the owner leaves the old copy

Tell the owner this short list; it is what makes "every word" true:

1. On the old site, **pause** the project (turns in flight finish and are saved; nothing is cut
   mid-thought). A project left working also moves, but its very last seconds are redone.
2. Settings must show the permanent store as **All saved** (not "saving" or a count waiting).
   Changes still waiting on the old copy at the moment of the press are the only thing that can
   be lost.
3. Copy the move key there (Settings → "Move to another Rork account" → "Copy the move key").
4. The new Rork account's GitHub connection must be allowed to read this private repository.

---

## What comes over, and what does not

Comes over, complete:

- Every project with its question, settings, budget, spending, cycle and phase.
- Every agent and subagent: its assignment (objective), status, result, and the full
  conversation of every task it ran, so a subagent picks up with the same context it had.
- The ledger: claims, evidence, experiments, notes, objections, reviews, instructions from the
  owner, artifacts, the record of every model call.
- The activity log, every entry from the first.
- Checkpoints with their snapshots (the site itself lets the oldest snapshots go; that is not a
  loss from moving).
- Sources and their saved text, uploaded files, the record of files sent to Google Drive, and
  the Drive connection itself.
- Workspace settings, the overall budget, method notes.

How an agent picks up: each agent's whole conversation is saved after every turn, with the
model's reasoning and its exact original reply. On the new copy the engine hands that same
conversation back to the model, so the agent continues from its last finished turn. A project
paused by the owner lets turns in flight finish first, so nothing is cut mid-thought. Pause
before moving.

Does not come over, by design, and costs nothing important:

- A model answer that was being written at the very second of the move. The question is asked
  again on the new copy.
- Anything the old copy did between the owner's press and the old copy noticing it (seconds).
  The new copy redoes it.
- The free daily server allowance counter. Each copy keeps its own, so a new account starts the
  day with a full allowance.
- The chat history between the owner and the previous Rork agent. It is not needed; this file
  replaces it.

---

## How it fits together

- **The site** (`web-scholium/`) is a Vite + React front end and a Cloudflare Worker
  (`worker/index.ts`) with two Durable Object classes declared in `wrangler.jsonc`:
  `Workspace` (one per owner: the project list, settings, budget, Drive connection, the turn)
  and `ResearchRun` (one per project: the research engine and all its data).
- **The working copy** is what the Durable Objects hold. It is fast and it is tied to the Rork
  project that runs it, which is why it cannot be the home of the work.
- **The permanent store** is the home. Every change on the working copy is written to it within
  seconds, compressed, as rows of `scholium_rows`. A fresh copy of the site reads those rows
  back and becomes identical to the old one.
- **One copy works at a time.** `scholium_lease` holds one row: which copy has the turn. A copy
  without the turn shows the standby bar and does nothing to the store. The turn moves only when
  the owner presses "Continue here".

Store layout, for reading only:

- `scholium_rows(obj, tbl, k, v, at)`. `obj` is `ws:<owner hash>` for the workspace or
  `run:<project id>` for a project. `tbl` is `ent` (records, key `kind<TAB>id`), `msg`
  (transcripts, key `task<TAB>index`), `ev` (activity log, key is the entry number), `txt` and
  `blob` (checkpoint snapshots `ckpt:<id>`, source texts `src:<id>`, uploads `up:<id>`), `kv`
  (settings and counters). Long values are split into numbered parts; values are compressed.
  `web-scholium/worker/vault.ts` is the only code that should encode or decode them.
- `scholium_lease`: who holds the turn.
- `scholium_code`: a spare copy of this repository's code, refreshed with
  `bun web-scholium/scripts/save-code.ts`. That script writes to the store, so run it only when
  the owner says yes. It can be older than this repository; then the repository wins.

Where things are in the code:

| File | What it does |
| --- | --- |
| `web-scholium/worker/env.ts` | The settings the site reads; how the move key is opened |
| `web-scholium/worker/vault.ts` | Talking to the store: saving, reading back, the code copy |
| `web-scholium/worker/workspace-do.ts` | The turn, "Continue here", bringing projects over |
| `web-scholium/worker/run-do.ts` | One project: loading from the store, carrying on after a move |
| `web-scholium/src/engine/` | The research engine: cycles, subagents, prompts, limits |
| `web-scholium/src/server/router.ts` | The site's addresses under `/api/` |
| `web-scholium/src/shared/gate.ts` | The owner's email and how it names the work |
| `web-scholium/src/components/Shell.tsx` | The standby bar and the "Continue here" button |
| `web-scholium/src/pages/Settings.tsx` | Store status, storage used, the move key, the store check |
| `web-scholium/scripts/preflight.ts` | The read-only check that this copy is set up and ready for the press |
| `web-scholium/scripts/check-store.ts` | The read-only check of the whole store |
| `web-scholium/scripts/rehearse-move.ts` | Opens every project from the store with the real engine and compares letter for letter |
| `web-scholium/scripts/fill-from-store.ts` | Fills in files missing here from the store's code copy |
| `supabase/migrations/` | How the store was set up. A record. Do not run again. |

`web-scholium/vercel.json` belongs to an older outside copy of the front end and plays no part.

---

## When something is not as described

- **No bar at the top after sign-in, and Settings says the permanent store is "Not set up".**
  The move key is not reaching the published site. Check that the secret is named exactly
  `SCHOLIUM_MOVE_KEY`, is set for the published site (not only the preview), and publish again.
- **The owner signs in with the right address and sees an empty or broken page; requests answer
  `401` with "claims".** `EXPO_PUBLIC_PROJECT_ID` is missing or is another project's id, so the
  site checks sign-in against the wrong project. Run
  `rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all`, then `rork checks` and
  publish again. Do not edit the sign-in code and do not touch `TOKEN_AUDIENCE` in `gate.ts`.
- **Sign-in is refused.** The owner is signed in to Google with a different address. Only
  `suryauthkarsha1@gmail.com` is let in.
- **Sign-in loops or fails for the right address.** Rork Auth is not switched on for this
  project, or the site was built before it was. Run `rork auth enable --json`, publish again.
- **Settings shows "Not reaching the store".** The database is unreachable; on a free Supabase
  plan a project is paused after a week without use. The owner restores it in the Supabase
  dashboard (their Supabase account is `suryauthkarsha@gmail.com`). Nothing is lost; the site
  keeps changes and sends them when the store answers again.
- **The store is full.** The free Supabase plan holds 500 MB; Settings shows how much is used.
  When it is full, saves wait on the site until there is room. A paid plan removes the limit.
- **Projects pause by themselves with a note about the daily allowance.** This is the hosting
  platform's limit, not the site's: each Rork project gets, per day, 100,000 records written,
  5,000,000 read and 100,000 calls on its server storage, counted afresh at 00:00 UTC (05:30 in
  India). A busy project writes roughly 40,000 to 50,000 records an hour. Since 25 November
  2026 the site no longer stops itself before that limit (the owner asked for the stop to be
  removed); past it the platform may pause the server until the reset, and projects carry on by
  themselves afterwards. Check the count with `rork backend usage`. The counter belongs to the
  copy, so a fresh account starts full. "Continue here" itself writes the whole project once
  (about 90,000 records for the project as it was on 25 November), so press it early in the UTC
  day, and do not move the turn back and forth.
- **"Can't open project", and `rork logs --source cloudflare --errors` shows "Worker exceeded
  memory limit." again and again.** The server has 128 MB for everything, and the project is
  large (see "State at the last handover check"). Something is building the whole project, or a
  large part of it, as one text. Find out which step with
  `web-scholium/scripts/memory-rehearsal.ts` (its first lines say how to run it; it only reads
  the store) and make that step work in pieces. Do not delete or trim research to make it fit.
  Known to be still too large at this size, and only run when the owner presses them:
  downloading a checkpoint, branching from a checkpoint, the backup download and the JSON
  export.
- **Google Drive asks to be connected again.** Normally it does not: the saved connection comes
  over. If it does, the new site's address plus `/api/drive/callback` must be added to the
  "Authorised redirect URIs" of the owner's Google OAuth client, whose consent screen should be
  "In production" so the connection does not expire after a week.
- **`check-store.ts` lists "Still on its way".** A project is working right now and its newest
  changes arrive seconds later. Run it again; it is only a problem if it prints `PROBLEMS`.

---

## The move that was really done

On 22 November 2026 the site was moved from its first Rork account to a second one with this
repository and the move key, and nothing else. The owner pressed "Continue here" at 03:14 UTC;
the store's turn went from 1 to 2 and the project carried on at the new address from where it
had been paused. Since then it has gone on working there: more than a hundred further
subagents, each with its full conversation, were created on the new copy on top of the ones
that came over.

What went wrong that time, and is now covered above and by `preflight.ts`:
`EXPO_PUBLIC_PROJECT_ID` was not set on the new project, so the owner's sign-in was answered
with `401` "claims" until it was set and the site built again.

Changed in the code after that first move: the side menu can be folded away, the two status
notes on a project's page can be dismissed, and the subagent limit is 1,000 (was 200; older
projects are raised once when opened).

### The second move, 25 November 2026

The second account ran out of AI credits (model calls answered `HTTP 402`, "Insufficient
credits"), so the site was moved to a third account. The owner pressed "Continue here" at
14:50 UTC; the turn went to 7.

What went wrong that time, and is fixed in this repository:

- **The project had outgrown the server's 128 MB of memory.** Opening it, saving a checkpoint,
  copying to the store and reading back from the store each held the whole project as one text.
  All of these now work a piece at a time (`worker/sql-store.ts`, `worker/vault.ts`,
  `worker/env.ts`, `worker/run-do.ts`, `src/engine/background.ts`). What is stored is, byte for
  byte, what the old code stored; only the way it is produced changed.
- **A crash every 45 seconds for a day ("Can't open project").** On opening, the project at
  once began its Google Drive copy, which built the full report (18 million characters), its
  LaTeX form and the whole ledger together. It crashed before it could note the attempt, so it
  began again on every reopening and used up the day's read allowance several times over. Now
  the copy builds one file at a time, notes the attempt before starting, and for a project this
  large the report in Drive leaves out experiment code and output and `ledger.json` is no
  longer updated there (every artifact and every experiment's code is still copied; the
  complete record is in the store).
- **The site's own daily-allowance stop** was removed at the owner's request.

Where the site runs now: `https://scholium-publish.rork.app`. That is the "old site" for the
next move, and where the owner copies the move key from. The copy on the previous account
(`scholium-research-site.rork.app`) is out of AI credits: do not move the turn back to it.

## State at the last handover check

Checked with `check-store.ts` on 26 November 2026, about 11:40 UTC, while the project was
working on the third account. The result: "Nothing is missing: every stored project is whole."

- One project: "Binary Permutation X-rays and the Two-Diagonal Extension", working, cycle 4,
  phase `work`, about $5,263 spent of its budget.
- 625 agents, 622 of them subagents, subagent limit 1,000.
- 1,239 tasks; 1,232 with the transcript complete to the last message (20,341 messages) and 7
  in progress at that second, whose newest messages were still on their way.
- Activity log entries 1 to 6,051 with no gap.
- 9 checkpoints, all with their full snapshot.
- 198 sources (132 with saved text), 23 of 23 uploaded files stored.
- Ledger: 760 claims, 2,505 evidence items, 2,967 experiments, 731 notes, 83 objections,
  320 reviews, 43 owner instructions, 41 artifacts, 14,245 model calls, 2,140 Drive file
  records, 10 emails, 5 obligations.
- 52,554 stored items, about 391 million characters.

These numbers grow whenever the project works. Run the check again for the current truth.

The owner's chat with the previous Rork agents does not come over and is not needed: the
research's own message history (every agent's and subagent's conversation) is in the store, and
this file is everything an agent needs to know.
