#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultAuditLog } from './auditLog.js'
import { loadShopData } from './data.js'
import { createServer, SERVER_NAME } from './server.js'

/**
 * Entry point. Claude Desktop or Claude Code starts this program and talks to it over
 * stdin/stdout (the "stdio" transport). Because stdout carries the MCP messages,
 * logging must go to stderr (console.error), never console.log.
 */
async function main() {
  const data = loadShopData()
  const audit = defaultAuditLog()
  const server = createServer(data, {
    auditLog: audit.log,
    servicenowInstance: process.env.SERVICENOW_INSTANCE?.trim().toLowerCase(),
  })
  await server.connect(new StdioServerTransport())
  console.error(`${SERVER_NAME} MCP server running on stdio (${data.pricing.unconfirmed.length} draft price values)`)
  console.error(audit.path ? `Logging every tool call to ${audit.path}` : 'Tool-call log is off (MCOWEBLAB_LOG_FILE=off)')
}

main().catch((error) => {
  console.error('Failed to start the MCO WebLab MCP server:', error)
  process.exit(1)
})
