import { execFile } from 'node:child_process'

/**
 * Runs a program WITHOUT a shell. The program and its arguments are always fixed text
 * written in this repo, never text from Claude, so there is nothing to inject into.
 */
export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when the program could not start at all (for example, not installed). */
  startError?: string
}

export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>

export const runCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, exitCode: 0, timedOut: false })
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number }
        if (err.code === 'ENOENT') {
          return resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, startError: `${file} is not installed on this computer` })
        }
        resolve({
          stdout,
          stderr,
          exitCode: typeof err.code === 'number' ? err.code : null,
          timedOut: Boolean(err.killed),
        })
      },
    )
  })

/**
 * Windows PowerShell 5.1 (built into every Windows 10/11) with no profile and no prompts.
 * -EncodedCommand takes the script as Base64 UTF-16, so quotes inside the script can't break.
 * The first line makes PowerShell print UTF-8, so Spanish names come through correctly.
 */
export function powershellArgs(script: string): string[] {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')]
}
