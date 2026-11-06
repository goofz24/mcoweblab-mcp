import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { noAuditLog, type AuditLog } from './auditLog.js'
import type { ShopData } from './data.js'
import { formatAssets, lookupAsset } from './it/assets.js'
import { DIAGNOSTIC_IDS, DIAGNOSTICS, formatDiagnostic, runDiagnostic } from './it/diagnostics.js'
import { collectSystemFacts, evaluateHealth, formatHealthReport, type SystemFacts } from './it/healthCheck.js'
import { draftIncident, formatIncident, INCIDENT_CATEGORIES, validInstance } from './it/incident.js'
import { ASSET_STATUSES, KB_CATEGORIES } from './it/itData.js'
import { formatKbResult, searchKb } from './it/kb.js'
import type { CommandRunner } from './it/powershell.js'
import { ToolInputError } from './tools/errors.js'
import { formatQuote, getQuote } from './tools/getQuote.js'
import { formatSizeChart, getSizeChart } from './tools/getSizeChart.js'
import { formatServices, listServices } from './tools/listServices.js'

export const SERVER_NAME = 'mcoweblab'
export const SERVER_VERSION = '0.2.0'

/** Everything outside the data files that the tools touch. Tests replace these with fakes. */
export interface ServerOptions {
  /** Where every tool call is recorded. index.ts passes the real log file; tests can pass their own. */
  auditLog?: AuditLog
  /** Reads facts from this computer for the health check. */
  collectFacts?: () => Promise<SystemFacts>
  /** Runs an allowlisted diagnostic command. */
  runCommand?: CommandRunner
  platform?: NodeJS.Platform
  now?: () => Date
  /** ServiceNow instance name (like "dev123456") for pre-filled incident links. */
  servicenowInstance?: string
}

const language = z
  .enum(['en', 'es'])
  .default('en')
  .describe('Language for names and notes: "en" for English, "es" for Spanish. Match the language the client is writing in.')

/**
 * Runs a tool and turns the answer into an MCP result with two parts:
 * - content: readable text, for any client
 * - structuredContent: the same data as JSON that matches the tool's outputSchema
 * A ToolInputError becomes isError: true, so Claude sees what was wrong and can try again.
 */
async function respond<T extends object>(run: () => T | Promise<T>, format: (result: T) => string): Promise<CallToolResult> {
  try {
    const result = await run()
    return {
      content: [{ type: 'text', text: format(result) }],
      structuredContent: result as Record<string, unknown>,
    }
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { isError: true, content: [{ type: 'text', text: error.message }] }
    }
    throw error
  }
}

const money = z.number().int().nonnegative()

/**
 * Wraps a tool handler so every call is written to the audit log: tool name, arguments
 * (passwords removed), success or error, and how long it took.
 */
function logged<A>(log: AuditLog, tool: string, handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const started = Date.now()
    const entry = { time: new Date(started).toISOString(), tool, args }
    try {
      const result = await handler(args)
      log.record({ ...entry, ok: !result.isError, isError: Boolean(result.isError), durationMs: Date.now() - started })
      return result
    } catch (error) {
      log.record({ ...entry, ok: false, isError: true, durationMs: Date.now() - started, error: String(error) })
      throw error
    }
  }
}

const IT_RULES =
  ' IT helper tools (run_health_check, run_diagnostic, search_kb, lookup_asset, draft_incident) are READ-ONLY: they never change settings, install anything, reset passwords or create tickets. ' +
  'draft_incident only prepares a draft; a technician reviews and submits it. Never ask for, repeat or store a password. ' +
  'If a KB article says TECHNICIAN ONLY, or a draft says escalate, tell the person a technician will handle it instead of guiding them through it. ' +
  'The knowledge base and asset inventory are SAMPLE data.'

