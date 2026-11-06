import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactArgs } from './it/redact.js'

/**
 * A log of every tool call: which tool, with what arguments (passwords removed), whether it
 * worked and how long it took. One JSON object per line (JSONL), so it's easy to read, grep,
 * or load into a spreadsheet. It answers "what did the AI do on this computer, and when?".
 * Writing the log must never break a tool call, so errors are only printed to stderr.
 */

export interface AuditEntry {
  time: string
  tool: string
  args: unknown
  ok: boolean
  isError: boolean
  durationMs: number
  error?: string
}

export interface AuditLog {
  record(entry: AuditEntry): void
}

export const noAuditLog: AuditLog = { record() {} }

export function fileAuditLog(path: string): AuditLog {
  let dirReady = false
  return {
    record(entry) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(path), { recursive: true })
          dirReady = true
        }
        appendFileSync(path, `${JSON.stringify({ ...entry, args: redactArgs(entry.args) })}\n`, 'utf8')
      } catch (error) {
        console.error(`Could not write the tool-call log at ${path}:`, error)
      }
    },
  }
}

/** logs/tool-calls.jsonl next to the project, unless MCOWEBLAB_LOG_FILE says otherwise ("off" turns it off). */
export function defaultAuditLog(env: NodeJS.ProcessEnv = process.env): { log: AuditLog; path: string | null } {
  const setting = env.MCOWEBLAB_LOG_FILE?.trim()
  if (setting === 'off') return { log: noAuditLog, path: null }
  const path = setting || fileURLToPath(new URL('../logs/tool-calls.jsonl', import.meta.url))
  return { log: fileAuditLog(path), path }
}
