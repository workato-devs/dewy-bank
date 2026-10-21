# Dewy Bank

A hands-on workshop on securing AI agents. Participants chat with Workato Genies that act on a mock retail bank, attack them, and then see which architecture change stops each attack. The fix is never a better prompt.

The workshop has three stations, one per [Seven Factors](https://github.com/workato-devs/seven-factors) principle. Each station pairs a flawed Genie with a fixed one that differs in exactly one layer, so participants can say which factor stopped the attack:

| Station | Factor | Flawed variant | Fixed variant | Docs |
|---|---|---|---|---|
| A | II: Deterministic Mutations | the agent decides what a write does | the recipe's rules decide | [`docs/station-a/`](docs/station-a/README.md) |
| B | III: Intent-Based Communication | tools wrap the raw API and leak internal IDs | intent-shaped tools return names and amounts only | [`docs/station-b/`](docs/station-b/README.md) |
| C | IV: Bounded Access | one Genie holds customer and staff tools, guarded by its prompt | each role gets its own Genie and credential | [`docs/station-c/`](docs/station-c/README.md) |

Every station uses the same attack: one shared memo on an incoming payment ([`docs/memo-list.md`](docs/memo-list.md)), read by the Genie when the participant asks about their activity. The design behind the stations is in [`docs/factor-matrix.md`](docs/factor-matrix.md).

> **The bank is deliberately flawed.** Its APIs make no business decisions by design (the recipes do), so a caller that skips the Workato layer gets no rules at all. Deploy it only to a sandbox AWS account with no real data, and tear it down after the workshop.

## What's in this repo

```
dewy-bank/
├── infra/                     # the bank: AWS CDK stack, Lambdas, the bank app and facilitator console
├── workspace-connections/     # Workato: the two custom connectors and their connections (pushed first)
├── dewy-bank-station-a/       # Workato: Station A's recipes, skills and Genies
├── dewy-bank-station-b/       # Workato: Station B (generated from A by scripts/build/build_station_b.py)
├── dewy-bank-station-c/       # Workato: Station C (generated from A by scripts/build/build_station_c.py)
├── docs/                      # station guides, the design, the shared memo, the backend spec
├── scripts/                   # workshop tools: connector stamping (facilitator), chat setup (participant)
│   └── build/                 # content build: the station builders and invariant checks (authors and CI only)
├── .wk/wk.toml                # the one wk sync config (link your own profile)
└── .github/workflows/         # CI for infra/ and the stations, and the infra deploy
```

- **The bank** ([`infra/`](infra/README.md)): a Customer API (Cognito sign-in), a Support API (one shared support code, reaching only three fictional customers), a chat proxy to each participant's Genies, the bank app with its chat panel, and a facilitator console. What the stations need from it is specified in [`docs/backend-requirements.md`](docs/backend-requirements.md).
- **The Workato project**: one `wk` CLI project for the whole workshop. Each synced folder is a top-level server folder of the same name in kebab-case (`Dewy Bank Station A` is `dewy-bank-station-a/`). `Workspace Connections` must stay the first `[[sync]]` entry, so the stations' recipes bind to its connections. Rules for changing anything here are in [`AGENTS.md`](AGENTS.md).

## Running a workshop (facilitator)

1. **Deploy the bank** to your own AWS account. See [`infra/README.md`](infra/README.md):
   ```bash
   cd infra && npm ci
   npx cdk bootstrap --profile <your-profile>          # once per account and region
   npx cdk deploy DewyBank-<workshopId> -c workshopId=<workshopId> --profile <your-profile>
   ```
   The `SpaUrl` output is the bank app. The fictional customers (Jane, Omar and Mei) are created during the deploy.
2. **Stamp the bank app's URL into the connectors**, so participants never type deployment details:
   ```bash
   python3 scripts/stamp_bank_app_url.py <SpaUrl>
   ```
   Share that stamped copy with participants, for example as a workshop branch or fork. An unstamped connector refuses to connect and tells the participant to ask their facilitator.
3. **Get the support code** for Station C. It's the Support API key, safe to hand out because it only reaches the support routes and the fictional customers:
   ```bash
   aws ssm get-parameter --with-decryption --query Parameter.Value --output text --profile <your-profile> \
     --name "$(aws cloudformation describe-stacks --stack-name DewyBank-<workshopId> --profile <your-profile> \
       --query "Stacks[0].Outputs[?OutputKey=='SupportApiKeyParamName'].OutputValue" --output text)"
   ```
4. **Make yourself a facilitator.** Sign up in the bank app, then add yourself to the `facilitators` group ([`infra/README.md`](infra/README.md#commands)). The console is at `<SpaUrl>/admin.html`. It shows a live leaderboard, the fictional customers' support activity, transfers with a note, and **Reset**, which restores the whole workshop or one participant between stations.

## Setting up (participant)

Each participant works in their own Workato workspace and their own bank login. Run every `wk` command from the repo root.

1. **Sign up in the bank app** (`SpaUrl`) with your email.
2. **Link the project and push it:**
   ```bash
   wk auth login --token <token> --environment <env>
   wk link --profile <your-profile>
   wk push --dry-run      # read it first
   wk push
   ```
   Check which account a profile points at with `wk workspace info -p <profile>`. Push through the project, not with `wk recipes import`, which strips HTTP action config.
3. **Connect `Dewy Bank Customer API`** in the Workato UI (`Workspace Connections`): enter only your bank email and password. The connector finds everything else in the bank app's `config.json`.
4. **Set up chat:**
   ```bash
   python3 scripts/setup_chat_clients.py -p <your-profile>
   ```
   It starts the six customer-facing Genies, gives each one a chat client, and prints one block of setup text. In the bank app, open **Ask Dewy → Set up chat** and paste it. Lost it? Run the script again for fresh keys.
5. **Per station:** start the recipes, then pick the station in the chat panel. See each station's guide; Station C also connects `Dewy Bank Support API` with the support code.

## Developing

- **Workato stations:** Stations B and C are built from Station A by `scripts/build/`, so each differs from A in exactly one layer. To change the workshop content, change Station A or a builder, rebuild, and commit the result; the steps are in [`AGENTS.md`](AGENTS.md#before-you-change-a-station-content-authors). CI rebuilds the stations on every pull request, fails if the committed files are stale, and runs the invariant checks. None of this is part of running the workshop.
- **The bank:** `cd infra && npm ci && npm test` runs the stack assertions and handler tests; `npx cdk synth` needs no AWS credentials. CI runs both on every pull request.
