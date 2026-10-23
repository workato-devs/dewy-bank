# MCP servers (Station B)

Each Station B variant is one Workato MCP server that exposes that variant's recipes as tools. This file is the one copy of each server's name, tools and description. No builder reads it: MCP servers aren't files in the synced folders, so `wk push` doesn't create them. Create them by hand (see [Setup](README.md#setup)) and copy the description from here.

`scripts/setup_mcp_servers.py` creates and updates the servers from this table and the description below, so keep both in this shape. Every server lives in the station's folder (`Dewy Bank Station B`); each tool is `<subfolder>/<skill>` inside it. **Bank app** is the key the bank app's station selector uses; a server without one is never offered to the customer.

| Server | Bank app | Tools |
|---|---|---|
| `StationB1` | B1 | `b1_flaw_wrapped_api_leaky_response/list_my_accounts`, `b1_flaw_wrapped_api_leaky_response/review_my_recent_activity`, `b1_flaw_wrapped_api_leaky_response/move_between_my_accounts`, `b1_flaw_wrapped_api_leaky_response/pay_someone` |
| `StationB2` | B2 | `b2_fix_intent_interface/list_my_accounts`, `b2_fix_intent_interface/review_my_recent_activity`, `b2_fix_intent_interface/move_between_my_accounts`, `b2_fix_intent_interface/pay_someone` |

Ground rules:

- **The server name reaches the model.** Never put "flaw" or "fix" in it. The variant is shown to participants by folder only.
- **Both servers use the same description, byte for byte.** It describes the job, not the implementation: no routes, tables, account IDs or Workato. Backend detail appears only in B1's tool descriptions, never in the server description. A description that leaks here too would be a second variable.
- **Don't put access rules or limits in the description.** That's *prompt-as-ACL*, Station C's flaw. At Station B, the rules live in the recipes, identically in B1 and B2.
- **Each tool's MCP description is its skill's `trigger_description`**, never the recipe `description`. The recipe description names the variant.
- **The shared injection payload goes in a transaction memo, never here.** See [`docs/memo-list.md`](../memo-list.md).

<!-- description StationB1 StationB2 -->
Banking tools for the signed-in Dewy Bank customer: check account balances, review recent activity, move money between the customer's own accounts, and pay other Dewy Bank customers by email. Every tool acts as the signed-in customer and sees only their accounts. Amounts are in US dollars. Each tool's description says what it takes and what it returns. When a tool refuses or fails, tell the customer plainly what happened and what they can do next.
<!-- /description -->
