# AGENTS.md: rules for agents working on Station C

This is a teaching sample. Its whole job is to show that **one factor changes while everything else stays the same**. Read `README.md`, `REQUIREMENTS.md` and `docs/station-a/FEEDBACK.md` before you edit anything.

## `dewy-bank-station-c/` is generated

`scripts/build_station_c.py` deletes and rewrites `dewy-bank-station-c/`: the customer tools from `dewy-bank-station-a/`, the support-agent tools from the script itself, and the Genie instructions from `docs/station-a/genie-instructions.md` and `docs/station-c/genie-instructions.md`. Never hand-edit the generated JSON.

- **A change to the customer tools** goes into **Station A**, then you rebuild Stations B and C.
- **A change to the support tools, the Genies or Station C's labels** goes into `build_station_c.py`.
- **A change to the instructions** goes into the `genie-instructions.md` files.
- After every build: `python3 scripts/check_station_c.py`, then strict `wk lint`.

## Invariants (don't break these)

1. **Only Factor IV differs between C1 and C2:** which Genie holds which skills, and the instructions. All five tools live once, in `shared/`, and are identical in both variants. Never give a variant folder recipes of its own.
2. **The instructions are composed, not hand-written.** C1 = the customer text + the support-duties sentence + the access rule. C2's customer Genie = the customer text only. C2's support Genie = the support text only.
3. **The access rule (the passphrase) exists only in C1's instructions.** No other Genie, at any station, carries an access rule or a limit.
4. **Scope comes from credentials.** Customer tools use only the `Dewy Bank Customer API` connector; support tools use only the `Dewy Bank Support API` connector (the scoped support-agent key, pasted as a support code). Nothing uses the full Admin API, `customer_id`, or a facilitator route.
5. **The rules are deterministic recipe steps** (Factor II held good): the customer tools carry Station A2's read and write rules; `issue_goodwill_credit` carries its own three credit rules. The Support API makes no business decision.
6. **The interface is held good** (Factor III): customers by email, accounts by name, plain-language outcomes. No IDs or routes in tool names, descriptions, parameters or results.
7. **Genie names are at most 35 characters**, or the import fails.

## Conventions

The same as `docs/station-a/AGENTS.md`. At Station C, `FLAW` and `FIX` mean Factor IV, and they live in the Genie descriptions (participants see them); the tools carry "held good" comments for Factors II and III.

## Workflow

```bash
python3 scripts/build_station_c.py && python3 scripts/check_station_c.py
# then from the workshop root (dewy-bank/)
wk lint --skills-path <path-to>/recipe-skills/skills $(find dewy-bank-station-* -name '*.recipe.json')
wk push --dry-run -p <profile>
wk push -p <profile>
```
