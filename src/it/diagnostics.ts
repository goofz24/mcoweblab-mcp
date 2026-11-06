import type { Lang } from '../pricing/types.js'
import { ToolInputError } from '../tools/errors.js'
import { powershellArgs, runCommand, type CommandRunner } from './powershell.js'
import { redactOutput } from './redact.js'

/**
 * The ALLOWLIST. Claude can only pick one of these ids. Each id maps to a fixed program and
 * fixed arguments per operating system; Claude never sends a command, a path or an argument.
 * Every command here only reads. Nothing that installs, deletes, restarts or changes settings
 * is on the list, on purpose. To add a diagnostic, add it here and add a test.
 */
interface CommandSpec {
  file: string
  args: readonly string[]
  /** Optional clean-up of the raw output (sorting, cutting to the useful part). */
  post?: (stdout: string) => string
}

interface DiagnosticSpec {
  name: { en: string; es: string }
  /** What it reads, shown to the person. */
  reads: { en: string; es: string }
  /** True when it sends traffic outside the computer (ping, DNS). */
  usesNetwork: boolean
  windows: CommandSpec | null
  other: CommandSpec | null
}

/** tasklist /fo csv /nh prints "name","pid","session","#","12,345 K". Keep the 15 biggest by memory. */
export function topProcessesFromTasklist(csv: string): string {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1)) ?? [])
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({ name: cells[0], pid: cells[1], kb: Number(cells[4].replace(/[^\d]/g, '')) || 0 }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 15)
  const lines = ['Memory (MB)  PID      Process']
  for (const r of rows) lines.push(`${String(Math.round(r.kb / 1024)).padStart(11)}  ${r.pid.padEnd(7)}  ${r.name}`)
  return lines.join('\n')
}

function firstLines(count: number) {
  return (stdout: string) => stdout.split(/\r?\n/).slice(0, count).join('\n')
}

export const DIAGNOSTICS = {
  'network-config': {
    name: { en: 'Network configuration', es: 'Configuración de red' },
    reads: { en: 'IP addresses, gateway and DNS servers of each network adapter', es: 'Direcciones IP, puerta de enlace y servidores DNS de cada adaptador' },
    usesNetwork: false,
    windows: { file: 'ipconfig', args: ['/all'] },
    other: { file: 'ip', args: ['addr'] },
  },
  'ping-internet': {
    name: { en: 'Internet reachability (ping 1.1.1.1)', es: 'Alcance a internet (ping 1.1.1.1)' },
    reads: { en: 'Whether 4 test packets reach a public server and how long they take', es: 'Si 4 paquetes de prueba llegan a un servidor público y cuánto tardan' },
    usesNetwork: true,
    windows: { file: 'ping', args: ['-n', '4', '1.1.1.1'] },
    other: { file: 'ping', args: ['-c', '4', '1.1.1.1'] },
  },
  'dns-lookup': {
    name: { en: 'DNS lookup (mcoweblab.com)', es: 'Búsqueda DNS (mcoweblab.com)' },
    reads: { en: 'Whether the computer can turn a website name into an address', es: 'Si la computadora puede convertir el nombre de una página en una dirección' },
    usesNetwork: true,
    windows: { file: 'nslookup', args: ['mcoweblab.com'] },
    other: { file: 'nslookup', args: ['mcoweblab.com'] },
  },
  'top-processes': {
    name: { en: 'Apps using the most memory', es: 'Aplicaciones que más memoria usan' },
    reads: { en: 'The 15 running programs using the most memory', es: 'Los 15 programas abiertos que más memoria usan' },
    usesNetwork: false,
    windows: { file: 'tasklist', args: ['/fo', 'csv', '/nh'], post: topProcessesFromTasklist },
    other: { file: 'ps', args: ['-eo', 'rss,pid,comm', '--sort=-rss'], post: firstLines(16) },
  },
  'startup-apps': {
    name: { en: 'Apps that start with Windows', es: 'Aplicaciones que abren al iniciar Windows' },
    reads: { en: 'The list of programs set to run at sign-in', es: 'La lista de programas que corren al iniciar sesión' },
    usesNetwork: false,
    windows: {
      file: 'powershell.exe',
      args: powershellArgs(
        "Get-CimInstance Win32_StartupCommand | Select-Object Name, Location, User | Format-Table -AutoSize | Out-String -Width 160",
      ),
    },
    other: null,
  },
  'recent-system-errors': {
    name: { en: 'System errors in the last 24 hours', es: 'Errores del sistema en las últimas 24 horas' },
    reads: { en: 'Up to 20 critical/error events from the Windows System log (first line of each)', es: 'Hasta 20 eventos críticos o de error del registro System de Windows (primera línea de cada uno)' },
    usesNetwork: false,
    windows: {
      file: 'powershell.exe',
      args: powershellArgs(
        "$e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-1) } -MaxEvents 20 -ErrorAction SilentlyContinue\n" +
          "if (-not $e) { 'No critical or error events in the System log in the last 24 hours.' } else { $e | Select-Object TimeCreated, Id, ProviderName, @{ n = 'Message'; e = { ($_.Message -split [Environment]::NewLine)[0] } } | Format-List | Out-String -Width 200 }",
      ),
    },
    other: null,
  },
  'update-history': {
    name: { en: 'Recently installed Windows updates', es: 'Actualizaciones de Windows instaladas recientemente' },
    reads: { en: 'The 10 newest installed updates (KB number and date)', es: 'Las 10 actualizaciones instaladas más recientes (número KB y fecha)' },
    usesNetwork: false,
    windows: {
      file: 'powershell.exe',
      args: powershellArgs(
        "Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 10 HotFixID, Description, InstalledOn | Format-Table -AutoSize | Out-String -Width 160",
      ),
    },
    other: null,
  },
} as const satisfies Record<string, DiagnosticSpec>

