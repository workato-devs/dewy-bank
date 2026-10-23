# AGENTS.md: rules for agents working on Station C

This is a teaching sample. Its whole job is to show that **one factor changes while everything else stays the same**. Read `README.md`, `REQUIREMENTS.md` and `docs/station-a/FEEDBACK.md` before you edit anything.

## `dewy-bank-station-c/` is generated

`scripts/build/build_station_c.py` deletes and rewrites `dewy-bank-station-c/`: the customer tools from `dewy-bank-station-a/`, the support-agent tools from the script itself. Never hand-edit the generated JSON.

- **A change to the customer tools** goes into **Station A**, then you rebuild Stations B and C.
- **A change to the support tools or Station C's labels** goes into `build_station_c.py`.
- **A change to a server's tools or description** goes into `docs/station-c/mcp-servers.md`, then into the server itself (`wk mcp servers update`). The servers aren't files: `wk push` doesn't create them.
- After every build: `python3 scripts/build/check_station_c.py`, then strict `wk lint`.

## Invariants (don't break these)

1. **Only Factor IV differs between C1 and C2:** which MCP server holds which tools, and the server descriptions. All six tools live once, in `shared/`, and are identical in both variants. Never add a variant folder or recipes of its own.
2. **The descriptions are composed, not hand-written.** `StationC1` = the customer text + the support-duties sentence + the access rule. `StationC2 Customer` = the customer text only (Station A's). The one copy is `mcp-servers.md`.
3. **The access rule (the passphrase) exists only in `StationC1`'s description.** No other server, at any station, carries an access rule or a limit.
4. **Scope comes from credentials.** Customer tools use only the `Dewy Bank Customer API` connector; support tools use only the `Dewy Bank Support API` connector (the scoped support-agent key, pasted as a support code). Nothing uses the full Admin API, `customer_id`, or a facilitator route.
5. **The rules are deterministic recipe steps** (Factor II held good): the customer tools carry Station A2's read and write rules, including `pay_someone`'s saved-payee rule (P11); `issue_goodwill_credit` carries its own three credit rules. The Support API makes no business decision. `requires_user_confirmation` is `false` on every tool.
6. **The interface is held good** (Factor III): customers by email, accounts by name, plain-language outcomes. No IDs or routes in tool names, descriptions, parameters or results. A tool's description on a server is its skill's `trigger_description`, never the recipe description.
7. **C2 has no support server.** The support tools are on `StationC1` only; never add a server for them.

**What the checks don't cover:** `check_station_c.py` checks the tools (copies of Station A, one place, credentials, interface). It no longer checks namespaces or descriptions: the servers are set up by hand, and the test script checks them.

## Conventions

The same as `docs/station-a/AGENTS.md`. At Station C, `FLAW` and `FIX` mean Factor IV, and they live in `mcp-servers.md` and the README (participants see them; the server names stay neutral); the tools carry "held good" comments for Factors II and III.

## Workflow

```bash
python3 scripts/build/build_station_c.py && python3 scripts/build/check_station_c.py
# then from the workshop root (dewy-bank/)
wk lint --skills-path <path-to>/recipe-skills/skills $(find dewy-bank-station-* -name '*.recipe.json')
wk push --dry-run -p <profile>
wk push -p <profile>
```
