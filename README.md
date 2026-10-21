# Dewy Bank workshop

One `wk` project for the whole workshop. Each station teaches one factor from the [factor matrix](https://github.com/workato-devs/seven-factors) by changing exactly one layer between a flawed Genie and a fixed one:

| Station | Factor | Docs | Server folder |
|---|---|---|---|
| A | II: Deterministic Mutations | [`docs/station-a/`](docs/station-a/README.md) | `Dewy Bank Station A` |
| B | III: Intent-Based Communication | [`docs/station-b/`](docs/station-b/README.md) | `Dewy Bank Station B` |
| C | IV: Bounded Access | [`docs/station-c/`](docs/station-c/README.md) | `Dewy Bank Station C` |

The bank itself (the AWS side: CDK stack, Lambdas and the web app) lives in [`infra/`](infra/README.md), moved here from `dewy-bank-internal` on 2026-10-20. The changes the stations need are in [`docs/backend-requirements.md`](docs/backend-requirements.md), the work plan for `infra/`.

## Layout

```
dewy-bank/
├── README.md                              # this file
├── AGENTS.md                              # project-wide rules for agents
├── .wk/wk.toml                            # the one sync config (link your own profile)
├── .wklintrc.json                         # strict lint profile, for every station
├── workspace-connections/                 # synced: Workspace Connections (pushed first)
│   ├── dewy_bank_customer_api.custom_adapter.{json,rb}   # the custom connector (signs in as the participant)
│   ├── dewy_bank_customer_api.connection.json            # the customer tools' connection (every station)
│   ├── dewy_bank_support_api.custom_adapter.{json,rb}    # the Support API connector (one support code)
│   └── dewy_bank_support_api.connection.json             # Station C's support tools' connection
├── dewy-bank-station-a/                   # synced: Dewy Bank Station A (Workato assets only)
├── dewy-bank-station-b/                   # synced: Dewy Bank Station B (Workato assets only, generated)
├── dewy-bank-station-c/                   # synced: Dewy Bank Station C (Workato assets only, generated)
├── docs/
│   ├── station-a/                         # README, AGENTS.md, FEEDBACK.md, genie-instructions.md
│   ├── station-b/                         # README, AGENTS.md, REQUIREMENTS.md, genie-instructions.md
│   ├── station-c/                         # README, AGENTS.md, REQUIREMENTS.md, genie-instructions.md
│   ├── backend-requirements.md            # the backend changes: the work plan for infra/
│   ├── factor-matrix.md                   # the station design: factor → flaw → fix
│   ├── memo-list.md                       # every transaction memo, including the shared payload
│   └── history/                           # superseded docs, kept because infra/ comments cite them
├── infra/                                 # not synced: the bank (CDK stack, Lambdas, web app)
└── scripts/                               # build_station_b.py, check_invariants.py, build_station_c.py, check_station_c.py, stamp_bank_app_url.py, setup_chat_clients.py, templates/
```

`.wk/wk.toml` has four `[[sync]]` entries. Each one maps a top-level server folder to a root-level local folder of the same name in kebab-case. Nothing is nested, so `zip_name` paths like `Workspace Connections/dewy_bank_customer_api.connection.json` resolve the same way locally and on the server. Synced folders hold only Workato assets.

| Server folder | Local path |
|---|---|
| `Dewy Bank Station A` | `dewy-bank-station-a` |
| `Dewy Bank Station B` | `dewy-bank-station-b` |
| `Dewy Bank Station C` | `dewy-bank-station-c` |
| `Workspace Connections` | `workspace-connections` |

On the server, the station folders sit next to each other and next to `Workspace Connections`, with no parent folder. Connection names are unique per workspace, so the stations don't each carry a `connections/` folder. Every Station A and B recipe points at `Workspace Connections/dewy_bank_customer_api.connection.json`.

## Setup

Run every `wk` command from this directory.

**Before the workshop (facilitator, once per deployment):** stamp the bank app's URL into the customer connector, so participants never type deployment details:

```bash
python3 scripts/stamp_bank_app_url.py https://<bank app host>
```

It writes the URL into both connectors (`workspace-connections/dewy_bank_customer_api.custom_adapter.rb` and `dewy_bank_support_api.custom_adapter.rb`) and bumps each one's version note, so the push carries the change. An unstamped connector refuses to connect, with a message telling the participant to ask their facilitator.

1. **Authenticate and link:**
   ```bash
   wk auth login --token <token> --environment <env>
   wk link --profile <your-profile>
   ```
   Check the account behind a profile with `wk workspace info -p <profile>`; profile names can point at someone else's workspace.
2. **Know what the first push creates.** In a blank workspace, `wk push` creates four top-level folders, in this order: `Workspace Connections` (holding the `Dewy Bank Customer API` custom connector and its connection, and the `Dewy Bank Support API` connection), then `Dewy Bank Station A`, `Dewy Bank Station B` and `Dewy Bank Station C`. The order matters. wk imports one sync entry at a time, in `wk.toml` order, and the stations' recipes only bind to the connection if it already exists. So `Workspace Connections` stays the first `[[sync]]` entry.

   If your workspace already has a `Workspace Connections` folder that other apps use, that's fine too: the push only adds the Dewy files. Don't `wk pull` that folder, which would add other apps' files to this project. (Deleting a file locally doesn't delete it on the server: `wk push` reports it as `deleted`, but the asset stays. Clean up obsolete server assets yourself.)