export type DiagnosticId = keyof typeof DIAGNOSTICS
export const DIAGNOSTIC_IDS = Object.keys(DIAGNOSTICS) as [DiagnosticId, ...DiagnosticId[]]

export const MAX_OUTPUT_CHARS = 6000
const TIMEOUT_MS = 30_000

export interface DiagnosticResult {
  diagnostic: DiagnosticId
  name: string
  reads: string
  command: string
  usesNetwork: boolean
  ok: boolean
  exitCode: number | null
  output: string
  truncated: boolean
  redacted: true
}

/** The command line as a person would type it, for the result and the log. PowerShell scripts are shown by name only. */
function describe(spec: CommandSpec): string {
  return spec.args.includes('-EncodedCommand') ? `${spec.file} (fixed read-only script)` : [spec.file, ...spec.args].join(' ')
}

export async function runDiagnostic(
  id: string,
  lang: Lang,
  options: { platform?: NodeJS.Platform; run?: CommandRunner } = {},
): Promise<DiagnosticResult> {
  if (!Object.hasOwn(DIAGNOSTICS, id)) {
    throw new ToolInputError(`"${id}" is not an allowed diagnostic. Allowed: ${DIAGNOSTIC_IDS.join(', ')}.`)
  }
  const diag: DiagnosticSpec = DIAGNOSTICS[id as DiagnosticId]
  const platform = options.platform ?? process.platform
  const spec = platform === 'win32' ? diag.windows : diag.other
  if (!spec) {
    throw new ToolInputError(`The ${id} diagnostic only works on Windows. This computer runs ${platform}.`)
  }
  const result = await (options.run ?? runCommand)(spec.file, spec.args, TIMEOUT_MS)

  let output: string
  if (result.startError) output = result.startError
  else if (result.timedOut) output = `Stopped after ${TIMEOUT_MS / 1000} seconds with no answer.\n${result.stdout}`
  else output = (spec.post ? spec.post(result.stdout) : result.stdout).trim() || result.stderr.trim() || '(no output)'

  output = redactOutput(output)
  const truncated = output.length > MAX_OUTPUT_CHARS
  if (truncated) output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[... cut at ${MAX_OUTPUT_CHARS} characters]`

  return {
    diagnostic: id as DiagnosticId,
    name: diag.name[lang],
    reads: diag.reads[lang],
    command: describe(spec),
    usesNetwork: diag.usesNetwork,
    // ping returns exit code 1 when packets are lost: that is a finding, not a tool failure.
    ok: !result.startError && !result.timedOut && result.exitCode === 0,
    exitCode: result.exitCode,
    output,
    truncated,
    redacted: true,
  }
}

export function formatDiagnostic(r: DiagnosticResult, lang: Lang): string {
  const es = lang === 'es'
  return [
    `${r.name}`,
    `${es ? 'Comando' : 'Command'}: ${r.command}`,
    `${es ? 'Lee' : 'Reads'}: ${r.reads}`,
    r.ok ? '' : es ? `Terminó con código ${r.exitCode ?? '?'} (puede ser un hallazgo, no un fallo).` : `Exited with code ${r.exitCode ?? '?'} (this can be a finding, not a failure).`,
    '```',
    r.output,
    '```',
    es ? 'Solo lectura. Direcciones MAC y nombre de usuario ocultos.' : 'Read-only. MAC addresses and the user name are hidden.',
  ]
    .filter((l) => l !== '')
    .join('\n')
}
