import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileAuditLog, type AuditEntry } from '../src/auditLog.js'
import { loadShopData } from '../src/data.js'
import type { SystemFacts } from '../src/it/healthCheck.js'
import type { CommandRunner } from '../src/it/powershell.js'
import { createServer } from '../src/server.js'

/**
 * The IT tools through a real MCP client, with the computer replaced by fakes
 * (fixed system facts, a fake command runner) so the results are the same everywhere.
 */
const dir = mkdtempSync(join(tmpdir(), 'mcoweblab-log-'))
const logFile = join(dir, 'tool-calls.jsonl')
const commands: string[] = []
const client = new Client({ name: 'it-test-client', version: '1.0.0' })

const fakeFacts: SystemFacts = {
  collectedAt: '2026-11-06T12:00:00.000Z',
  platform: 'win32',
  osRelease: '10.0.26100',
  hostname: 'TEST-LAPTOP',
  uptimeSeconds: 10 * 86_400,
  memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 },
  cpu: { model: 'Test CPU', cores: 8 },
  disks: [{ mount: 'C:', totalBytes: 100 * 1024 ** 3, freeBytes: 7 * 1024 ** 3 }],
  network: { connected: true, adapters: ['Wi-Fi'] },
  windows: null,
  collectionNotes: [],
}
const fakeRun: CommandRunner = async (file, args) => {
  commands.push([file, ...args].join(' '))
  return { stdout: 'Reply from 1.1.1.1: bytes=32 time=21ms TTL=57', stderr: '', exitCode: 0, timedOut: false }
}

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = createServer(loadShopData(), {
    auditLog: fileAuditLog(logFile),
    collectFacts: async () => fakeFacts,
    runCommand: fakeRun,
    platform: 'win32',
    now: () => new Date('2026-11-06T12:00:00Z'),
    servicenowInstance: 'dev123456',
  })
  await server.connect(serverSide)
  await client.connect(clientSide)
})

afterAll(async () => {
  await client.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>
const text = (result: CallToolResult) => (result.content[0] as { text: string }).text

describe('IT helper tools over MCP', () => {
  it('tells Claude the IT tools are read-only and drafts need a person', () => {
    expect(client.getInstructions()).toMatch(/READ-ONLY/)
    expect(client.getInstructions()).toMatch(/technician reviews and submits/)
  })

  it('run_health_check returns problems with advice and a ticket note', async () => {
    const r = await call('run_health_check', { language: 'en' })
    expect(r.structuredContent).toMatchObject({ overall: 'warn', counts: { warn: 2 } })
    expect(text(r)).toContain('[WARN] Free space on C:')
    expect(text(r)).toContain('Read-only: this check changed nothing')
  })

  it('run_diagnostic only accepts allowlisted ids, checked by the schema before anything runs', async () => {
    const bad = await call('run_diagnostic', { diagnostic: 'del /s C:\\' })
    expect(bad.isError).toBe(true)
    expect(commands).toEqual([])
    const ok = await call('run_diagnostic', { diagnostic: 'ping-internet' })
    expect(ok.structuredContent).toMatchObject({ ok: true, usesNetwork: true, command: 'ping -n 4 1.1.1.1' })
    expect(commands).toEqual(['ping -n 4 1.1.1.1'])
  })

  it('search_kb and lookup_asset answer in Spanish', async () => {
    const kb = await call('search_kb', { query: 'no tengo internet en el wifi', language: 'es' })
    expect(text(kb)).toContain('KB0003: Wi-Fi conectado pero sin internet')
    const asset = await call('lookup_asset', { query: 'Ana Rivera', language: 'es' })
    expect((asset.structuredContent as { matches: unknown[] }).matches).toHaveLength(2)
  })

  it('draft_incident returns a draft and a pre-filled link, and never claims to create anything', async () => {
    const r = await call('draft_incident', {
      shortDescription: 'Laptop very slow after update',
      description: 'Health check shows 7% free disk. Tried KB0008.',
      category: 'hardware',
      urgency: 2,
      assetTag: 'MCO-LT-001',
      kbArticleId: 'KB0008',
    })
    expect(r.structuredContent).toMatchObject({ created: false, fields: { priority: 4, assignment_group: 'Desktop Support' } })
    expect((r.structuredContent as { createUrl: string }).createUrl).toMatch(/^https:\/\/dev123456\.service-now\.com\/incident\.do\?sys_id=-1/)
    expect(text(r)).toMatch(/^INCIDENT DRAFT \(nothing has been created\)/)
  })

  it('reports a recoverable error for an unknown asset tag', async () => {
    const r = await call('draft_incident', { shortDescription: 'Broken screen', description: 'The screen is cracked.', category: 'hardware', assetTag: 'MCO-LT-999' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/lookup_asset/)
  })

  it('logs every tool call, with passwords removed, to a JSONL file', async () => {
    await call('draft_incident', { shortDescription: 'VPN fails', description: 'My password is Coqui2026! and the VPN says denied.', category: 'network' })
    await call('get_quote', { projectType: 'custom-website' })
    const entries = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditEntry)
    expect(entries.map((e) => e.tool)).toEqual([
      'run_health_check',
      'run_diagnostic',
      'search_kb',
      'lookup_asset',
      'draft_incident',
      'draft_incident',
      'draft_incident',
      'get_quote',
    ])
    expect(entries[5].ok).toBe(false) // the unknown asset tag
    expect(entries[5].isError).toBe(true)
    expect(entries[6].args).toMatchObject({ description: 'My password is [password removed] and the VPN says denied.' })
    expect(JSON.stringify(entries)).not.toContain('Coqui2026')
    expect(entries.every((e) => typeof e.durationMs === 'number' && !Number.isNaN(Date.parse(e.time)))).toBe(true)
  })
})
