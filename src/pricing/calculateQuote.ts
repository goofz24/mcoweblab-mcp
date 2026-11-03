import type { LineItem, PricingData, Quote, Selections } from './types.js'

/**
 * Rounding policy (documented in the README):
 * - All prices are whole dollars, and the starting estimate (`low`) is their exact sum.
 *   A $399 base price stays $399.
 * - The rush fee is a percentage of the subtotal, rounded to the nearest whole dollar,
 *   and shown as its own line, so the breakdown always adds up to `low`.
 * - Only the upper end of the range is rounded, and always UP to the rounding step,
 *   so it never drops below low × (1 + buffer).
 */
export function roundUpToStep(value: number, step: number): number {
  if (step <= 1) return Math.ceil(value)
  return Math.ceil(value / step) * step
}

/** Turns the visitor's selections into a quote. Pure: same input, same output, no side effects. */
export function calculateQuote(pricing: PricingData, selections: Selections): Quote | null {
  const type = pricing.projectTypes.find((t) => t.id === selections.projectTypeId)
  if (!type) return null

  const lineItems: LineItem[] = [{ id: type.id, label: type.label, amount: type.basePrice }]

  const pages = clamp(Math.round(selections.pages), type.includedPages, type.maxPages)
  const extraPages = pages - type.includedPages
  if (extraPages > 0 && type.extraPagePrice > 0) {
    lineItems.push({
      id: 'extra-pages',
      label: {
        en: `${extraPages} extra page${extraPages === 1 ? '' : 's'}`,
        es: `${extraPages} página${extraPages === 1 ? '' : 's'} adicional${extraPages === 1 ? '' : 'es'}`,
      },
      amount: extraPages * type.extraPagePrice,
    })
  }

  // Only add-ons that were picked AND fit this project type, each counted once, in config order.
  const picked = new Set(selections.addonIds)
  const addons = pricing.addons.filter((a) => picked.has(a.id) && a.appliesTo.includes(type.id))
  for (const addon of addons) {
    lineItems.push({ id: addon.id, label: addon.label, amount: addon.price })
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0)
  const rushRequested = selections.rushRequested && pricing.rush.offered
  const rushFee = rushRequested ? Math.round((subtotal * pricing.rush.feePercent) / 100) : 0
  const low = subtotal + rushFee

  const { upperBufferPercent, upperRoundingStep } = pricing.estimate
  const high = upperBufferPercent > 0 ? roundUpToStep((low * (100 + upperBufferPercent)) / 100, upperRoundingStep) : low

  return {
    lineItems,
    subtotal,
    rushFee,
    rushRequested,
    low,
    high: Math.max(high, low),
    monthly: selections.maintenance ? pricing.maintenance.monthlyPrice : 0,
    weeks: estimateWeeks(type.baseWeeks, extraPages, type.extraPagesPerWeek, addons.map((a) => a.extraWeeks)),
  }
}

/**
 * Timeline policy: base weeks for the project type, plus one week per block of extra pages,
 * plus each add-on's extra weeks. Rush does NOT shorten it: faster delivery is a request
 * that has to be confirmed after the consultation.
 */
export function estimateWeeks(
  baseWeeks: number,
  extraPages: number,
  extraPagesPerWeek: number,
  addonWeeks: number[],
): number {
  const pageWeeks = extraPagesPerWeek > 0 && extraPages > 0 ? Math.ceil(extraPages / extraPagesPerWeek) : 0
  return baseWeeks + pageWeeks + addonWeeks.reduce((sum, w) => sum + w, 0)
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}
