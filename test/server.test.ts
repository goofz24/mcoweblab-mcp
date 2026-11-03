import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadShopData } from '../src/data.js'
import { createServer } from '../src/server.js'

/**
 * Talks to the server the way Claude Desktop or Claude Code would, through a real MCP client,
 * but over an in-memory connection instead of stdin/stdout.
 */
const client = new Client({ name: 'test-client', version: '1.0.0' })

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(loadShopData()).connect(serverSide)
  await client.connect(clientSide)
})

afterAll(async () => {
  await client.close()
})

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>
const text = (result: CallToolResult) => (result.content[0] as { text: string }).text

describe('MCP server', () => {
  it('introduces itself with instructions about draft prices', () => {
    expect(client.getServerVersion()?.name).toBe('mcoweblab')
    expect(client.getInstructions()).toMatch(/isDraft/)
  })

  it('offers three read-only tools, each with input and output schemas', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['list_services', 'get_quote', 'get_size_chart'])
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(80)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.outputSchema?.type).toBe('object')
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
    const quote = tools.find((t) => t.name === 'get_quote')!
    expect(quote.inputSchema.required).toEqual(['projectType'])
    expect((quote.inputSchema.properties as Record<string, { enum?: string[] }>).projectType.enum).toEqual([
      'custom-website',
      'shopify-store',
      'qr-menu',
      'wallet-card',
    ])
  })

  it('answers get_quote with readable text and matching structured data', async () => {
    const result = await call('get_quote', { projectType: 'shopify-store', pages: 5, addons: ['bilingual'] })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ estimateLow: 950, estimateHigh: 1190, typicalWeeks: 4, isDraft: true })
    expect(text(result)).toContain('Estimate: $950 - $1190')
  })

  it('returns a recoverable error for an add-on that does not fit the project', async () => {
    const result = await call('get_quote', { projectType: 'wallet-card', addons: ['bilingual'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/Add-ons for wallet-card: wallet-design/)
  })

  it('rejects arguments that break the input schema before the tool runs', async () => {
    const result = await call('get_quote', { projectType: 'mobile-app' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/projectType/)
  })

  it('answers list_services and get_size_chart', async () => {
    const services = await call('list_services', { language: 'es' })
    expect(text(services)).toContain('Tienda Shopify [shopify-store]: desde $800')
    const chart = await call('get_size_chart', { chart: 'kids-tshirt', unit: 'cm' })
    expect(chart.structuredContent).toMatchObject({ unit: 'cm', sampleData: true })
  })

  it('exposes the price list as a resource', async () => {
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(['mcoweblab://pricing.json'])
    const read = await client.readResource({ uri: 'mcoweblab://pricing.json' })
    const pricing = JSON.parse((read.contents[0] as { text: string }).text)
    expect(pricing.projectTypes).toHaveLength(4)
  })
})
