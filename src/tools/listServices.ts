import type { Lang, PricingData } from '../pricing/types.js'

export interface ServiceSummary {
  id: string
  name: string
  description: string
  startingPrice: number
  /** True when Mel has approved this starting price (it matches mcoweblab.com/services). */
  startingPriceConfirmed: boolean
  includedPages: number
  maxPages: number
  addons: { id: string; name: string; price: number; priceConfirmed: boolean }[]
}

export interface ListServicesResult {
  currency: string
  services: ServiceSummary[]
  maintenance: { name: string; monthlyPrice: number; monthlyPriceConfirmed: boolean }
  rushDeliveryOffered: boolean
  /** How many prices or assumptions in the price list still need Mel's approval. */
  unconfirmedValueCount: number
}

/** Pure function: price list in, plain summary out. The MCP layer only wraps it. */
export function listServices(pricing: PricingData, lang: Lang): ListServicesResult {
  const unconfirmed = new Set(pricing.unconfirmed)
  return {
    currency: pricing.currency,
    services: pricing.projectTypes.map((type) => ({
      id: type.id,
      name: type.label[lang],
      description: type.description[lang],
      startingPrice: type.basePrice,
      startingPriceConfirmed: !unconfirmed.has(`projectTypes.${type.id}.basePrice`),
      includedPages: type.includedPages,
      maxPages: type.maxPages,
      addons: pricing.addons
        .filter((addon) => addon.appliesTo.includes(type.id))
        .map((addon) => ({
          id: addon.id,
          name: addon.label[lang],
          price: addon.price,
          priceConfirmed: !unconfirmed.has(`addons.${addon.id}.price`),
        })),
    })),
    maintenance: {
      name: pricing.maintenance.label[lang],
      monthlyPrice: pricing.maintenance.monthlyPrice,
      monthlyPriceConfirmed: !unconfirmed.has('maintenance.monthlyPrice'),
    },
    rushDeliveryOffered: pricing.rush.offered,
    unconfirmedValueCount: pricing.unconfirmed.length,
  }
}

/** The same result as readable text, for MCP clients that only show text. */
export function formatServices(result: ListServicesResult, lang: Lang): string {
  const es = lang === 'es'
  const draft = es ? ' (borrador, no aprobado)' : ' (draft, not approved)'
  const lines: string[] = [es ? 'Servicios de MCO WebLab:' : 'MCO WebLab services:']
  for (const s of result.services) {
    lines.push(`- ${s.name} [${s.id}]: ${es ? 'desde' : 'from'} $${s.startingPrice}${s.startingPriceConfirmed ? '' : draft}. ${s.description}`)
    for (const a of s.addons) {
      lines.push(`    + ${a.name} [${a.id}]: $${a.price}${a.priceConfirmed ? '' : draft}`)
    }
  }
  const m = result.maintenance
  lines.push(`- ${m.name}: $${m.monthlyPrice}/${es ? 'mes' : 'month'}${m.monthlyPriceConfirmed ? '' : draft}`)
  if (!result.rushDeliveryOffered) {
    lines.push(es ? 'No se ofrece entrega urgente por ahora.' : 'Rush delivery is not offered right now.')
  }
  if (result.unconfirmedValueCount > 0) {
    lines.push(
      es
        ? `Nota: ${result.unconfirmedValueCount} valores de la lista de precios son borradores. Solo los precios iniciales y el mantenimiento están aprobados.`
        : `Note: ${result.unconfirmedValueCount} values in the price list are drafts. Only the starting prices and maintenance are approved.`,
    )
  }
  return lines.join('\n')
}
