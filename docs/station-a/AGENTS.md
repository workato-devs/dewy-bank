# AGENTS.md: rules for agents working on Station A

This is a teaching sample. Its whole job is to show that **one factor changes while everything else stays the same**. Most "small improvements" break that. Read `README.md` and `FEEDBACK.md` before you edit anything.

## Invariants (don't break these)

1. **Everything the model sees is identical across A1 and A2.** That covers the skill `name`, `trigger_description`, trigger `input.description`, `parameters_schema_json`, `result_schema_json`, `requires_user_confirmation`, the Genie `instructions`, `ai_provider` and `ai_model`. If you change one variant, make the same change in the other.
2. **The variant lives where only participants see it:** folder names, Genie names and descriptions, recipe `description`, and step comments. Never in tool names, tool descriptions or parameter hints.
3. **Tool names describe the customer's job**, not the implementation or the variant: `move_between_my_accounts`, not `transferFunds_safe`.
4. **No backend identifiers cross the tool boundary.** Customer-facing names go in, plain-language outcomes come out. `accountId` and `customerId` stay inside the recipe.
5. **No access rules or limits in the Genie instructions.** That's prompt-as-ACL, which is Station C's flaw. Edit `docs/station-a/genie-instructions.md`, never the Genie JSON directly.
6. **Scope comes from the credential.** Every tool calls only the `Dewy Bank Customer API` connector, which acts as the participant, and the customer API scopes every route to them. No tool uses the Admin API, and there's no `customer_id` stand-in. Don't add ownership checks to recipes to make up for anything: the credential is the boundary.
7. **The A2 rules are deterministic recipe steps:** four write rules (`move_between_my_accounts`) and two read rules (`review_my_recent_activity`: one named account, at most 20 entries). Don't move them into the prompt or the tool description, and don't add decision logic to A1: its recipes only map the request onto the API call.
8. **Memos pass through unchanged, in every variant.** `note` goes to the bank exactly as written, and activity returns `description` exactly as stored. Filtering or rewriting memos in one variant would add a second variable and hide the attack channel.
9. **Request bodies are built as a hash with `.to_json`** (`={'from' => …, 'memo' => …}.to_json`), never by joining strings. The note is free text from the model, and `.to_json` escapes it.

## Station B is generated from Station A

`scripts/build_station_b.py` copies Station A's `shared/` tool, A2's `review_my_recent_activity` and `move_between_my_accounts`, and the Genie instructions into Station B. `scripts/build_station_c.py` copies the same three customer tools into Station C. After you change any of them, rebuild Stations B and C and run `scripts/check_invariants.py` and `scripts/check_station_c.py`.

## Conventions

- File names: `{snake_case_name}.{asset_type}.json`. Recipe name = skill name.
- Step aliases (`as`) describe the step (`lookup_source_account`, `refuse_over_limit`). Uuids are the alias in kebab-case plus the step number, e.g. `refuse-over-limit-021`.
- Renaming an alias means updating every datapill `line` that references it, plus any `"<uuid>:<alias>"` reference (`insert_to_list.name`, `update_variables.name`).
- Cross-asset references use `zip_name: "<folder>/<file>"` and `folder: "<folder>"`, relative to `dewy-bank-station-a/`.
- There is one `wk` project for the whole workshop, at `dewy-bank/`. Don't add a `.wk/` or `workspace-connections/` folder, or any non-asset file (READMEs, scripts), inside a synced folder. Docs go in `docs/station-a/`.
- The connection is shared: every recipe's connector config points at `Workspace Connections/dewy_bank_customer_api.connection.json` (`custom: true`, `folder: "Workspace Connections"`, name `Dewy Bank Customer API`). The connector itself is `workspace-connections/dewy_bank_customer_api.custom_adapter.{json,rb}`. Don't add a per-project `connections/` folder; connection names are unique per workspace, so a second copy fails the import.
- When you change the connector's `.rb`, change its `.custom_adapter.json` too (e.g. its `note`), or the push fails with "Package doesn't contain any assets".
- **Deleting a file locally doesn't delete it on the server.** `wk push` reports it as `deleted`, but the server asset stays (observed twice, 2026-10-20). Delete obsolete recipes yourself (`wk recipes delete <id>`); skills and connectors can only be deleted in the Workato UI. Check `wk push --dry-run` before every push.
- Comments on control-flow steps start with `FLAW` or `FIX` when they mark a teaching point.

## Workflow

```bash
# from the workshop root (dewy-bank/), which holds the one .wk/wk.toml
wk lint --skills-path <path-to>/recipe-skills/skills $(find dewy-bank-station-* -name '*.recipe.json')   # strict, via .wklintrc.json
wk push --dry-run -p <profile>   # read it for `deleted` rows
wk push -p <profile>             # project sync; never `wk recipes import` (it strips HTTP config)
```

Pass `-p <profile>` explicitly on every `wk` command. Don't rely on the active profile.

Known lint noise:
- `ACTION_NAME_UNVERIFIED` (info) for `workato_skill` and the custom connector: no lint rules exist for those providers.
- wk's pre-push `recipe-lint` hook fails with `FILE_READ_ERROR` on a recipe you deleted locally (it lints files queued for deletion). Run the strict lint yourself, then push with `--skip-hooks` once.
- `EIS_NAME_MATCH` on `declare_list.list_items`: this is the server-export and golden-recipe shape, so the warning is a false positive.
