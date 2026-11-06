import { describe, expect, it } from 'vitest'
import { loadShopData } from '../src/data.js'
import { lookupAsset } from '../src/it/assets.js'
import { DIAGNOSTIC_IDS, DIAGNOSTICS, runDiagnostic, topProcessesFromTasklist } from '../src/it/diagnostics.js'
import { collectSystemFacts, evaluateHealth, parseWindowsHealthOutput, type SystemFacts } from '../src/it/healthCheck.js'
import { buildCreateUrl, draftIncident, PRIORITY_MATRIX, validInstance } from '../src/it/incident.js'
import { parseAssets, parseKb } from '../src/it/itData.js'
import { normalize, searchKb } from '../src/it/kb.js'
import type { CommandRunner } from '../src/it/powershell.js'
import { PASSWORD_MASK, redactArgs, redactOutput, redactPasswords } from '../src/it/redact.js'
import { ToolInputError } from '../src/tools/errors.js'

const data = loadShopData()
const GB = 1024 ** 3

/** A healthy Windows laptop. Each test changes one thing. */
function facts(overrides: Partial<SystemFacts> = {}, windows: Partial<NonNullable<SystemFacts['windows']>> = {}): SystemFacts {
  return {
    collectedAt: '2026-11-06T12:00:00.000Z',
    platform: 'win32',
    osRelease: '10.0.26100',
    hostname: 'TEST-LAPTOP',
    uptimeSeconds: 2 * 86_400 + 3 * 3600,
    memory: { totalBytes: 16 * GB, freeBytes: 8 * GB },
    cpu: { model: 'Test CPU', cores: 8 },
    disks: [{ mount: 'C:', totalBytes: 500 * GB, freeBytes: 200 * GB }],
    network: { connected: true, adapters: ['Wi-Fi'] },
    windows: {
      osName: 'Microsoft Windows 11 Home',
      defenderRealtime: true,
      defenderSignatureAgeDays: 0,
      firewallAllOn: true,
      pendingReboot: false,
      lastUpdateInstalled: '2026-10-20',
      bitlocker: 'on',
      ...windows,
    },
    collectionNotes: [],
    ...overrides,
  }
}
const statusOf = (r: ReturnType<typeof evaluateHealth>, id: string) => r.checks.find((c) => c.id === id)?.status

describe('health check rules', () => {
  it('reports OK for a healthy laptop', () => {
    const r = evaluateHealth(facts(), 'en')
    expect(r.overall).toBe('ok')
    expect(r.counts).toEqual({ ok: 10, warn: 0, fail: 0, unknown: 0 })
    expect(r.ticketNote).toContain('No problems found')
  })

  it('warns after a week without a restart and links the slow-computer article', () => {
    const r = evaluateHealth(facts({ uptimeSeconds: 9 * 86_400 }), 'en')
    const uptime = r.checks.find((c) => c.id === 'uptime')!
    expect(uptime.status).toBe('warn')
    expect(uptime.kbArticle).toBe('KB0007')
    expect(r.overall).toBe('warn')
  })

  it('warns under 10% free disk and fails under 5%', () => {
    const disk = (freeGb: number) => facts({ disks: [{ mount: 'C:', totalBytes: 100 * GB, freeBytes: freeGb * GB }] })
    expect(statusOf(evaluateHealth(disk(8), 'en'), 'disk-C')).toBe('warn')
    expect(statusOf(evaluateHealth(disk(3), 'en'), 'disk-C')).toBe('fail')
    expect(evaluateHealth(disk(3), 'en').checks.find((c) => c.id === 'disk-C')!.kbArticle).toBe('KB0008')
  })

  it('fails when antivirus or firewall is off, or there is no network', () => {
    expect(statusOf(evaluateHealth(facts({}, { defenderRealtime: false }), 'en'), 'antivirus')).toBe('fail')
    expect(statusOf(evaluateHealth(facts({}, { firewallAllOn: false }), 'en'), 'firewall')).toBe('fail')
    const offline = evaluateHealth(facts({ network: { connected: false, adapters: [] } }), 'en')
    expect(statusOf(offline, 'network')).toBe('fail')
    expect(offline.overall).toBe('fail')
  })

  it('warns on old updates, a pending restart and drive encryption off', () => {
    const r = evaluateHealth(facts({}, { lastUpdateInstalled: '2026-08-01', pendingReboot: true, bitlocker: 'off' }), 'en')
    expect(statusOf(r, 'windows-updates')).toBe('warn')
    expect(statusOf(r, 'pending-restart')).toBe('warn')
    expect(statusOf(r, 'disk-encryption')).toBe('warn')
    expect(r.ticketNote).toMatch(/windows-updates=warn/)
  })

  it('says "unknown" instead of guessing when a fact could not be read', () => {
    const r = evaluateHealth(facts({}, { defenderRealtime: null, firewallAllOn: null, bitlocker: 'unknown' }), 'en')
    expect(statusOf(r, 'antivirus')).toBe('unknown')
    expect(statusOf(r, 'firewall')).toBe('unknown')
    expect(r.overall).toBe('ok') // unknown is not a problem, but it is shown
  })

  it('speaks Spanish', () => {
    const r = evaluateHealth(facts({ uptimeSeconds: 9 * 86_400 }), 'es')
    expect(r.checks[0].name).toBe('Tiempo desde el último reinicio')
    expect(r.checks[0].advice).toMatch(/^Reinicia la computadora/)
  })

  it('reads the JSON the Windows script prints, even after a warning line', () => {
    const out =
      'WARNING: something\r\n{"osName":"Microsoft Windows 11 Home","disks":[{"mount":"C:","totalBytes":512000000000,"freeBytes":100000000000}],' +
      '"defenderRealtime":true,"defenderSignatureAgeDays":1,"firewallAllOn":true,"pendingReboot":false,"lastUpdateInstalled":"2026-10-30","bitlocker":"unknown"}\r\n'
    const parsed = parseWindowsHealthOutput(out)
    expect(parsed.windows).toMatchObject({ osName: 'Microsoft Windows 11 Home', bitlocker: 'unknown', defenderSignatureAgeDays: 1 })
    expect(parsed.disks).toHaveLength(1)
  })

  it('collects real facts from the computer running the tests (read-only)', async () => {
    const real = await collectSystemFacts({ platform: process.platform === 'win32' ? 'linux' : process.platform })
    expect(real.memory.totalBytes).toBeGreaterThan(0)
    expect(real.disks.length).toBeGreaterThan(0)
    expect(evaluateHealth(real, 'en').checks.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps working when the Windows script cannot run', async () => {
    const broken: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: false, startError: 'powershell.exe is not installed' })
    const f = await collectSystemFacts({ platform: 'win32', run: broken })
    expect(f.windows).toBeNull()
    expect(f.collectionNotes[0]).toMatch(/Windows checks could not run/)
  })
})