/** Builds the MCP server. Kept separate from index.ts so tests can connect to it in memory. */
export function createServer(data: ShopData, options: ServerOptions = {}): McpServer {
  const log = options.auditLog ?? noAuditLog
  const now = options.now ?? (() => new Date())
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for MCO WebLab, a small web studio in Ponce, Puerto Rico that builds websites, Shopify stores, QR menus and loyalty wallet cards. ' +
        'Only the starting prices and the monthly maintenance price are approved. When a tool result says DRAFT or isDraft is true, tell the person the numbers are a draft estimate, not a final price.' +
        IT_RULES,
    },
  )

  const projectTypeIds = data.pricing.projectTypes.map((t) => t.id) as [string, ...string[]]
  const addonIds = data.pricing.addons.map((a) => a.id) as [string, ...string[]]
  const chartIds = data.sizeCharts.charts.map((c) => c.id) as [string, ...string[]]

  server.registerTool(
    'list_services',
    {
      title: 'List MCO WebLab services',
      description:
        'Lists the services MCO WebLab offers, with starting prices, the add-ons each service allows, and monthly maintenance. ' +
        'Use it when someone asks what MCO WebLab does or how much a type of project starts at. Each price says whether it is approved or still a draft.',
      inputSchema: { language },
      outputSchema: {
        currency: z.string(),
        services: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            startingPrice: money,
            startingPriceConfirmed: z.boolean(),
            includedPages: z.number().int(),
            maxPages: z.number().int(),
            addons: z.array(z.object({ id: z.string(), name: z.string(), price: money, priceConfirmed: z.boolean() })),
          }),
        ),
        maintenance: z.object({ name: z.string(), monthlyPrice: money, monthlyPriceConfirmed: z.boolean() }),
        rushDeliveryOffered: z.boolean(),
        unconfirmedValueCount: z.number().int(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'list_services', async ({ language: lang }) =>
      respond(
        () => listServices(data.pricing, lang),
        (r) => formatServices(r, lang),
      ),
    ),
  )

  server.registerTool(
    'get_quote',
    {
      title: 'Estimate a project price',
      description:
        'Calculates a price estimate for an MCO WebLab project with the same pricing logic as the quote calculator on mcoweblab.com. ' +
        'Use it when someone describes a project and asks what it would cost or how long it takes. ' +
        'Pick the projectType and add-on ids from list_services. Returns line items, a price range, monthly maintenance, a typical timeline, ' +
        'and isDraft plus unconfirmedValuesUsed for any number Mel has not approved.',
      inputSchema: {
        projectType: z.enum(projectTypeIds).describe('Which kind of project.'),
        pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Total number of pages wanted. Leave it out to use the pages included in the starting price.'),
        addons: z.array(z.enum(addonIds)).default([]).describe(
            'Add-on ids, for example "bilingual" for an English + Spanish site. Monthly maintenance is not an add-on: use the separate maintenance setting. Rush delivery is not offered.',
          ),
        maintenance: z.boolean().default(false).describe('Add monthly maintenance (billed monthly, separate from the one-time price).'),
        language,
      },
      outputSchema: {
        projectType: z.string(),
        projectName: z.string(),
        pages: z.number().int(),
        lineItems: z.array(z.object({ id: z.string(), name: z.string(), amount: money, confirmed: z.boolean() })),
        estimateLow: money,
        estimateHigh: money,
        monthly: money,
        typicalWeeks: z.number().int(),
        isDraft: z.boolean(),
        unconfirmedValuesUsed: z.array(z.string()),
        notes: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'get_quote', async ({ language: lang, ...request }) =>
      respond(
        () => getQuote(data.pricing, request, lang),
        (r) => formatQuote(r, lang),
      ),
    ),
  )

  server.registerTool(
    'get_size_chart',
    {
      title: 'Get a size chart',
      description:
        'Returns an apparel size chart (sizes with min-max body measurements) in inches or centimeters, plus how to measure. ' +
        'Use it when a shopper asks which size to pick or wants a size chart. If they give a body measurement, pass it as bodyMeasurement and use the recommendation it returns. ' +
        'If sampleData is true, say the chart is sample data.',
      inputSchema: {
        chart: z.enum(chartIds).describe('Which size chart.'),
        unit: z.enum(['in', 'cm']).default('in').describe('"in" for inches, "cm" for centimeters.'),
        bodyMeasurement: z
          .object({
            measurement: z.string().describe('A measurement id from the chart, for example "chest", "bust" or "height".'),
            value: z.number().positive().describe('The person\'s measurement, in the same unit as `unit`.'),
          })
          .optional()
          .describe('Give this when the person told you a body measurement, to get a size recommendation instead of guessing.'),
        language,
      },
      outputSchema: {
        chart: z.string(),
        name: z.string(),
        unit: z.enum(['in', 'cm']),
        sampleData: z.boolean(),
        howToMeasure: z.string(),
        columns: z.array(z.object({ id: z.string(), name: z.string() })),
        rows: z.array(
          z.object({
            size: z.string(),
            measurements: z.record(z.string(), z.object({ min: z.number(), max: z.number() })),
          }),
        ),
        recommendation: z
          .object({
            measurement: z.string(),
            value: z.number(),
            size: z.string().nullable(),
            fit: z.enum(['fits', 'between', 'below-smallest', 'above-largest']),
            explanation: z.string(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'get_size_chart', async ({ chart, unit, bodyMeasurement, language: lang }) =>
      respond(
        () => getSizeChart(data.sizeCharts, chart, unit, lang, bodyMeasurement),
        (r) => formatSizeChart(r, lang),
      ),
    ),
  )

  registerItTools(server, data, options, log, now)

  // A resource is read-only data the app can attach as context, as opposed to a tool Claude calls.
  server.registerResource(
    'pricing',
    'mcoweblab://pricing.json',
    {
      title: 'MCO WebLab price list',
      description: 'The full price list the quotes come from, including the "unconfirmed" list of draft values.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data.pricing, null, 2) }],
    }),
  )

  return server
}

const checkStatus = z.enum(['ok', 'warn', 'fail', 'unknown'])
const level = z.union([z.literal(1), z.literal(2), z.literal(3)])

/**
 * The IT helper tools. All of them only read: this computer's status, the sample knowledge
 * base, the sample asset list. draft_incident builds a draft and a link; a person submits it.
 */
function registerItTools(server: McpServer, data: ShopData, options: ServerOptions, log: AuditLog, now: () => Date) {
  const platform = options.platform ?? process.platform
  const collect = options.collectFacts ?? (() => collectSystemFacts({ platform, run: options.runCommand, now }))
  const instance = validInstance(options.servicenowInstance)

  server.registerTool(
    'run_health_check',
    {
      title: 'Run a computer health check (read-only)',
      description:
        'Checks THIS computer and reports problems in plain language: time since last restart, memory in use, free disk space, network connection, ' +
        'and on Windows also Defender antivirus, firewall, pending restart, last Windows update and drive encryption. ' +
        'Use it when someone says their computer is slow, full, unsafe or acting up, before suggesting fixes or drafting a ticket. ' +
        'It only reads; it changes nothing. Each problem links a KB article id you can open with search_kb. ticketNote is ready to paste into a ticket.',
      inputSchema: { language },
      outputSchema: {
        overall: checkStatus,
        computer: z.object({ hostname: z.string(), os: z.string(), cpu: z.string(), memoryGb: z.number() }),
        collectedAt: z.string(),
        checks: z.array(
          z.object({ id: z.string(), name: z.string(), status: checkStatus, value: z.string(), advice: z.string(), kbArticle: z.string().nullable() }),
        ),
        counts: z.object({ ok: z.number().int(), warn: z.number().int(), fail: z.number().int(), unknown: z.number().int() }),
        ticketNote: z.string(),
        collectionNotes: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'run_health_check', async ({ language: lang }) =>
      respond(
        async () => evaluateHealth(await collect(), lang),
        (r) => formatHealthReport(r, lang),
      ),
    ),
  )

  const diagnosticList = DIAGNOSTIC_IDS.map((id) => `"${id}" (${DIAGNOSTICS[id].reads.en})`).join('; ')
  server.registerTool(
    'run_diagnostic',
    {
      title: 'Run an allowlisted diagnostic (read-only)',
      description:
        'Runs ONE read-only troubleshooting command from a fixed allowlist and returns its output, with MAC addresses and the user name hidden. ' +
        `You can only choose an id, never a command: ${diagnosticList}. ` +
        'Use it to gather evidence for a problem (no internet, slow computer) after or instead of the health check. Some only work on Windows.',
      inputSchema: {
        diagnostic: z.enum(DIAGNOSTIC_IDS).describe('Which allowlisted diagnostic to run.'),
        language,
      },
      outputSchema: {
        diagnostic: z.string(),
        name: z.string(),
        reads: z.string(),
        command: z.string(),
        usesNetwork: z.boolean(),
        ok: z.boolean(),
        exitCode: z.number().int().nullable(),
        output: z.string(),
        truncated: z.boolean(),
        redacted: z.literal(true),
      },
      // ping and nslookup send traffic to the internet, so this one is "open world".
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged(log, 'run_diagnostic', async ({ diagnostic, language: lang }) =>
      respond(
        () => runDiagnostic(diagnostic, lang, { platform, run: options.runCommand }),
        (r) => formatDiagnostic(r, lang),
      ),
    ),
  )

  server.registerTool(
    'search_kb',
    {
      title: 'Search the IT knowledge base',
      description:
        'Searches the IT help desk knowledge base (English and Spanish) and returns the best matching articles with steps. ' +
        'Use it for any how-to or troubleshooting question (Wi-Fi, VPN, printer, Outlook, MFA, slow computer, phishing...). Pass the person\'s own words as query; ' +
        'it matches both languages. If selfService is false, do not guide the person through it: a technician handles it.',
      inputSchema: {
        query: z.string().min(2).max(300).describe('The problem in the person\'s words, in English or Spanish.'),
        limit: z.number().int().min(1).max(5).default(3).describe('How many articles to return.'),
        language,
      },
      outputSchema: {
        query: z.string(),
        sampleData: z.boolean(),
        matches: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            category: z.enum(KB_CATEGORIES),
            selfService: z.boolean(),
            score: z.number(),
            matchedKeywords: z.array(z.string()),
            summary: z.string(),
            steps: z.array(z.string()),
            escalateWhen: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'search_kb', async ({ query, limit, language: lang }) =>
      respond(
        () => searchKb(data.it.kb, query, lang, limit),
        (r) => formatKbResult(r, lang),
      ),
    ),
  )

  server.registerTool(
    'lookup_asset',
    {
      title: 'Look up IT equipment',
      description:
        'Finds equipment in the IT asset inventory by asset tag (like MCO-LT-001), serial number or the person it is assigned to, or lists every asset with a status. ' +
        'Returns model, owner, location, lifecycle status, warranty days left, and flags such as "in use with an expired warranty". Read-only. The inventory is SAMPLE data.',
      inputSchema: {
        query: z.string().min(2).max(100).optional().describe('Asset tag, serial number, or part of a person\'s name.'),
        status: z.enum(ASSET_STATUSES).optional().describe('Only assets in this lifecycle stage.'),
        language,
      },
      outputSchema: {
        query: z.string().nullable(),
        status: z.enum(ASSET_STATUSES).nullable(),
        sampleData: z.boolean(),
        today: z.string(),
        matches: z.array(
          z.object({
            tag: z.string(),
            type: z.string(),
            model: z.string(),
            serial: z.string(),
            assignedTo: z.string().nullable(),
            location: z.string(),
            status: z.enum(ASSET_STATUSES),
            purchased: z.string(),
            warrantyEnd: z.string(),
            notes: z.string(),
            warrantyDaysLeft: z.number().int(),
            warrantyStatus: z.enum(['active', 'ending-soon', 'expired']),
            flags: z.array(z.string()),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'lookup_asset', async ({ query, status, language: lang }) =>
      respond(
        () => lookupAsset(data.it.assets, { query, status }, lang, now()),
        (r) => formatAssets(r, lang),
      ),
    ),
  )

  server.registerTool(
    'draft_incident',
    {
      title: 'Draft a ServiceNow incident (does not create it)',
      description:
        'Prepares a ServiceNow incident from a conversation: short description, description, category, impact, urgency, priority (ServiceNow impact x urgency matrix) and assignment group. ' +
        'It does NOT create the ticket: it returns a draft and, when configured, a link to a pre-filled form that a technician reviews and submits. ' +
        'Use it when a problem needs a technician, or when search_kb steps did not fix it. Passwords in the text are removed automatically. ' +
        'Security problems (phishing, malware) are flagged and raised to urgency 1. If escalateToHuman is true, tell the person a technician will follow up.',
      inputSchema: {
        shortDescription: z.string().min(5).max(160).describe('One line, like "VPN fails with certificate error since this morning".'),
        description: z.string().min(10).max(4000).describe('What happened, what was already tried (KB steps, health check result), and any error messages.'),
        category: z.enum(INCIDENT_CATEGORIES).describe('ServiceNow category: inquiry, software, hardware, network or database.'),
        impact: level.default(3).describe('1 = many people or the whole business, 2 = a team, 3 = one person.'),
        urgency: level.default(3).describe('1 = work is stopped, 2 = work is slowed, 3 = can wait.'),
        callerName: z.string().max(100).optional().describe('Who reported it, if they said.'),
        assetTag: z.string().max(20).optional().describe('Asset tag from lookup_asset, if known.'),
        kbArticleId: z.string().max(10).optional().describe('KB article id already tried or suggested, like KB0003.'),
        language,
      },
      outputSchema: {
        created: z.literal(false),
        fields: z.object({
          short_description: z.string(),
          description: z.string(),
          category: z.enum(INCIDENT_CATEGORIES),
          impact: level,
          urgency: level,
          priority: z.number().int(),
          assignment_group: z.string(),
        }),
        priorityLabel: z.string(),
        escalateToHuman: z.boolean(),
        escalationReasons: z.array(z.string()),
        warnings: z.array(z.string()),
        linkedAsset: z.string().nullable(),
        linkedKb: z.string().nullable(),
        createUrl: z.string().nullable(),
        nextStep: z.string(),
      },
      // Builds a draft and a link only. Nothing is sent to ServiceNow, so it is read-only.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(log, 'draft_incident', async ({ language: lang, ...request }) =>
      respond(
        () => draftIncident(data.it, request, lang, instance),
        (r) => formatIncident(r, lang),
      ),
    ),
  )
}
