import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { z } from 'zod'
import type { Lang } from '../pricing/types.js'
import { powershellArgs, runCommand, type CommandRunner } from './powershell.js'

/**
 * Health check, in two steps so it can be tested:
 * 1. collectSystemFacts() READS facts from this computer (Node's os module, disk sizes,
 *    and on Windows one fixed read-only PowerShell script). It changes nothing.
 * 2. evaluateHealth() is a pure function: facts in, ok/warn/fail checks with advice out.
 * Tests feed step 2 made-up facts, so every rule is checked without needing a broken laptop.
 */

export interface DiskFacts {
  mount: string
  totalBytes: number
  freeBytes: number
}

export interface WindowsFacts {
  osName: string | null
  defenderRealtime: boolean | null
  defenderSignatureAgeDays: number | null
  firewallAllOn: boolean | null
  pendingReboot: boolean | null
  /** Date of the newest installed update, YYYY-MM-DD. */
  lastUpdateInstalled: string | null
  bitlocker: 'on' | 'off' | 'unknown'
}

export interface SystemFacts {
  collectedAt: string
  platform: string
  osRelease: string
  hostname: string
  uptimeSeconds: number
  memory: { totalBytes: number; freeBytes: number }
  cpu: { model: string; cores: number }
  disks: DiskFacts[]
  network: { connected: boolean; adapters: string[] }
  windows: WindowsFacts | null
  /** Things that could not be read (a check that needs admin rights, for example). */
  collectionNotes: string[]
}

/**
 * Read-only. Every line only reads: CIM queries, Defender and firewall status, two registry
 * key existence checks, and the update list. Each part has its own try/catch so one failure
 * (or a missing admin right) doesn't stop the rest. Prints one line of JSON.
 */