describe('allowlisted diagnostics', () => {
  const calls: { file: string; args: readonly string[] }[] = []
  const fake: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    return { stdout: 'Physical Address. . . : 3C-52-82-AA-BB-CC\r\nC:\\Users\\mco23\\AppData\nPing OK', stderr: '', exitCode: 0, timedOut: false }
  }

  it('only has read-only commands on the list', () => {
    const banned = /\b(del|rm|remove|set-|stop-|restart|shutdown|format-volume|format [a-z]:|reg add|net user|install|uninstall|new-|disable|enable)\b/i
    for (const id of DIAGNOSTIC_IDS) {
      for (const spec of [DIAGNOSTICS[id].windows, DIAGNOSTICS[id].other]) {
        if (!spec) continue
        const args: readonly string[] = spec.args
        const decoded = args.includes('-EncodedCommand') ? Buffer.from(args.at(-1)!, 'base64').toString('utf16le') : args.join(' ')
        expect(`${spec.file} ${decoded}`).not.toMatch(banned)
      }
    }
  })

  it('refuses anything that is not on the allowlist', async () => {
    await expect(runDiagnostic('format-c', 'en', { platform: 'win32', run: fake })).rejects.toThrow(ToolInputError)
    await expect(runDiagnostic('constructor', 'en', { platform: 'win32', run: fake })).rejects.toThrow(/not an allowed diagnostic/)
  })

  it('runs the fixed command for the platform and hides MAC addresses and the user name', async () => {
    calls.length = 0
    const r = await runDiagnostic('network-config', 'en', { platform: 'win32', run: fake })
    expect(calls).toEqual([{ file: 'ipconfig', args: ['/all'] }])
    expect(r.output).toContain('[MAC hidden]')
    expect(r.output).not.toContain('3C-52-82')
    expect(r.output).toContain('C:\\Users\\<user>\\AppData')
    expect(r.ok).toBe(true)
  })

  it('explains when a diagnostic only exists on Windows', async () => {
    await expect(runDiagnostic('recent-system-errors', 'en', { platform: 'linux', run: fake })).rejects.toThrow(/only works on Windows/)
  })

  it('treats a failed ping as a finding, not a crash, and cuts very long output', async () => {
    const lossy: CommandRunner = async () => ({ stdout: 'x'.repeat(10_000), stderr: '', exitCode: 1, timedOut: false })
    const r = await runDiagnostic('ping-internet', 'en', { platform: 'win32', run: lossy })
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBeLessThan(6100)
  })

  it('sorts tasklist output by memory and keeps the top 15', () => {
    const csv = ['"chrome.exe","100","Console","1","350,000 K"', '"Code.exe","200","Console","1","1,200,000 K"', '"notepad.exe","300","Console","1","12,000 K"'].join('\r\n')
    const lines = topProcessesFromTasklist(csv).split('\n')
    expect(lines[1]).toMatch(/1172\s+200\s+Code\.exe/)
    expect(lines[3]).toMatch(/notepad\.exe/)
  })
})

