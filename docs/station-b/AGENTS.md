# AGENTS.md: rules for agents working on Station B

This is a teaching sample. Its whole job is to show that **one factor changes while everything else stays the same**. Most "small improvements" break that. Read `README.md`, `REQUIREMENTS.md` and `docs/station-a/FEEDBACK.md` before you edit anything.

## `dewy-bank-station-b/` is generated

`scripts/build/build_station_b.py` deletes and rewrites `dewy-bank-station-b/` from `dewy-bank-station-a/`. Never hand-edit the generated JSON; the next build overwrites it.

- **A change to the shared logic** (scope checks, the rule block, the B2 interface) goes into **Station A**, then you rebuild. Station A and Station B stay in lockstep that way.
- **A change to the B1 interface or to Station B's labels** goes into `build_station_b.py`.
- After every build: `python3 scripts/build/check_invariants.py`, then strict `wk lint`.
- **A change to the MCP servers** (names, tools, the server description) goes into `mcp-servers.md`, then into the servers by hand. The builder doesn't generate them, and `check_invariants.py` doesn't check them.

## Invariants (don't break these)

1. **Only Factor III differs between B1 and B2.** That means the tool interface (description, parameters, result schema), the name→ID resolution condition, and the steps that shape output. Nothing else.
2. **The rules are Station A2's, step for step**, in both variants: the write rule block and the two read rules, with the same conditions, aliases, uuids and comments. Only the steps that shape output differ (the return steps, and the activity list B1 keeps as raw rows).
3. **Scope comes from the credential in both variants:** every tool calls only the `Dewy Bank Customer API` connector, as the participant. No Admin API, no `customer_id`. B1 looks up the model's `accountId` among the participant's own accounts.
4. **Identical in B1 and B2:** tool names, `requires_user_confirmation` (`false` everywhere), the `amount` and `note` parameters, `pay_someone` (A2's, saved-payee rule included, P11), the MCP server description ([`mcp-servers.md`](mcp-servers.md)) and the model of the bank app's agent.
5. **Backend detail appears only in B1's tool descriptions and results**, never in the MCP server description.
6. **The variant is visible only to participants:** folder names, recipe `description`, and step comments. Never in the MCP server names (`StationB1`, `StationB2`), which the model sees.
7. **Memos pass through unchanged, in every variant.** `note` goes to the bank as `memo` exactly as written. B1 returns `memo` as stored, and B2 returns it as `description`.
8. **Request bodies are built as a hash with `.to_json`**, never by joining strings.

## Conventions

The same as `docs/station-a/AGENTS.md`: snake_case file names, recipe name = skill name, descriptive aliases, uuids made of the kebab-case alias plus the step number. `FLAW` / `FIX` / `STAND-IN IDENTITY` comments mark teaching points. At Station B, `FIX` and `FLAW` mean Factor III. The copied rule block is labeled "Rule N (Factor II held good)".

## Connection

Station B shares Station A's connection: `Workspace Connections/dewy_bank_customer_api.connection.json` (the custom connector), inherited by the generator. Don't add a `connections/` folder. There is one `wk` project for the whole workshop, at `dewy-bank/`. Deleting a file locally doesn't delete it on the server (`wk push` reports `deleted`, but the asset stays), so clean up obsolete server assets yourself. Check `wk push --dry-run` before every push.

## Workflow

```bash
python3 scripts/build/build_station_b.py && python3 scripts/build/check_invariants.py
# then from the workshop root (dewy-bank/), which holds the one .wk/wk.toml
wk lint --skills-path <path-to>/recipe-skills/skills $(find dewy-bank-station-* -name '*.recipe.json')   # strict, via .wklintrc.json
wk push --dry-run -p <profile>   # read it for `deleted` rows
wk push -p <profile>             # project sync; never `wk recipes import` (it strips HTTP config)
```

Known lint noise: `ACTION_NAME_UNVERIFIED` (info) for `workato_skill` and the custom connector, and `EIS_NAME_MATCH` on `declare_list.list_items` (a false positive; see Station A).
