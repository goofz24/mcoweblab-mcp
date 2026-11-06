# MCO WebLab MCP server + Claude skill

A small [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives Claude tools over MCO WebLab's own data, a set of **read-only IT help desk tools** (computer health check, allowlisted diagnostics, bilingual knowledge base, asset lookup, ServiceNow incident drafts), and a Claude skill for writing bilingual (English and Puerto Rico Spanish) Shopify product descriptions.

Ask Claude *"What would a 5-page Shopify site with Spanish translation cost?"* and it calls `get_quote`, which runs the same pricing code as the quote calculator on mcoweblab.com, and answers *"$950 to $1,190, about 4 weeks. This is a draft estimate..."*. See [docs/demo-runs.md](docs/demo-runs.md) for real recorded runs.

> **Status: local project, not published.** The prices are a draft: only the four starting prices and the $50/month maintenance are approved, and the server says so in every quote. Size charts are sample data, not the MCO Size Guide app's presets.

## What's inside

| Part | What it does |
|---|---|
| `list_services` tool | Services, starting prices, the add-ons each one allows, maintenance. Each price says if it's approved or a draft. |
| `get_quote` tool | Price range, line items and typical timeline for a project. Reuses `calculateQuote()` from the quote calculator, so the website and Claude can never disagree. Returns `isDraft` and the exact draft values it used. |
| `get_size_chart` tool | Apparel size chart in inches or centimeters, in English or Spanish. Give it a body measurement and it recommends a size, including when the measurement falls between two sizes. |
| `run_health_check` tool | Reads this computer's status (restart time, memory, disk space, network; on Windows also Defender, firewall, pending restart, last update, drive encryption) and reports OK / WARN / FAIL with plain advice in English or Spanish. Changes nothing. |
| `run_diagnostic` tool | Runs ONE command from a fixed allowlist (network config, ping, DNS lookup, top processes, startup apps, recent system errors, update history). Claude picks an id, never a command. MAC addresses and the user name are hidden in the output. |
| `search_kb` tool | Searches a bilingual (EN/ES) IT knowledge base of 12 sample articles. Articles marked technician-only (password resets, phishing, admin rights) tell Claude not to walk the person through them. |
| `lookup_asset` tool | Finds equipment in a sample asset inventory by tag, serial or person; shows lifecycle status, warranty days left and flags. |
| `draft_incident` tool | Prepares a ServiceNow incident (fields, priority from the impact x urgency matrix, assignment group) and optionally a pre-filled "new incident" link. **It never creates the ticket**: a person reviews and submits it. |
| `mcoweblab://pricing.json` resource | The full price list, as read-only context. |
| `skills/bilingual-product-descriptions/` | A Claude skill: instructions, templates, a worked example, a checker script and test results. |

Every tool call is written to `logs/tool-calls.jsonl` (tool, arguments with passwords removed, success, time taken). See [docs/it-helper-tools.md](docs/it-helper-tools.md) for the IT tools' guardrails.

Every tool has an input schema (what Claude may send), an output schema (the JSON shape it gets back) and a text version for apps that only show text. Mistakes in a request (an unknown add-on, too many pages) come back as a readable error Claude can fix and retry.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm run check      # typecheck + build + 83 tests
npm run inspect    # optional: opens the MCP Inspector in the browser to call the tools by hand
```

### Connect it to Claude Code

```bash
npm run build
claude mcp add mcoweblab -- node "/full/path/to/mcoweblab-mcp/dist/index.js"
```

Then ask Claude Code something like "How much is a QR menu with dish photos?".

### Connect it to Claude Desktop (Windows)

Open Claude Desktop's settings, go to Developer, and edit the config file (`%APPDATA%\Claude\claude_desktop_config.json`). Add:

```json
{
  "mcpServers": {
    "mcoweblab": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\path\\to\\mcoweblab-mcp\\dist\\index.js"]
    }
  }
}
```

Restart Claude Desktop. The tools show up under the tools menu in a new chat.

Optional settings, added as `"env": { ... }` next to `"args"`:

- `SERVICENOW_INSTANCE`: your ServiceNow instance name (for example `dev123456`), so `draft_incident` also returns a pre-filled "new incident" link.
- `MCOWEBLAB_LOG_FILE`: where to write the tool-call log, or `off`. Default: `logs/tool-calls.jsonl` in this folder.

### Use the skill

- **Claude Code:** copy `skills/bilingual-product-descriptions` into `~/.claude/skills/` (all projects) or `.claude/skills/` in one project. Ask for product descriptions and Claude loads the skill on its own.
- **Claude apps:** zip the `bilingual-product-descriptions` folder and upload it under Settings, Capabilities, Skills.

Check an output by hand:

```bash
node skills/bilingual-product-descriptions/scripts/check_description.mjs facts.md output.md voice.md
```

## How it's built

```
src/
  index.ts          starts the server over stdio (logs go to stderr, because stdout carries MCP messages)
  server.ts         registers the tools and the resource, with their schemas and descriptions
  data.ts           loads and validates data/pricing.json and data/size-charts.json at startup
  tools/            one plain function per tool, no MCP code, so they're easy to test
  it/               the IT helper tools: health check, diagnostics allowlist, KB search, assets, incident drafts, redaction
  auditLog.ts       writes one line per tool call to logs/tool-calls.jsonl
  pricing/          copied from the quote calculator (types, calculateQuote, parsePricing)
data/
  pricing.json      same price list as the quote calculator, with its "unconfirmed" list of drafts
  size-charts.json  SAMPLE charts for the demo
  it-kb.json        SAMPLE bilingual IT knowledge base (12 articles)
  it-assets.json    SAMPLE asset inventory (fictional people and serials)
test/               unit tests, an in-memory MCP client test, and a real stdio process test
skills/             the Claude skill
docs/               demo runs and the explainer guide
```

Design choices:

- **Tools are plain functions; `server.ts` only wraps them.** The logic is tested without MCP, and the MCP layer is tested separately through a real client.
- **One source of truth for prices.** `get_quote` calls the quote calculator's `calculateQuote()`. The quote calculator's `pricing.json` was copied here; the one change is `rush.offered: false`, because rush delivery is off for the first launch.
- **Honest by design.** Draft prices are flagged in the data, and the server tells Claude which numbers are drafts so it doesn't present them as final.
- **Read-only and human-in-the-loop for IT.** The IT tools can look but not touch: no tool changes a setting, resets a password or creates a ticket. Commands come from a fixed allowlist, run without a shell, and Claude only picks an id. Passwords are removed from tickets and logs, and security problems are escalated by code, not left to the model's judgment.
- **Code decides, the model explains.** Testing showed Claude guessing a size when a measurement fell between two sizes. Size recommendations are now computed by code and Claude just explains them.

## How I built it

This project was built with Claude Code. Claude Code wrote the code, the tests, the skill and these docs, and ran the tests and the demo runs.

What I (Mel) did: asked for this project and chose its scope, supplied the real business facts (MCO WebLab's services and starting prices, and turning rush delivery off), ran the test suite myself on my laptop (`npm run check`), connected the server to Claude Desktop and tested it with real questions (a Shopify quote with Spanish translation, and a between-sizes chest measurement in Spanish), read through the quote tool's code, reviewed the Spanish product-description test outputs, and decided to publish the IT helper tools alongside the original server.

## Next steps

- Swap the sample size charts for the MCO Size Guide app's real presets.
- Approve the remaining draft prices (they're listed in `data/pricing.json` under `unconfirmed`); the draft warnings then go away on their own.
- Read the pricing from `mcoweblab.com/api/pricing.json` once the quote calculator is live, instead of keeping a copy.
