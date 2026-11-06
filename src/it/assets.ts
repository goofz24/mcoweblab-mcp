import type { Lang } from '../pricing/types.js'
import { ToolInputError } from '../tools/errors.js'
import { normalize } from './kb.js'
import type { Asset, AssetFile, AssetStatus } from './itData.js'

/**
 * Looks up equipment in the asset inventory (a tiny CMDB) by asset tag, serial number or
 * the person it's assigned to, and works out the warranty status and anything that needs
 * attention. Read-only: there is no tool to change an asset.
 */

export const WARRANTY_SOON_DAYS = 90

export interface AssetMatch extends Asset {
  warrantyDaysLeft: number
  warrantyStatus: 'active' | 'ending-soon' | 'expired'
  /** Things a technician should look at. */
  flags: string[]
}

export interface AssetLookupResult {
  query: string | null
  status: AssetStatus | null
  sampleData: boolean
  today: string
  matches: AssetMatch[]
}

const DAY = 86_400_000

function flagsFor(a: Asset, daysLeft: number, lang: Lang): string[] {
  const es = lang === 'es'
  const flags: string[] = []
  const active = a.status === 'deployed' || a.status === 'repair'
  if (active && daysLeft < 0) flags.push(es ? 'Sigue en servicio con la garantía vencida: cualquier reparación se paga.' : 'Still in service with an expired warranty: any repair is paid.')
  if (active && daysLeft >= 0 && daysLeft <= WARRANTY_SOON_DAYS) {
    flags.push(es ? `La garantía vence en ${daysLeft} días: planifica el reemplazo o la extensión.` : `Warranty ends in ${daysLeft} days: plan a replacement or extension.`)
  }
  if (a.status === 'deployed' && !a.assignedTo) flags.push(es ? 'En uso pero sin dueño asignado.' : 'Deployed but has no owner.')
  if (a.status === 'repair') flags.push(es ? 'En reparación: la persona puede necesitar un equipo prestado.' : 'In repair: the person may need a loaner.')
  if (a.status === 'received') flags.push(es ? 'Recibido pero no entregado todavía.' : 'Received but not deployed yet.')
  return flags
}

export function lookupAsset(
  file: AssetFile,
  request: { query?: string; status?: AssetStatus },
  lang: Lang,
  today: Date = new Date(),
): AssetLookupResult {
  const query = request.query?.trim() || null
  if (!query && !request.status) {
    throw new ToolInputError('Give a query (asset tag, serial number or person) or a status to list, for example status "repair".')
  }
  const q = query ? normalize(query) : null
  const todayIso = today.toISOString().slice(0, 10)
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`)

  const matches = file.assets
    .filter((a) => !request.status || a.status === request.status)
    .filter((a) => {
      if (!q) return true
      return normalize(a.tag) === q || normalize(a.serial) === q || (a.assignedTo !== null && normalize(a.assignedTo).includes(q))
    })
    .map((a) => {
      const daysLeft = Math.round((Date.parse(`${a.warrantyEnd}T00:00:00Z`) - todayMs) / DAY)
      return {
        ...a,
        warrantyDaysLeft: daysLeft,
        warrantyStatus: daysLeft < 0 ? 'expired' : daysLeft <= WARRANTY_SOON_DAYS ? 'ending-soon' : 'active',
        flags: flagsFor(a, daysLeft, lang),
      } satisfies AssetMatch
    })

  return { query, status: request.status ?? null, sampleData: file.sample, today: todayIso, matches }
}

export function formatAssets(r: AssetLookupResult, lang: Lang): string {
  const es = lang === 'es'
  if (r.matches.length === 0) {
    return es
      ? `No hay equipos que coincidan${r.query ? ` con "${r.query}"` : ''}. Busca por número de activo (MCO-LT-001), número de serie o nombre de la persona.`
      : `No assets match${r.query ? ` "${r.query}"` : ''}. Search by asset tag (MCO-LT-001), serial number or the person's name.`
  }
  const lines: string[] = []
  if (r.sampleData) lines.push(es ? 'Inventario de EJEMPLO (datos ficticios).' : 'SAMPLE inventory (made-up data).')
  for (const a of r.matches) {
    lines.push(
      '',
      `${a.tag}: ${a.model} (${a.type}), ${es ? 'serie' : 'serial'} ${a.serial}`,
      `${es ? 'Estado' : 'Status'}: ${a.status} | ${es ? 'Asignado a' : 'Assigned to'}: ${a.assignedTo ?? (es ? 'nadie' : 'nobody')} | ${a.location}`,
      `${es ? 'Garantía hasta' : 'Warranty until'} ${a.warrantyEnd} (${a.warrantyStatus}, ${a.warrantyDaysLeft} ${es ? 'días' : 'days'})`,
    )
    if (a.notes) lines.push(`${es ? 'Notas' : 'Notes'}: ${a.notes}`)
    for (const f of a.flags) lines.push(`! ${f}`)
  }
  return lines.join('\n').trim()
}