export const WINDOWS_HEALTH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$r = [ordered]@{}
try { $r.osName = (Get-CimInstance Win32_OperatingSystem).Caption } catch { $r.osName = $null }
try { $r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ mount = $_.DeviceID; totalBytes = [double]$_.Size; freeBytes = [double]$_.FreeSpace } }) } catch { $r.disks = $null }
try { $m = Get-MpComputerStatus; $r.defenderRealtime = [bool]$m.RealTimeProtectionEnabled; $r.defenderSignatureAgeDays = [int]$m.AntivirusSignatureAge } catch { $r.defenderRealtime = $null; $r.defenderSignatureAgeDays = $null }
try { $off = @(Get-NetFirewallProfile | Where-Object { [string]$_.Enabled -ne 'True' }); $r.firewallAllOn = ($off.Count -eq 0) } catch { $r.firewallAllOn = $null }
try { $r.pendingReboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') } catch { $r.pendingReboot = $null }
try { $h = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1; if ($h) { $r.lastUpdateInstalled = $h.InstalledOn.ToString('yyyy-MM-dd') } else { $r.lastUpdateInstalled = $null } } catch { $r.lastUpdateInstalled = $null }
try { $b = (New-Object -ComObject Shell.Application).NameSpace('C:').Self.ExtendedProperty('System.Volume.BitLockerProtection'); if ($b -eq 1) { $r.bitlocker = 'on' } elseif ($b -eq 2) { $r.bitlocker = 'off' } else { $r.bitlocker = 'unknown' } } catch { $r.bitlocker = 'unknown' }
$r | ConvertTo-Json -Compress -Depth 4
`

const windowsOutputSchema = z.object({
  osName: z.string().nullable().optional(),
  disks: z.array(z.object({ mount: z.string(), totalBytes: z.number(), freeBytes: z.number() })).nullable().optional(),
  defenderRealtime: z.boolean().nullable().optional(),
  defenderSignatureAgeDays: z.number().nullable().optional(),
  firewallAllOn: z.boolean().nullable().optional(),
  pendingReboot: z.boolean().nullable().optional(),
  lastUpdateInstalled: z.string().nullable().optional(),
  bitlocker: z.enum(['on', 'off', 'unknown']).optional(),
})

export function parseWindowsHealthOutput(stdout: string): { windows: WindowsFacts; disks: DiskFacts[] | null } {
  // PowerShell may print a warning line before the JSON; take the last line that looks like JSON.
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  if (!line) throw new Error('the Windows health script printed no JSON')
  const raw = windowsOutputSchema.parse(JSON.parse(line))
  return {
    windows: {
      osName: raw.osName ?? null,
      defenderRealtime: raw.defenderRealtime ?? null,
      defenderSignatureAgeDays: raw.defenderSignatureAgeDays ?? null,
      firewallAllOn: raw.firewallAllOn ?? null,
      pendingReboot: raw.pendingReboot ?? null,
      lastUpdateInstalled: raw.lastUpdateInstalled ?? null,
      bitlocker: raw.bitlocker ?? 'unknown',
    },
    disks: raw.disks ?? null,
  }
}

async function nodeDisk(mount: string): Promise<DiskFacts | null> {
  try {
    const s = await statfs(mount)
    return { mount: mount.replace(/\\$/, ''), totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }
  } catch {
    return null
  }
}

export interface CollectOptions {
  platform?: NodeJS.Platform
  run?: CommandRunner
  now?: () => Date
}

export async function collectSystemFacts(options: CollectOptions = {}): Promise<SystemFacts> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runCommand
  const now = options.now ?? (() => new Date())
  const notes: string[] = []

  const adapters = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => (addrs ?? []).some((a) => a.family === 'IPv4' && !a.internal))
    .map(([name]) => name)

  let windows: WindowsFacts | null = null
  let disks: DiskFacts[] | null = null
  if (platform === 'win32') {
    const result = await run('powershell.exe', powershellArgs(WINDOWS_HEALTH_SCRIPT), 45_000)
    try {
      if (result.startError) throw new Error(result.startError)
      if (result.timedOut) throw new Error('timed out')
      const parsed = parseWindowsHealthOutput(result.stdout)
      windows = parsed.windows
      disks = parsed.disks
    } catch (error) {
      notes.push(`Windows checks could not run: ${(error as Error).message}`)
    }
  }
  if (!disks || disks.length === 0) {
    const disk = await nodeDisk(platform === 'win32' ? 'C:\\' : '/')
    disks = disk ? [disk] : []
    if (!disk) notes.push('Disk space could not be read.')
  }

  const cpus = os.cpus()
  return {
    collectedAt: now().toISOString(),
    platform,
    osRelease: os.release(),
    hostname: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length },
    disks,
    network: { connected: adapters.length > 0, adapters },
    windows,
    collectionNotes: notes,
  }
}

// ---------------------------------------------------------------------------------------
// Step 2: rules. Thresholds are the usual help desk rules of thumb, kept in one place.

export const THRESHOLDS = {
  uptimeWarnDays: 7,
  memoryWarnPercent: 90,
  diskWarnFreePercent: 10,
  diskFailFreePercent: 5,
  defenderSignatureWarnDays: 7,
  updateWarnDays: 45,
} as const

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export interface HealthCheckItem {
  id: string
  name: string
  status: CheckStatus
  value: string
  advice: string
  kbArticle: string | null
}

export interface HealthReport {
  overall: CheckStatus
  computer: { hostname: string; os: string; cpu: string; memoryGb: number }
  collectedAt: string
  checks: HealthCheckItem[]
  counts: Record<CheckStatus, number>
  /** A short plain-text summary to paste into a ticket's work notes. */
  ticketNote: string
  collectionNotes: string[]
}

const GB = 1024 ** 3
const gb = (bytes: number) => Math.round((bytes / GB) * 10) / 10

function t(lang: Lang, en: string, es: string): string {
  return lang === 'es' ? es : en
}

export function evaluateHealth(facts: SystemFacts, lang: Lang): HealthReport {
  const checks: HealthCheckItem[] = []
  const add = (item: HealthCheckItem) => checks.push(item)
  const ok = t(lang, 'Nothing to do.', 'No hay que hacer nada.')

  // Uptime: Windows only finishes updates and clears memory leaks on a restart.
  const days = Math.floor(facts.uptimeSeconds / 86_400)
  const hours = Math.floor((facts.uptimeSeconds % 86_400) / 3600)
  add({
    id: 'uptime',
    name: t(lang, 'Time since last restart', 'Tiempo desde el último reinicio'),
    status: days >= THRESHOLDS.uptimeWarnDays ? 'warn' : 'ok',
    value: t(lang, `${days} day(s) ${hours} h`, `${days} día(s) ${hours} h`),
    advice:
      days >= THRESHOLDS.uptimeWarnDays
        ? t(lang, 'Restart the computer. Over a week without a restart often causes slowness and blocks updates.', 'Reinicia la computadora. Más de una semana sin reiniciar suele causar lentitud y bloquea actualizaciones.')
        : ok,
    kbArticle: days >= THRESHOLDS.uptimeWarnDays ? 'KB0007' : null,
  })

  const usedPct = Math.round(((facts.memory.totalBytes - facts.memory.freeBytes) / facts.memory.totalBytes) * 100)
  add({
    id: 'memory',
    name: t(lang, 'Memory in use', 'Memoria en uso'),
    status: usedPct >= THRESHOLDS.memoryWarnPercent ? 'warn' : 'ok',
    value: `${usedPct}% ${t(lang, 'of', 'de')} ${gb(facts.memory.totalBytes)} GB`,
    advice:
      usedPct >= THRESHOLDS.memoryWarnPercent
        ? t(lang, 'Memory is almost full right now. Close apps you are not using, or run the top-processes diagnostic to see which app uses the most.', 'La memoria está casi llena ahora mismo. Cierra las aplicaciones que no usas, o corre el diagnóstico top-processes para ver cuál usa más.')
        : ok,
    kbArticle: usedPct >= THRESHOLDS.memoryWarnPercent ? 'KB0007' : null,
  })

  for (const disk of facts.disks) {
    const freePct = disk.totalBytes > 0 ? Math.round((disk.freeBytes / disk.totalBytes) * 100) : 0
    const status: CheckStatus =
      freePct < THRESHOLDS.diskFailFreePercent ? 'fail' : freePct < THRESHOLDS.diskWarnFreePercent ? 'warn' : 'ok'
    add({
      id: `disk-${disk.mount.replace(/[^A-Za-z0-9]/g, '') || 'root'}`,
      name: t(lang, `Free space on ${disk.mount}`, `Espacio libre en ${disk.mount}`),
      status,
      value: `${gb(disk.freeBytes)} GB ${t(lang, 'free of', 'libres de')} ${gb(disk.totalBytes)} GB (${freePct}%)`,
      advice:
        status === 'ok'
          ? ok
          : t(lang, 'Free up space: Windows needs at least 10% free to update and run well.', 'Libera espacio: Windows necesita por lo menos 10% libre para actualizarse y funcionar bien.'),
      kbArticle: status === 'ok' ? null : 'KB0008',
    })
  }

  add({
    id: 'network',
    name: t(lang, 'Network connection', 'Conexión de red'),
    status: facts.network.connected ? 'ok' : 'fail',
    value: facts.network.connected
      ? t(lang, `Connected (${facts.network.adapters.join(', ')})`, `Conectado (${facts.network.adapters.join(', ')})`)
      : t(lang, 'No network adapter has an IP address', 'Ningún adaptador de red tiene dirección IP'),
    advice: facts.network.connected
      ? t(lang, 'Has an IP address. If websites still fail, run the ping-internet diagnostic.', 'Tiene dirección IP. Si las páginas siguen sin cargar, corre el diagnóstico ping-internet.')
      : t(lang, 'Not connected to any network. Check Wi-Fi or the cable.', 'No está conectado a ninguna red. Verifica el Wi-Fi o el cable.'),
    kbArticle: facts.network.connected ? null : 'KB0003',
  })

  const w = facts.windows
  if (w) {
    const unknownAdvice = t(lang, 'Could not be read without more permissions. A technician can check it.', 'No se pudo leer sin más permisos. Un técnico lo puede verificar.')

    add({
      id: 'antivirus',
      name: t(lang, 'Microsoft Defender real-time protection', 'Protección en tiempo real de Microsoft Defender'),
      status: w.defenderRealtime === null ? 'unknown' : w.defenderRealtime ? 'ok' : 'fail',
      value: w.defenderRealtime === null ? '?' : w.defenderRealtime ? t(lang, 'On', 'Activada') : t(lang, 'Off', 'Desactivada'),
      advice:
        w.defenderRealtime === null
          ? unknownAdvice
          : w.defenderRealtime
            ? ok
            : t(lang, 'Antivirus protection is off. Escalate to a technician; do not ignore this.', 'La protección antivirus está apagada. Escala a un técnico; no lo ignores.'),
      kbArticle: null,
    })

    if (w.defenderSignatureAgeDays !== null) {
      const old = w.defenderSignatureAgeDays > THRESHOLDS.defenderSignatureWarnDays
      add({
        id: 'antivirus-updates',
        name: t(lang, 'Antivirus definitions age', 'Antigüedad de las definiciones del antivirus'),
        status: old ? 'warn' : 'ok',
        value: t(lang, `${w.defenderSignatureAgeDays} day(s) old`, `${w.defenderSignatureAgeDays} día(s)`),
        advice: old ? t(lang, 'Run Windows Update to get new antivirus definitions.', 'Corre Windows Update para recibir definiciones nuevas.') : ok,
        kbArticle: old ? 'KB0012' : null,
      })
    }

    add({
      id: 'firewall',
      name: t(lang, 'Windows Firewall', 'Firewall de Windows'),
      status: w.firewallAllOn === null ? 'unknown' : w.firewallAllOn ? 'ok' : 'fail',
      value: w.firewallAllOn === null ? '?' : w.firewallAllOn ? t(lang, 'On for all profiles', 'Activado en todos los perfiles') : t(lang, 'Off for at least one profile', 'Apagado en por lo menos un perfil'),
      advice:
        w.firewallAllOn === null
          ? unknownAdvice
          : w.firewallAllOn
            ? ok
            : t(lang, 'The firewall is off. Escalate to a technician.', 'El firewall está apagado. Escala a un técnico.'),
      kbArticle: null,
    })

    add({
      id: 'pending-restart',
      name: t(lang, 'Restart pending for updates', 'Reinicio pendiente por actualizaciones'),
      status: w.pendingReboot === null ? 'unknown' : w.pendingReboot ? 'warn' : 'ok',
      value: w.pendingReboot === null ? '?' : w.pendingReboot ? t(lang, 'Yes', 'Sí') : 'No',
      advice: w.pendingReboot ? t(lang, 'Restart to finish installing updates.', 'Reinicia para terminar de instalar las actualizaciones.') : w.pendingReboot === null ? unknownAdvice : ok,
      kbArticle: w.pendingReboot ? 'KB0012' : null,
    })

    if (w.lastUpdateInstalled) {
      const age = Math.floor((Date.parse(facts.collectedAt) - Date.parse(`${w.lastUpdateInstalled}T00:00:00Z`)) / 86_400_000)
      const old = age > THRESHOLDS.updateWarnDays
      add({
        id: 'windows-updates',
        name: t(lang, 'Last Windows update installed', 'Última actualización de Windows instalada'),
        status: old ? 'warn' : 'ok',
        value: t(lang, `${w.lastUpdateInstalled} (${age} days ago)`, `${w.lastUpdateInstalled} (hace ${age} días)`),
        advice: old ? t(lang, 'No updates in over 45 days. Run Windows Update.', 'Más de 45 días sin actualizaciones. Corre Windows Update.') : ok,
        kbArticle: old ? 'KB0012' : null,
      })
    }

    add({
      id: 'disk-encryption',
      name: t(lang, 'Drive encryption (BitLocker / Device Encryption) on C:', 'Cifrado del disco (BitLocker / Cifrado de dispositivo) en C:'),
      status: w.bitlocker === 'unknown' ? 'unknown' : w.bitlocker === 'on' ? 'ok' : 'warn',
      value: w.bitlocker === 'on' ? t(lang, 'On', 'Activado') : w.bitlocker === 'off' ? t(lang, 'Off', 'Apagado') : '?',
      advice:
        w.bitlocker === 'off'
          ? t(lang, 'A work laptop should be encrypted in case it is lost or stolen. A technician turns it on and saves the recovery key.', 'Una laptop de trabajo debe estar cifrada por si se pierde o la roban. Un técnico lo activa y guarda la clave de recuperación.')
          : w.bitlocker === 'unknown'
            ? t(lang, 'Could not be read (Windows Home may not have BitLocker, or it needs admin rights).', 'No se pudo leer (Windows Home puede no tener BitLocker, o requiere permisos de administrador).')
            : ok,
      kbArticle: null,
    })
  }

  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, unknown: 0 }
  for (const c of checks) counts[c.status]++
  const overall: CheckStatus = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok'

  const osName = w?.osName ?? `${facts.platform} ${facts.osRelease}`
  const problems = checks.filter((c) => c.status === 'warn' || c.status === 'fail')
  const ticketNote = [
    `Health check ${facts.collectedAt} on ${facts.hostname} (${osName}): ${overall.toUpperCase()}.`,
    problems.length === 0 ? 'No problems found.' : `Problems: ${problems.map((p) => `${p.id}=${p.status} (${p.value})`).join('; ')}.`,
  ].join(' ')

  return {
    overall,
    computer: { hostname: facts.hostname, os: osName, cpu: `${facts.cpu.model} (${facts.cpu.cores} cores)`, memoryGb: gb(facts.memory.totalBytes) },
    collectedAt: facts.collectedAt,
    checks,
    counts,
    ticketNote,
    collectionNotes: facts.collectionNotes,
  }
}

export function formatHealthReport(r: HealthReport, lang: Lang): string {
  const icon: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', unknown: '?   ' }
  const lines = [
    t(lang, `Health check: ${r.overall.toUpperCase()}`, `Chequeo de salud: ${r.overall.toUpperCase()}`),
    `${r.computer.hostname} | ${r.computer.os} | ${r.computer.cpu} | ${r.computer.memoryGb} GB RAM`,
    '',
  ]
  for (const c of r.checks) {
    lines.push(`[${icon[c.status]}] ${c.name}: ${c.value}`)
    if (c.status !== 'ok') lines.push(`       ${c.advice}${c.kbArticle ? ` (${c.kbArticle})` : ''}`)
  }
  for (const n of r.collectionNotes) lines.push(`${t(lang, 'Note', 'Nota')}: ${n}`)
  lines.push('', t(lang, 'Read-only: this check changed nothing on the computer.', 'Solo lectura: este chequeo no cambió nada en la computadora.'))
  return lines.join('\n')
}