describe('redaction guardrails', () => {
  it('removes passwords in English and Spanish', () => {
    expect(redactPasswords('my password is Summer2026!').text).toBe(`my password is ${PASSWORD_MASK}`)
    expect(redactPasswords('contraseña: Coqui#77').text).toBe(`contraseña: ${PASSWORD_MASK}`)
    expect(redactPasswords('mi clave es Borinquen1').redacted).toBe(true)
    expect(redactPasswords('pwd=hunter22').text).toBe(`pwd=${PASSWORD_MASK}`)
  })

  it('leaves normal sentences about passwords alone', () => {
    for (const s of ['I need a password reset', 'my password expired today', 'olvidé mi contraseña', 'the password page is down', 'contraseña nueva']) {
      expect(redactPasswords(s)).toEqual({ text: s, redacted: false })
    }
  })

  it('cleans every string inside tool arguments for the log', () => {
    expect(redactArgs({ a: 'password: x9x9x9', b: ['ok'], n: 3 })).toEqual({ a: `password: ${PASSWORD_MASK}`, b: ['ok'], n: 3 })
  })

  it('hides a given user name and Linux home paths', () => {
    expect(redactOutput('User: DESKTOP\\melvin /home/melvin/x', 'melvin')).toBe('User: DESKTOP\\<user> /home/<user>/x')
  })
})

