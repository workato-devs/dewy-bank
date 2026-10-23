# Dewy Bank

A hands-on workshop on securing AI agents. Participants chat with the agent in a mock retail bank's app, whose tools are Workato MCP servers acting on the bank. They attack it, and then see which architecture change stops each attack. The fix is never a better prompt.

The workshop has three stations, one per [Seven Factors](https://github.com/workato-devs/seven-factors) principle. Each station pairs a flawed MCP server with a fixed one that differs in exactly one layer, so participants can say which factor stopped the attack:

| Station | Factor                          | Flawed variant                                                        | Fixed variant                                     | Docs                                          |
| ------- | ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| A       | II: Deterministic Mutations     | the agent decides what a write does                                   | the recipe's rules decide                         | [`docs/station-a/`](docs/station-a/README.md) |
| B       | III: Intent-Based Communication | tools wrap the raw API and leak internal IDs                          | intent-shaped tools return names and amounts only | [`docs/station-b/`](docs/station-b/README.md) |
| C       | IV: Bounded Access              | one server holds customer and staff tools, guarded by its description | each role gets its own server and credential      | [`docs/station-c/`](docs/station-c/README.md) |

Every station uses the same attack: one shared memo on an incoming payment ([`docs/memo-list.md`](docs/memo-list.md)), read by the agent when the participant asks about their activity. The design behind the stations is in [`docs/factor-matrix.md`](docs/factor-matrix.md).

> **The bank is deliberately flawed.** Its APIs make no business decisions by design (the recipes do), so a caller that skips the Workato layer gets no rules at all.

## What's in this repo

```
dewy-bank/
├── infra/                     # the bank: AWS CDK stack, Lambdas, the bank app and facilitator console
├── workspace-connections/     # Workato: the two custom connectors and their connections (pushed first)
├── dewy-bank-station-a/       # Workato: Station A's recipes and skills
├── dewy-bank-station-b/       # Workato: Station B (generated from A by scripts/build/build_station_b.py)
├── dewy-bank-station-c/       # Workato: Station C (generated from A by scripts/build/build_station_c.py)
├── docs/                      # station guides, the design, the shared memo, the backend spec
├── scripts/                   # workshop tools: connector stamping (facilitator), chat setup (participant)
│   └── build/                 # content build: the station builders and invariant checks (authors and CI only)
├── .wk/wk.toml                # the one wk sync config (link your own profile)
└── .github/workflows/         # CI for infra/ and the stations, and the infra deploy
```

- **The bank** ([`infra/`](infra/README.md)): a Customer API (Cognito sign-in), a Support API (one shared support code, reaching only three fictional customers), the bank app with its chat panel, and a facilitator console. The panel's agent connects to the selected station's MCP server. **That agent is planned:** today the panel still talks to Workato Genies through a chat proxy (P8).
- **The Workato project**: one `wk` CLI project for the whole workshop. Each synced folder is a top-level server folder of the same name in kebab-case (`Dewy Bank Station A` is `dewy-bank-station-a/`). Rules for changing anything here are in [`AGENTS.md`](AGENTS.md).
- **The MCP servers**: one per variant, each exposing that variant's recipes as tools: `StationA1`, `StationA2`, `StationB1`, `StationB2`, `StationC1` and `StationC2 Customer`. They aren't files in the synced folders, so `wk push` doesn't create them. Each station's `docs/station-<x>/mcp-servers.md` holds its servers' names, tools and descriptions.

## Prerequisites

- A Workato account (trial is fine)
- `wk` CLI installed and on your PATH
- The bank app URL from your facilitator (a CloudFront `https://` URL)
- The support code from your facilitator (needed for Station C)
- Your Workato API token — go to **User menu → Settings → API key** and copy it; add it to a `.env` file at the repo root:
  ```
  WORKATO_API_TOKEN=<your-token>
  ```

## Deploy your Workato workspace

`scripts/deploy_workato.py` handles the full end-to-end deployment: it stamps the bank URL into the connectors, pushes all Workato assets in the right order, waits while you authenticate the connections, starts the skill recipes, configures the chat clients, and prints the JSON blob you paste into the bank app.

> **Not yet updated for MCP servers.** Its last step (`setup_chat_clients.py`) still sets up chat with Genies, which the stations no longer have, so it fails. Until the script creates the MCP servers, create them yourself after the recipes are running: see each station's `mcp-servers.md`.

**Before running**, make sure:

- `wk` CLI is installed and on your PATH
- You have a `wk` auth profile linked to your Workato workspace:
  ```bash
  wk auth login -p <profile>
  ```
- `WORKATO_API_TOKEN` is set in `.env` (see Prerequisites above)
- `DEWY_SUPPORT_API_KEY` is set in `.env` or the environment — your facilitator gives you this value:
  ```
  DEWY_SUPPORT_API_KEY=<support-code>
  ```
  Alternatively, pass it on the command line with `--support-api-key <key>`.

**Run the script:**

```bash
python3 scripts/deploy_workato.py --profile <wk-profile> --bank-url <cloudfront-url>
```

The bank URL can also be set in `.env` as `BANK_APP_URL` instead of passing it each time.

**What happens:**

1. The connector files are stamped with the bank URL and API endpoints.
2. Workspace Connections are pushed to Workato.
3. The script pauses and gives you a URL — open it and authenticate both connections (see below).
4. After you press Enter, it discovers the new connector IDs, rebuilds and pushes all station folders, and starts the skill recipes.
5. `setup_chat_clients.py` runs automatically and prints a JSON blob.

**The one manual step — copy and paste the JSON blob** into the bank app at **Settings → Chat** (or **Ask Dewy → Set up chat**). The JSON is also saved to `.agents/tasks/chat-config.json` in case you need it again; re-running the script regenerates fresh keys.

## Manual authentication step

When the script pauses and shows the connections URL, go to `<your-workato-url>/connections` and authenticate:

- **Dewy Bank Customer API** — enter your bank app email and password (the same credentials you use to log in to the bank app)
- **Dewy Bank Support API** — the key is pre-stamped; just click Connect

Both connections must show **Connected** before you press Enter to continue.

## Workshop stations

Work through the stations in order. Each station guide walks you through the attack and the fix:

- [Station A](docs/station-a/README.md) — Factor II: Deterministic Mutations
- [Station B](docs/station-b/README.md) — Factor III: Intent-Based Communication
- [Station C](docs/station-c/README.md) — Factor IV: Bounded Access (also connects the Support API)

In the bank app chat panel, use the station selector to switch between each station's flawed and fixed MCP servers.

## Developing

Stations B and C are generated from Station A by `scripts/build/`, so each differs from A in exactly one layer. To change workshop content, change Station A or a builder, rebuild, and commit the result. The full authoring workflow and Workato project rules are in [`AGENTS.md`](AGENTS.md). The bank app source and infra notes are in [`infra/README.md`](infra/README.md).

## Facilitator setup

Facilitator setup instructions → [docs/FACILITATOR.md](docs/FACILITATOR.md)
