# MCO WebLab MCP server + Claude skill

A small [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives Claude tools over MCO WebLab's own data, and a Claude skill for writing bilingual (English and Puerto Rico Spanish) Shopify product descriptions.

Ask Claude *"What would a 5-page Shopify site with Spanish translation cost?"* and it calls `get_quote`, which runs the same pricing code as the quote calculator on mcoweblab.com, and answers *"$950 to $1,190, about 4 weeks. This is a draft estimate..."*. See [docs/demo-runs.md](docs/demo-runs.md) for real recorded runs.

> **Status: local project, not published.** The prices are a draft: only the four starting prices and the $50/month maintenance are approved, and the server says so in every quote. Size charts are sample data, not the MCO Size Guide app's presets.

## What's inside

| Part | What it does |
|---|---|
| `list_services` tool | Services, starting prices, the add-ons each one allows, maintenance. Each price says if it's approved or a draft. |
| `get_quote` tool | Price range, line items and typical timeline for a project. Reuses `calculateQuote()` from the quote calculator, so the website and Claude can never disagree. Returns `isDraft` and the exact draft values it used. |
| `get_size_chart` tool | Apparel size chart in inches or centimeters, in English or Spanish. Give it a body measurement and it recommends a size, including when the measurement falls between two sizes. |
| `mcoweblab://pricing.json` resource | The full price list, as read-only context. |
| `skills/bilingual-product-descriptions/` | A Claude skill: instructions, templates, a worked example, a checker script and test results. |

Every tool has an input schema (what Claude may send), an output schema (the JSON shape it gets back) and a text version for apps that only show text. Mistakes in a request (an unknown add-on, too many pages) come back as a readable error Claude can fix and retry.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm run check      # typecheck + build + 40 tests
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
  pricing/          copied from the quote calculator (types, calculateQuote, parsePricing)
data/
  pricing.json      same price list as the quote calculator, with its "unconfirmed" list of drafts
  size-charts.json  SAMPLE charts for the demo
test/               unit tests, an in-memory MCP client test, and a real stdio process test
skills/             the Claude skill
docs/               demo runs and the explainer guide
```

Design choices:

- **Tools are plain functions; `server.ts` only wraps them.** The logic is tested without MCP, and the MCP layer is tested separately through a real client.
- **One source of truth for prices.** `get_quote` calls the quote calculator's `calculateQuote()`. The quote calculator's `pricing.json` was copied here; the one change is `rush.offered: false`, because rush delivery is off for the first launch.
- **Honest by design.** Draft prices are flagged in the data, and the server tells Claude which numbers are drafts so it doesn't present them as final.
- **Code decides, the model explains.** Testing showed Claude guessing a size when a measurement fell between two sizes. Size recommendations are now computed by code and Claude just explains them.

## How I built it

This project was built with Claude Code. Claude Code wrote the code, the tests, the skill and these docs, and ran the tests and the demo runs.

What I (Mel) did so far: asked for this project (picked from a list of portfolio ideas), and supplied the real business facts it uses (MCO WebLab's services and starting prices, and the decision to turn off rush delivery).

*Update this section honestly as you go: add what you reviewed, changed, ran or fixed yourself, and only then.*

## Next steps

- Swap the sample size charts for the MCO Size Guide app's real presets.
- Approve the remaining draft prices (they're listed in `data/pricing.json` under `unconfirmed`); the draft warnings then go away on their own.
- Read the pricing from `mcoweblab.com/api/pricing.json` once the quote calculator is live, instead of keeping a copy.
