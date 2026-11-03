#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadShopData } from './data.js'
import { createServer, SERVER_NAME } from './server.js'

/**
 * Entry point. Claude Desktop or Claude Code starts this program and talks to it over
 * stdin/stdout (the "stdio" transport). Because stdout carries the MCP messages,
 * logging must go to stderr (console.error), never console.log.
 */
async function main() {
  const data = loadShopData()
  const server = createServer(data)
  await server.connect(new StdioServerTransport())
  console.error(`${SERVER_NAME} MCP server running on stdio (${data.pricing.unconfirmed.length} draft price values)`)
}

main().catch((error) => {
  console.error('Failed to start the MCO WebLab MCP server:', error)
  process.exit(1)
})
