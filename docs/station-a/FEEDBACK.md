# Station A review: feedback for the author agent

**For:** the agent that built `alex-dewy-bank-station-a` (the original export)
**Result:** this project (`dewy-bank-station-a`), rebuilt from that export
**Checked against:** the Dewy Bank factor matrix ([`docs/factor-matrix.md`](../factor-matrix.md)), the Admin API handler, recipe-skills conventions and `wk lint` (recipe-lint 1.2.0, strict profile)

## Read this first

Your recipes worked, and your step comments were clear. The problems are mostly about **what the station is meant to teach**, not JSON syntax.

Station A has one job: show that **Factor II (Deterministic Mutations)** is the only thing that changed between the flawed Genie and the fixed one. The factor matrix's design rule is *one station = one factor = one flaw = one fix*. The other two layers (III, the interface, and IV, the scope) must be **identical and good** in both variants. Otherwise participants can't say which factor stopped the attack, and the station teaches nothing.

The build teams are still learning the seven factors, and they learn them from samples like this one. So treat every name, description and schema in a sample as part of the lesson.

Each finding below has three parts: what we saw, why it matters, and what to do next time. The last section is a checklist.

---

## 1. The tool interface broke Factor III, and it differed between variants (most important)

**What we saw**

- Tools were named for the build, not the job: `station_a_listMyAccounts`, `station_a_transferFunds_flawed`, `station_a_transferFunds_safe`. **The model reads the tool name.** You were telling the model which tool was "flawed" and which was "safe".
- The fixed tool's description and `amount` hint spelled out the rules: "refused unless both accounts belong to the customer… $500 or less", "maximum 500". The flawed tool's didn't.
- Inputs were raw backend account IDs (`fromAccountId`, `toAccountId`). Outputs returned `accountId` and `customerId`, and passed the Admin API's response through unchanged.

**Why it matters**

- *Different interfaces mean two variables, not one.* If the fixed tool tells the model the rules, the model can follow them by itself. A refused over-limit transfer might be the model being careful, not the recipe enforcing anything. The demo stops proving Factor II.
- *Names prime the model.* A tool called `_flawed` or `_safe` invites the model to act differently. Participants could also read the tool list and work out the answer.
- *Raw IDs in and backend rows out is Station B's staged flaw* ("Wrapped API as tool", "Leaky response"). Factor III says: tool boundaries follow intent, not implementation; contextual identifiers in, domain outcomes out. By breaking III at Station A, you mixed Stations A and B together, which is exactly what the matrix was written to prevent.

**What to do next time**

- Name tools for the customer's job: `list_my_accounts`, `move_between_my_accounts`. That matches the name the factor matrix uses. No station prefix, no implementation verbs, no variant label.
- Make everything the model sees **byte-identical** across variants: name, description, parameters, result schema, confirmation setting, Genie instructions, model.
- Show the variant only where **participants** look: folders (`a1_flaw_agent_owns_the_write/`, `a2_fix_recipe_owns_the_write/`), Genie names and descriptions, recipe descriptions, step comments.
- Let the fixed variant communicate its rules **when it refuses** ("Nothing was moved: transfers are limited to $500 each"), not in its description.
- Use names the customer recognizes ("Everyday Checking") as inputs, and resolve them to IDs inside the recipe. Return outcomes ("Moved $200.00 from High-Yield Savings to Everyday Checking."), never internal IDs.

**What we changed:** all of the above. A1 and A2 now differ only in the four-rule block inside `move_between_my_accounts`. See the README diagram.

## 2. Other differences between the variants

**What we saw**

- The Genie instructions differed by a trailing space (`"assistant. "` vs `"assistant."`).
- The skill references were in a different order in each Genie.
- The flawed source lookup didn't use `ignore_http_errors`, so a bad account crashed the job, while the fixed one returned a refusal.

**Why it matters:** each one is small, but each is a second variable. When a result surprises you in the room, you want to rule out everything except the factor under test.

**What to do next time:** keep shared text in one file and generate both Genies from it (`docs/station-a/genie-instructions.md` now does this). Build both variants from the same steps and change only the factor's block. Diff the two before you ship.

## 3. The fixed check didn't fail closed

**What we saw:** the `customer_id` project property was `null` in the export. The fixed recipe looked up both accounts with `ignore_http_errors: true` and compared `response.customerId` to `customer_id`. If the property isn't set and the IDs don't exist, both sides are nil, the comparison probably passes, and the recipe calls `/admin/transfer`.

**Why it matters:** the fix is supposed to show a control plane you can trust. A control plane that allows a write when it's missing its own configuration is the anti-pattern the fix exists to replace.

**What to do next time:** every authorization-style check needs a `present` condition on both sides before an `equals_to`. Ask yourself: "If this setting were empty, would the check allow or refuse?" It should always refuse.

**What we changed:** every ownership check now requires `customer_id` to be present, the account to have an owner, and the two to match.

## 4. The fix was missing rules it claimed to cover

**What we saw:** the fixed recipe checked `amount.to_f <= 500` but not `amount > 0`. A negative amount or a missing one (nil becomes `0.0`) passed. The Admin API rejects these with a 400, but that means the API is doing the validation, not the recipe. There was also no balance check.

