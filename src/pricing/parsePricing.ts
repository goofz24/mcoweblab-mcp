import type { Addon, LocalizedText, PricingData, ProjectType } from './types.js'

export const SUPPORTED_PRICING_VERSION = 2

/** Thrown when pricing.json is broken. `problems` lists every issue found, for the site owner. */
export class PricingError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Pricing data is invalid: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`)
    this.name = 'PricingError'
    this.problems = problems
  }
}

/**
 * The JSON comes from a server, so TypeScript can't know its shape at compile time.
 * This checks every field at runtime and collects ALL problems, instead of letting
 * the app crash later or quietly show a wrong price.
 */
export function parsePricing(raw: unknown): PricingData {
  const problems: string[] = []
  const v = new Validator(problems)

  if (!isObject(raw)) throw new PricingError(['the file is not a JSON object'])

  if (raw.version !== SUPPORTED_PRICING_VERSION) {
    problems.push(`version must be ${SUPPORTED_PRICING_VERSION} (found ${JSON.stringify(raw.version)})`)
  }

  const currency = v.currency(raw.currency, 'currency')

  const estimate = v.object(raw.estimate, 'estimate')
  const upperBufferPercent = v.integer(estimate?.upperBufferPercent, 'estimate.upperBufferPercent', 0, 100)
  const upperRoundingStep = v.integer(estimate?.upperRoundingStep, 'estimate.upperRoundingStep', 1, 1000)

  const rush = v.object(raw.rush, 'rush')
  const rushOffered = v.boolean(rush?.offered, 'rush.offered')
  const rushFeePercent = v.integer(rush?.feePercent, 'rush.feePercent', 0, 100)

  // Project types
  const projectTypes: ProjectType[] = []
  if (!Array.isArray(raw.projectTypes) || raw.projectTypes.length === 0) {
    problems.push('projectTypes must be a non-empty list')
  } else {
    raw.projectTypes.forEach((item, i) => {
      const at = `projectTypes[${i}]`
      const t = v.object(item, at)
      if (!t) return
      const id = v.id(t.id, `${at}.id`)
      const name = id ? `projectTypes.${id}` : at
      const parsed: ProjectType = {
        id: id ?? '',
        label: v.text(t.label, `${name}.label`),
        description: v.text(t.description, `${name}.description`),
        basePrice: v.money(t.basePrice, `${name}.basePrice`),
        includedPages: v.integer(t.includedPages, `${name}.includedPages`, 1, 500),
        extraPagePrice: v.money(t.extraPagePrice, `${name}.extraPagePrice`),
        maxPages: v.integer(t.maxPages, `${name}.maxPages`, 1, 500),
        baseWeeks: v.integer(t.baseWeeks, `${name}.baseWeeks`, 1, 104),
        extraPagesPerWeek: v.integer(t.extraPagesPerWeek, `${name}.extraPagesPerWeek`, 0, 500),
      }
      if (parsed.maxPages < parsed.includedPages) {
        problems.push(`${name}: maxPages (${parsed.maxPages}) is smaller than includedPages (${parsed.includedPages})`)
      }
      projectTypes.push(parsed)
    })
    v.unique(projectTypes.map((t) => t.id), 'project type id')
  }
  const typeIds = new Set(projectTypes.map((t) => t.id))

  // Add-ons
  const addons: Addon[] = []
  if (!Array.isArray(raw.addons)) {
    problems.push('addons must be a list (it can be empty)')
  } else {
    raw.addons.forEach((item, i) => {
      const at = `addons[${i}]`
      const a = v.object(item, at)
      if (!a) return
      const id = v.id(a.id, `${at}.id`)
      const name = id ? `addons.${id}` : at
      const appliesTo: string[] = []
      if (!Array.isArray(a.appliesTo) || a.appliesTo.length === 0) {
        problems.push(`${name}.appliesTo must list at least one project type id`)
      } else {
        for (const ref of a.appliesTo) {
          if (typeof ref !== 'string' || !typeIds.has(ref)) {
            problems.push(`${name}.appliesTo has an unknown project type: ${JSON.stringify(ref)}`)
          } else if (appliesTo.includes(ref)) {
            problems.push(`${name}.appliesTo lists "${ref}" twice`)
          } else {
            appliesTo.push(ref)
          }
        }
      }
      addons.push({
        id: id ?? '',
        label: v.text(a.label, `${name}.label`),
        price: v.money(a.price, `${name}.price`),
        extraWeeks: v.integer(a.extraWeeks, `${name}.extraWeeks`, 0, 52),
        appliesTo,
      })
    })
    v.unique(addons.map((a) => a.id), 'add-on id')
  }

  const maintenance = v.object(raw.maintenance, 'maintenance')
  const maintenanceLabel = v.text(maintenance?.label, 'maintenance.label')
  const monthlyPrice = v.money(maintenance?.monthlyPrice, 'maintenance.monthlyPrice')

  // Placeholders still waiting for approval
  const unconfirmed: string[] = []
  if (!Array.isArray(raw.unconfirmed)) {
    problems.push('unconfirmed must be a list (use [] once every value is approved)')
  } else {
    for (const path of raw.unconfirmed) {
      if (typeof path !== 'string' || !pathExists(path, raw)) {
        problems.push(`unconfirmed lists a value that does not exist: ${JSON.stringify(path)}`)
      } else {
        unconfirmed.push(path)
      }
    }
  }

  if (problems.length > 0) throw new PricingError(problems)

  return {
    version: SUPPORTED_PRICING_VERSION,
    currency,
    unconfirmed,
    estimate: { upperBufferPercent, upperRoundingStep },
    rush: { offered: rushOffered, feePercent: rushFeePercent },
    projectTypes,
    addons,
    maintenance: { label: maintenanceLabel, monthlyPrice },
  }
}

/**
 * Checks that a path like "addons.seo-starter.price" or "rush.feePercent" points at a real value.
 * Lists (projectTypes, addons) are addressed by item id instead of position.
 */
export function pathExists(path: string, root: Record<string, unknown>): boolean {
  const parts = path.split('.')
  let current: unknown = root
  for (const part of parts) {
    if (Array.isArray(current)) {
      current = current.find((item) => isObject(item) && item.id === part)
    } else if (isObject(current)) {
      current = current[part]
    } else {
      return false
    }
    if (current === undefined) return false
  }
  return true
}

/** Small helper that records a problem and returns a safe placeholder, so checking can continue. */
class Validator {
  private readonly problems: string[]

  constructor(problems: string[]) {
    this.problems = problems
  }

  object(value: unknown, at: string): Record<string, unknown> | null {
    if (isObject(value)) return value
    this.problems.push(`${at} must be an object`)
    return null
  }

  integer(value: unknown, at: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.problems.push(`${at} must be a whole number (found ${JSON.stringify(value)})`)
      return min
    }
    if (value < min || value > max) {
      this.problems.push(`${at} must be between ${min} and ${max} (found ${value})`)
      return min
    }
    return value
  }

  money(value: unknown, at: string): number {
    return this.integer(value, at, 0, 1_000_000)
  }

  boolean(value: unknown, at: string): boolean {
    if (typeof value === 'boolean') return value
    this.problems.push(`${at} must be true or false`)
    return false
  }

  id(value: unknown, at: string): string | null {
    if (typeof value === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return value
    this.problems.push(`${at} must be a lowercase id like "custom-website" (found ${JSON.stringify(value)})`)
    return null
  }

  text(value: unknown, at: string): LocalizedText {
    const result: LocalizedText = { en: '', es: '' }
    if (!isObject(value)) {
      this.problems.push(`${at} must have "en" and "es" text`)
      return result
    }
    for (const lang of ['en', 'es'] as const) {
      const text = value[lang]
      if (typeof text !== 'string' || text.trim() === '') {
        this.problems.push(`${at}.${lang} is missing (every label needs English and Spanish)`)
      } else {
        result[lang] = text
      }
    }
    return result
  }

  currency(value: unknown, at: string): string {
    if (typeof value === 'string' && /^[A-Z]{3}$/.test(value)) {
      try {
        new Intl.NumberFormat('en-US', { style: 'currency', currency: value })
        return value
      } catch {
        /* fall through */
      }
    }
    this.problems.push(`${at} must be a 3-letter currency code like "USD" (found ${JSON.stringify(value)})`)
    return 'USD'
  }

  unique(ids: string[], what: string): void {
    const seen = new Set<string>()
    for (const id of ids) {
      if (!id) continue
      if (seen.has(id)) this.problems.push(`duplicate ${what}: "${id}"`)
      seen.add(id)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
