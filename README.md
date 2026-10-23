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
├── docs/                      # workshop slides, station guides, the design, the shared memo, the backend spec
├── scripts/                   # workshop tools: connector stamping (facilitator), chat setup (participant)
│   └── build/                 # content build: the station builders and invariant checks (authors and CI only)
├── .wk/wk.toml                # the one wk sync config (link your own profile)
└── .github/workflows/         # CI for infra/ and the stations, and the infra deploy
```

- **The bank** ([`infra/`](infra/README.md)): a Customer API (Cognito sign-in), a Support API (one shared support code, reaching only three fictional customers), the bank app with its chat panel, and a facilitator console. The panel's agent connects to the selected station's MCP server. **That agent is planned:** today the panel still talks to Workato Genies through a chat proxy (P8).
- **The Workato project**: one `wk` CLI project for the whole workshop. Each synced folder is a top-level server folder of the same name in kebab-case (`Dewy Bank Station A` is `dewy-bank-station-a/`). Rules for changing anything here are in [`AGENTS.md`](AGENTS.md).
- **The MCP servers**: one per variant, each exposing that variant's recipes as tools: `StationA1`, `StationA2`, `StationB1`, `StationB2`, `StationC1` and `StationC2 Customer`. They aren't files in the synced folders, so `wk push` doesn't create them; `scripts/setup_mcp_servers.py` does, as the deploy script's last step. Each station's `docs/station-<x>/mcp-servers.md` holds its servers' names, tools and descriptions.

## Prerequisites

- A Workato account (trial is fine)
- `wk` CLI installed and on your PATH
- The bank app URL from your facilitator (a CloudFront `https://` URL)
- The support code from your facilitator (needed for Station C)
- A Workato API client token (**Workspace admin → API clients**). Its role needs Projects & folders, Connections, Recipes, Skills, MCP servers, Recipe lifecycle management, Export manifests, Connector SDKs and Workspace details.

## Deploy your Workato workspace

`scripts/deploy_workato.py` does the whole deployment: it stamps the bank URL into the connectors, pushes the Workato assets in order, waits while you connect the two connections, starts the skill recipes, and runs `scripts/setup_mcp_servers.py` to create the six MCP servers. It then waits for the servers' URLs and writes `mcp_conf.json`, the config you paste into the bank app.

**Before running**, copy `.env.example` to `.env` and fill in:

- `WORKATO_API_TOKEN`: your API client's token
- `SPA_URL`: the bank app URL from your facilitator
- `DEWY_SUPPORT_API_KEY`: the support code from your facilitator (or pass `--support-api-key <key>`)

Leave the `A1`–`C2` lines for later. Then create a `wk` profile for your workspace:

```bash
wk auth login --region trial --environment dev --name <profile>
```

**Run the script:**

```bash
python3 scripts/deploy_workato.py -p <profile>
```

**What happens:**

1. The connector files are stamped with the bank URL and API endpoints, and Workspace Connections is pushed.
2. The script pauses and prints your connections URL. Connect both connections (see below), then press Enter.
3. It remaps the connector IDs, rebuilds and pushes the three stations, starts the skill recipes, and restores the working tree.
4. `setup_mcp_servers.py` creates `StationA1`, `StationA2`, `StationB1`, `StationB2`, `StationC1` and `StationC2 Customer`, each in its station's folder, and prints `<server>: N tools, as specified` for each.
5. It pauses again for the servers' URLs. In Workato, open each server, generate a token, and paste its URL (with the token) into `.env` on its line (`A1=` … `C2=`). Press Enter.
6. It writes `mcp_conf.json`. Paste its contents into the bank app's chat (**⚙ Config**). The file holds your MCP tokens, so keep it private.

Without a terminal (a coding agent, or stdin closed), the script exits at each pause instead of waiting. Do the pause's step, then run the script again. At the second pause it exits with status 3; once `.env` has the URLs, run `python3 scripts/setup_mcp_servers.py -p <profile>` to write `mcp_conf.json`.

**If no MCP servers appear:** the MCP step stopped before it created them, most often with `no skill …; push the project first`, because Workato hadn't finished registering the stations' skills. Wait a minute and run `python3 scripts/setup_mcp_servers.py -p <profile>`. It's safe to rerun: it finds each server by name, changes only what differs from `docs/station-*/mcp-servers.md`, and never renews a token.

## Manual authentication step

When the script pauses and shows the connections URL, go to `<your-workato-url>/connections` and authenticate:

- **Dewy Bank Customer API** — enter your bank app email and password (the same credentials you use to log in to the bank app)
- **Dewy Bank Support API** — the key is pre-stamped; just click Connect

Both connections must show **Connected** before you press Enter to continue.

## Workshop stations

Work through the stations in order. Each station guide walks you through the attack and the fix. The workshop slides, with the hacks to try at each station, are at [workato-devs.github.io/dewy-bank/dewy-bank-workshop.html](https://workato-devs.github.io/dewy-bank/dewy-bank-workshop.html) (source: [`docs/dewy-bank-workshop.html`](docs/dewy-bank-workshop.html)).

- [Station A](docs/station-a/README.md) — Factor II: Deterministic Mutations
- [Station B](docs/station-b/README.md) — Factor III: Intent-Based Communication
- [Station C](docs/station-c/README.md) — Factor IV: Bounded Access (also connects the Support API)

In the bank app chat panel, use the station selector to switch between each station's flawed and fixed MCP servers.

## Developing

Stations B and C are generated from Station A by `scripts/build/`, so each differs from A in exactly one layer. To change workshop content, change Station A or a builder, rebuild, and commit the result. The full authoring workflow and Workato project rules are in [`AGENTS.md`](AGENTS.md). The bank app source and infra notes are in [`infra/README.md`](infra/README.md).

## Facilitator setup

Facilitator setup instructions → [docs/FACILITATOR.md](docs/FACILITATOR.md)
