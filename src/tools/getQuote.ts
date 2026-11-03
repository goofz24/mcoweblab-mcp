import { calculateQuote } from '../pricing/calculateQuote.js'
import type { Lang, PricingData } from '../pricing/types.js'
import { ToolInputError } from './errors.js'

export interface QuoteRequest {
  projectType: string
  /** Total pages wanted. Defaults to the pages included in the starting price. */
  pages?: number
  addons?: string[]
  maintenance?: boolean
}

export interface QuoteResult {
  projectType: string
  projectName: string
  pages: number
  lineItems: { id: string; name: string; amount: number; confirmed: boolean }[]
  /** Starting estimate in whole dollars: the exact sum of the line items. */
  estimateLow: number
  /** Upper end of the range (low plus a buffer, rounded up). */
  estimateHigh: number
  /** Monthly maintenance, billed separately. 0 when not requested. */
  monthly: number
  typicalWeeks: number
  /** True when any number in this quote is still a placeholder Mel hasn't approved. */
  isDraft: boolean
  /** The exact price-list values this quote used that are still placeholders. */
  unconfirmedValuesUsed: string[]
  notes: string[]
}

/**
 * Reuses the quote calculator's calculateQuote() so the website and Claude can never disagree
 * on a price. This wrapper adds what an AI caller needs: clear errors it can recover from,
 * and an honest list of which numbers are still drafts.
 */
export function getQuote(pricing: PricingData, request: QuoteRequest, lang: Lang): QuoteResult {
  const type = pricing.projectTypes.find((t) => t.id === request.projectType)
  if (!type) {
    const valid = pricing.projectTypes.map((t) => t.id).join(', ')
    throw new ToolInputError(`Unknown projectType "${request.projectType}". Use one of: ${valid}.`)
  }

  const notes: string[] = []
  const addonIds = [...new Set(request.addons ?? [])]
  const allowed = pricing.addons.filter((a) => a.appliesTo.includes(type.id))
  for (const id of addonIds) {
    const addon = pricing.addons.find((a) => a.id === id)
    if (!addon) {
      throw new ToolInputError(`Unknown add-on "${id}". Add-ons for ${type.id}: ${allowed.map((a) => a.id).join(', ') || 'none'}.`)
    }
    if (!addon.appliesTo.includes(type.id)) {
      throw new ToolInputError(
        `The add-on "${id}" isn't available for ${type.id}. Add-ons for ${type.id}: ${allowed.map((a) => a.id).join(', ') || 'none'}.`,
      )
    }
  }

  let pages = request.pages ?? type.includedPages
  if (pages > type.maxPages) {
    throw new ToolInputError(
      `${type.id} goes up to ${type.maxPages} pages in the calculator. For more pages, suggest the client book a free consultation for a custom quote.`,
    )
  }
  if (pages < type.includedPages) {
    notes.push(`The starting price already includes ${type.includedPages} page(s), so the quote uses ${type.includedPages}.`)
    pages = type.includedPages
  }

  const quote = calculateQuote(pricing, {
    projectTypeId: type.id,
    pages,
    addonIds,
    rushRequested: false, // Mel turned rush delivery off for the first launch.
    maintenance: request.maintenance ?? false,
  })
  // calculateQuote only returns null for an unknown type, which was checked above.
  if (!quote) throw new Error('calculateQuote returned no quote for a known project type')

  // Work out which price-list values this particular quote depends on.
  const extraPages = pages - type.includedPages
  const used = [`projectTypes.${type.id}.basePrice`, `projectTypes.${type.id}.includedPages`, `projectTypes.${type.id}.baseWeeks`]
  if (extraPages > 0) used.push(`projectTypes.${type.id}.extraPagePrice`, `projectTypes.${type.id}.extraPagesPerWeek`)
  for (const id of addonIds) used.push(`addons.${id}.price`, `addons.${id}.extraWeeks`)
  if (pricing.estimate.upperBufferPercent > 0) used.push('estimate.upperBufferPercent')
  if (request.maintenance) used.push('maintenance.monthlyPrice')
  const unconfirmed = new Set(pricing.unconfirmed)
  const unconfirmedValuesUsed = used.filter((path) => unconfirmed.has(path))

  const lineConfirmed = (id: string): boolean => {
    if (id === type.id) return !unconfirmed.has(`projectTypes.${type.id}.basePrice`)
    if (id === 'extra-pages') return !unconfirmed.has(`projectTypes.${type.id}.extraPagePrice`)
    return !unconfirmed.has(`addons.${id}.price`)
  }

  notes.push('Estimates are a starting point. The final price is confirmed after a free consultation.')

  return {
    projectType: type.id,
    projectName: type.label[lang],
    pages,
    lineItems: quote.lineItems.map((item) => ({
      id: item.id,
      name: item.label[lang],
      amount: item.amount,
      confirmed: lineConfirmed(item.id),
    })),
    estimateLow: quote.low,
    estimateHigh: quote.high,
    monthly: quote.monthly,
    typicalWeeks: quote.weeks,
    isDraft: unconfirmedValuesUsed.length > 0,
    unconfirmedValuesUsed,
    notes,
  }
}

export function formatQuote(q: QuoteResult, lang: Lang): string {
  const es = lang === 'es'
  const lines: string[] = []
  if (q.isDraft) {
    lines.push(
      es
        ? 'BORRADOR: esta cotización usa precios que Mel aún no ha aprobado. No la presentes como precio final.'
        : 'DRAFT: this quote uses prices Mel has not approved yet. Do not present it as a final price.',
    )
  }
  lines.push(`${q.projectName}, ${q.pages} ${es ? 'página(s)' : 'page(s)'}`)
  for (const item of q.lineItems) {
    lines.push(`- ${item.name}: $${item.amount}${item.confirmed ? '' : es ? ' (borrador)' : ' (draft)'}`)
  }
  const range = q.estimateHigh > q.estimateLow ? `$${q.estimateLow} - $${q.estimateHigh}` : `$${q.estimateLow}`
  lines.push(`${es ? 'Estimado' : 'Estimate'}: ${range}`)
  if (q.monthly > 0) lines.push(`${es ? 'Mantenimiento' : 'Maintenance'}: $${q.monthly}/${es ? 'mes' : 'month'}`)
  lines.push(`${es ? 'Tiempo típico' : 'Typical timeline'}: ${q.typicalWeeks} ${es ? 'semana(s)' : 'week(s)'}`)
  for (const note of q.notes) lines.push(`${es ? 'Nota' : 'Note'}: ${note}`)
  return lines.join('\n')
}
