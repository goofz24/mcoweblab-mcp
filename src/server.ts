import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ShopData } from './data.js'
import { ToolInputError } from './tools/errors.js'
import { formatQuote, getQuote } from './tools/getQuote.js'
import { formatSizeChart, getSizeChart } from './tools/getSizeChart.js'
import { formatServices, listServices } from './tools/listServices.js'

export const SERVER_NAME = 'mcoweblab'
export const SERVER_VERSION = '0.1.0'

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
function respond<T extends object>(run: () => T, format: (result: T) => string): CallToolResult {
  try {
    const result = run()
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

/** Builds the MCP server. Kept separate from index.ts so tests can connect to it in memory. */
export function createServer(data: ShopData): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for MCO WebLab, a small web studio in Ponce, Puerto Rico that builds websites, Shopify stores, QR menus and loyalty wallet cards. ' +
        'Only the starting prices and the monthly maintenance price are approved. When a tool result says DRAFT or isDraft is true, tell the person the numbers are a draft estimate, not a final price.',
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
    async ({ language: lang }) =>
      respond(
        () => listServices(data.pricing, lang),
        (r) => formatServices(r, lang),
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
        addons: z.array(z.enum(addonIds)).default([]).describe('Add-on ids, for example "bilingual" for an English + Spanish site.'),
        maintenance: z.boolean().default(false).describe('Add monthly maintenance.'),
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
    async ({ language: lang, ...request }) =>
      respond(
        () => getQuote(data.pricing, request, lang),
        (r) => formatQuote(r, lang),
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
    async ({ chart, unit, bodyMeasurement, language: lang }) =>
      respond(
        () => getSizeChart(data.sizeCharts, chart, unit, lang, bodyMeasurement),
        (r) => formatSizeChart(r, lang),
      ),
  )

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