**Why it matters:** Factor II says the control plane validates. If the recipe depends on the API to catch what it missed, the demo is really showing the API.

**What to do next time:** write the rule list first (here: different accounts, positive amount, limit, sufficient balance), then make one deterministic step per rule, each with its own refusal message.

**What we changed:** A2 has four nested rules, each a separate `if` with a `FIX rule N` comment and its own refusal.

## 5. The request body was built by string interpolation

**What we saw:** the transfer body was a JSON string with datapills dropped into it (lint `DP_FORMULA_CONCAT`). The account IDs came straight from the model.

**Why it matters:** a `"` in a model-supplied value can add or override JSON fields. That turns a teaching flaw into an accidental one.

**What to do next time:** build bodies in formula mode. Only put values in them that the recipe itself resolved, and coerce numbers (`.to_f.to_s`).

**What we changed:** the IDs now come from the recipe's own account lookup. The body is a hash serialized with `.to_json`, with the amount coerced to a number. That matters even more now that the tool takes a free-text `note`: `.to_json` escapes it, where joining strings would not.

## 6. Errors reached the Genie as job failures

**What we saw:** the transfer call had no try/catch, so a 400 or 409 from the bank failed the job.

**Why it matters:** the model gets an opaque error instead of an outcome it can explain, and participants see a stack trace instead of the behavior you meant to show.

**What to do next time:** wrap every write in try/catch and return the same typed result shape (`status: failed` plus a message) as the success and refusal paths.

## 7. Descriptions and comments didn't match the logic

**What we saw:**

- The broken Genie's description said "the transfer tool has no validation", but the source-ownership check was there by design.
- A return-step comment said it "keeps only accounts for the fixed customer ID below", but the filtering happened earlier.

**Why it matters:** facilitators and the next agent read these first. Wrong descriptions cost more than missing ones.

**What to do next time:** write descriptions last, from the finished logic, and re-read every comment after you move a step.

## 8. Metadata and structure

| What we saw | Why it matters | What to do next time |
|---|---|---|
| `make_request_v2` steps had only `response` in `extended_input_schema` (strict lint: 17 `EIS_MIRRORS_INPUT` errors) | Inputs missing from the EIS can be silently dropped on import. recipe-skills requires `request` and `response` with `override: true` | Follow `recipe-skills/.../adhoc-http-actions.md`. Run `wk lint` with `--skills-path` before every push |
| Random v4 uuids and aliases like `make_request_v2_5355` | Unreadable diffs, and agents can't tell what a datapill points to | Descriptive aliases (`get_all_accounts`, `refuse_over_limit`) and kebab-case uuids with the step number |
| Naming mixed camelCase, kebab-case and lowercase; two vocabularies (broken/fixed and flawed/safe) | Nothing is predictable, for people or agents | snake_case asset names, one vocabulary (flaw/fix, matching the matrix) |
| Empty `project.json` description; connection with no setup notes | Whoever imports this has nothing to go on | Fill in project metadata; document the connection's base URL and auth in the README (never the secret) |
| Every asset flat at the project root, no README, AGENTS.md or lint config | It doesn't look like a sample and can't be copied for Stations B and C | Use the layout in this project: container, then `station_a/`, then `connections/`, `shared/`, one folder per variant |
| Tool description kept in both `trigger_description` and the recipe trigger's `input.description` | They drift apart, and the UI reads the recipe | Treat the recipe trigger as the source of truth and generate the skill file's copy from it |

## 9. Tooling: use it, and use it in this order

You built this without the `wk` CLI, recipe-lint or recipe-skills. Most of findings 3–8 would have shown up on their own:

1. **recipe-skills** before writing: connector patterns, the EIS rules, the descriptive-uuid convention.
2. **`wk lint --skills-path … `** (strict) after every change.
3. **`wk diff`, then `wk push`** through the project (not `wk recipes import`, which strips HTTP config), with `-p <profile>` set explicitly.

---

## Checklist for the next station

- [ ] Everything the model sees is byte-identical across variants: tool names, descriptions, parameters, results, instructions, model.
- [ ] Tool names describe the customer's job. No station, variant or implementation words.
- [ ] Inputs are names the customer knows; outputs are outcomes. No backend IDs either way.
- [ ] The variant is visible only in folders, Genie names and descriptions, recipe descriptions and comments.
- [ ] The rule list is written down, and each rule is its own deterministic step with its own refusal.
- [ ] Every check fails closed (`present` on both sides before comparing).
- [ ] Every write is in try/catch, and every path returns the same typed result.
- [ ] No access rules in the Genie instructions.
- [ ] Strict `wk lint` is clean (known noise is listed in AGENTS.md); `wk diff` reviewed before push.
- [ ] README updated: what's held constant, the test script, what the fix does NOT stop.

## Still open (not decided in this rebuild)

- The identity model: `customer_id` is a stand-in; the Genie's `context.user_email` is the likely replacement.
- `adjustBalance` ("minting money" in the matrix) isn't part of this project.
- No dedicated audit record on the A2 write path.
- This project hasn't been live-tested. On the first push, check:
  - whether two skills can share the name `move_between_my_accounts` in different folders;
  - whether the formulas evaluate as expected.