describe('knowledge base search', () => {
  it('finds the right article in English, Spanish, without accents, and mixed', () => {
    expect(searchKb(data.it.kb, 'The printer says offline', 'en').matches[0].id).toBe('KB0005')
    expect(searchKb(data.it.kb, 'la impresora no imprime', 'es').matches[0].id).toBe('KB0005')
    expect(searchKb(data.it.kb, 'olvide mi contrasena', 'es').matches[0].id).toBe('KB0001')
    expect(searchKb(data.it.kb, 'el vpn no conecta desde casa', 'en').matches[0].id).toBe('KB0004')
    expect(searchKb(data.it.kb, 'I clicked a link in a phishing email', 'en').matches[0].id).toBe('KB0009')
  })

  it('answers in the language asked for and marks technician-only articles', () => {
    const r = searchKb(data.it.kb, 'password locked', 'es')
    expect(r.matches[0]).toMatchObject({ id: 'KB0001', selfService: false, title: 'Olvidé mi contraseña o mi cuenta está bloqueada' })
  })

  it('returns nothing (not a random article) when nothing matches', () => {
    expect(searchKb(data.it.kb, 'how do I bake bread', 'en').matches).toEqual([])
  })

  it('normalizes accents and case', () => {
    expect(normalize('Contraseña  OLVIDÉ!')).toBe('contrasena olvide')
  })

  it('rejects a broken knowledge base file at startup', () => {
    expect(() => parseKb({ sample: true, articles: [{ id: 'KB1' }] })).toThrow(/it-kb.json is invalid/)
    const a = data.it.kb.articles[0]
    expect(() => parseKb({ sample: true, articles: [a, a] })).toThrow(/KB0001" twice/)
  })
})

describe('asset lookup', () => {
  const today = new Date('2026-11-06T12:00:00Z')

  it('finds by tag, serial or person, ignoring case and accents', () => {
    expect(lookupAsset(data.it.assets, { query: 'mco-lt-001' }, 'en', today).matches.map((a) => a.tag)).toEqual(['MCO-LT-001'])
    expect(lookupAsset(data.it.assets, { query: 'SMPL-TPE14-0002' }, 'en', today).matches[0].tag).toBe('MCO-LT-002')
    expect(lookupAsset(data.it.assets, { query: 'luis torres' }, 'en', today).matches.map((a) => a.tag)).toEqual(['MCO-LT-002', 'MCO-PH-001'])
  })

  it('works out warranty status and flags', () => {
    const luis = lookupAsset(data.it.assets, { query: 'Luis' }, 'en', today).matches
    expect(luis[0]).toMatchObject({ tag: 'MCO-LT-002', warrantyStatus: 'ending-soon', warrantyDaysLeft: 25 })
    expect(luis[0].flags[0]).toMatch(/Warranty ends in 25 days/)
    expect(luis[1]).toMatchObject({ tag: 'MCO-PH-001', warrantyStatus: 'expired' })
    expect(luis[1].flags[0]).toMatch(/expired warranty/)
  })

  it('lists by lifecycle status', () => {
    const repair = lookupAsset(data.it.assets, { status: 'repair' }, 'es', today)
    expect(repair.matches.map((a) => a.tag)).toEqual(['MCO-LT-003'])
    expect(repair.matches[0].flags).toContain('En reparación: la persona puede necesitar un equipo prestado.')
  })

  it('asks for a query or a status instead of dumping everything', () => {
    expect(() => lookupAsset(data.it.assets, {}, 'en', today)).toThrow(ToolInputError)
  })

  it('rejects a bad asset file at startup', () => {
    expect(() => parseAssets({ sample: true, assets: [{ ...data.it.assets.assets[0], status: 'lost' }] })).toThrow(/it-assets.json is invalid/)
  })
})

describe('incident draft', () => {
  const base = { shortDescription: 'Outlook not sending email', description: 'Emails stay in the Outbox since 9am. Tried KB0006 steps.', category: 'software' as const }

  it('uses the ServiceNow impact x urgency priority matrix', () => {
    expect(PRIORITY_MATRIX[1][1]).toBe(1)
    expect(PRIORITY_MATRIX[2][2]).toBe(3)
    expect(PRIORITY_MATRIX[3][3]).toBe(5)
    const d = draftIncident(data.it, { ...base, impact: 3, urgency: 2 }, 'en')
    expect(d.fields).toMatchObject({ priority: 4, assignment_group: 'Service Desk', category: 'software' })
    expect(d.priorityLabel).toBe('4 - Low')
    expect(d.created).toBe(false)
    expect(d.escalateToHuman).toBe(false)
  })

  it('removes a password typed into the ticket and warns', () => {
    const d = draftIncident(data.it, { ...base, description: 'It asks again. My password is Coqui2026! and it fails.' }, 'en')
    expect(d.fields.description).not.toContain('Coqui2026')
    expect(d.fields.description).toContain(PASSWORD_MASK)
    expect(d.warnings[0]).toMatch(/password was removed/)
  })

  it('flags possible security incidents, raises urgency and routes to Security', () => {
    const d = draftIncident(data.it, { ...base, shortDescription: 'Le di click a un enlace sospechoso', description: 'Recibí un correo de phishing y le di click.', category: 'inquiry' }, 'es')
    expect(d.escalateToHuman).toBe(true)
    expect(d.fields).toMatchObject({ urgency: 1, impact: 2, priority: 2, assignment_group: 'Security' })
    expect(d.escalationReasons[0]).toMatch(/seguridad/)
  })

  it('flags password resets and admin rights requests for a person', () => {
    expect(draftIncident(data.it, { ...base, description: 'I forgot my password and my account locked after 3 tries.' }, 'en').escalationReasons[0]).toMatch(/verify identity/)
    expect(draftIncident(data.it, { ...base, description: 'Please give me admin rights so I can install Spotify.' }, 'en').escalationReasons[0]).toMatch(/manager/)
  })

  it('links a known asset and KB article, and rejects unknown ones', () => {
    const d = draftIncident(data.it, { ...base, assetTag: 'mco-lt-001', kbArticleId: 'kb0006' }, 'en')
    expect(d.linkedAsset).toBe('MCO-LT-001 (Dell Latitude 5450, serial SMPL-DL5450-0001)')
    expect(d.fields.description).toContain('KB already tried or suggested: KB0006')
    expect(() => draftIncident(data.it, { ...base, assetTag: 'MCO-LT-999' }, 'en')).toThrow(/lookup_asset/)
    expect(() => draftIncident(data.it, { ...base, kbArticleId: 'KB9999' }, 'en')).toThrow(/search_kb/)
  })

  it('builds a pre-filled "new incident" link only for a valid instance name', () => {
    expect(draftIncident(data.it, base, 'en').createUrl).toBeNull()
    const d = draftIncident(data.it, { ...base, shortDescription: 'A^B test' }, 'en', 'dev123456')
    const url = new URL(d.createUrl!)
    expect(url.origin).toBe('https://dev123456.service-now.com')
    expect(url.searchParams.get('sys_id')).toBe('-1')
    const query = url.searchParams.get('sysparm_query')!
    expect(query.startsWith('short_description=A B test^description=')).toBe(true)
    expect(query).toContain('^impact=3^urgency=3^')
    expect(validInstance('evil.com/x')).toBeNull()
    expect(validInstance('dev123456')).toBe('dev123456')
    expect(buildCreateUrl('dev1', d.fields)).toMatch(/^https:\/\/dev1\.service-now\.com\/incident\.do\?sys_id=-1&sysparm_query=/)
  })
})
