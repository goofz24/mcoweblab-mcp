import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'

/**
 * End-to-end: starts the BUILT server (dist/index.js) as its own process, exactly as
 * Claude Desktop or Claude Code would, and calls a tool over stdin/stdout.
 * `npm test` runs `npm run build` first so dist/ is always fresh.
 */
it('runs as a separate process over stdio', async () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' })
  const client = new Client({ name: 'stdio-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    const result = await client.callTool({ name: 'get_quote', arguments: { projectType: 'custom-website' } })
    expect(result.structuredContent).toMatchObject({ estimateLow: 399 })
  } finally {
    await client.close()
  }
})