3. **Lint, then preview the push:**
   ```bash
   wk lint --skills-path <path-to>/recipe-skills/skills $(find dewy-bank-station-* -name '*.recipe.json')
   wk push --dry-run
   ```
   Read the dry run before every push. If wk's pre-push `recipe-lint` hook fails with `FILE_READ_ERROR` on a recipe you deleted locally, that's the hook linting a file queued for deletion: run the lint above, then push once with `--skip-hooks`.
4. **Push:** `wk push`. Push through the project like this, not with `wk recipes import`, which strips HTTP action config. Verified 2026-10-20 in an emptied workspace: one `wk push` creates the three folders, the connection(s) and every recipe, each recipe bound to its connection. A push also creates and releases the custom connector when the workspace doesn't have it, and updates it when it does. If a recipe ever comes back unbound (`wk recipes get <id> --json`, `config`), re-push that station once with `wk push --force --folder "<server folder>"`. The same applies if the `Workspace Connections` folder (or its connection) is deleted on the server: the stations' recipes lose their connection, and a plain `wk push` won't rebind them, because their files are unchanged. Push the connection first, then force-push each station.
5. **Connect the `Dewy Bank Customer API` connection** once, in the Workato UI (`Workspace Connections`): the participant enters **only their own Dewy Bank email and password**, the same login they use in the bank app. Every customer tool at every station uses it, as the participant. The connector finds everything else itself (the Cognito region and app client ID, and the customer API URL) in the bank app's `config.json`, signs in, and renews its token when it expires.
6. **Set up chat with the bank app** (once per participant):
   ```bash
   python3 scripts/setup_chat_clients.py -p <your-profile>
   ```
   It creates your chat identity (no invitation email), starts the six customer-facing Genies, gives each one a chat client, and prints one blob. Paste the blob into the bank app's chat settings. Lost it? Run the script again: it issues fresh keys and prints a new blob. (The bank app's chat panel is backend item P8, not built yet.)
7. **Per station:** start the recipes. See [`docs/station-a/`](docs/station-a/README.md#setup), [`docs/station-b/`](docs/station-b/README.md#setup) and [`docs/station-c/`](docs/station-c/README.md#setup) (which also authorizes the `Dewy Bank Support API` connection).

Station C's support tools use a second connector, `Dewy Bank Support API`: participants paste one **support code** from the facilitator (the scoped support-agent key, `docs/backend-requirements.md` C-P3), and the connector discovers the rest the same way. Its setup is in Station C's README. The old full-access Admin API isn't used by any station and is being retired (P7).
