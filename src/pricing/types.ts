export type Lang = 'en' | 'es'

/** Text that exists in both site languages. */
export type LocalizedText = Record<Lang, string>

/** All money values are whole US dollars (integers). */
export interface ProjectType {
  id: string
  label: LocalizedText
  description: LocalizedText
  /** Advertised starting price. Never rounded. */
  basePrice: number
  /** Pages included in the base price. */
  includedPages: number
  /** Price for each page above includedPages. */
  extraPagePrice: number
  maxPages: number
  /** Typical weeks for the base scope, counted from scope confirmation and content received. */
  baseWeeks: number
  /** Add one week for every this many extra pages (0 = extra pages add no time). */
  extraPagesPerWeek: number
}

export interface Addon {
  id: string
  label: LocalizedText
  price: number
  /** Extra weeks this add-on usually adds (0 = none). */
  extraWeeks: number
  /** Project type ids this add-on can be used with. */
  appliesTo: string[]
}

export interface EstimatePolicy {
  /** The upper end of the range adds this buffer, in percent (0 = show a single price). */
  upperBufferPercent: number
  /** The upper end is rounded UP to a multiple of this many dollars (1 = no rounding). */
  upperRoundingStep: number
}

export interface RushPolicy {
  /** Whether visitors can ask for faster delivery at all. */
  offered: boolean
  /** Fee added when rush is requested, in percent of the one-time subtotal. */
  feePercent: number
}

export interface PricingData {
  version: number
  currency: string
  /**
   * Values that are placeholders or assumptions and still need Mel's approval,
   * written as paths like "addons.seo-starter.price". A release is blocked while
   * this list is not empty, and the app shows a "draft prices" banner.
   */
  unconfirmed: string[]
  estimate: EstimatePolicy
  rush: RushPolicy
  projectTypes: ProjectType[]
  addons: Addon[]
  maintenance: {
    label: LocalizedText
    /** Starting monthly price, billed separately from the one-time project. */
    monthlyPrice: number
  }
}

/** Everything the visitor picked in the form. */
export interface Selections {
  projectTypeId: string
  pages: number
  addonIds: string[]
  rushRequested: boolean
  maintenance: boolean
}

export interface LineItem {
  id: string
  label: LocalizedText
  amount: number
}

export interface Quote {
  /** One-time items. Their sum plus rushFee always equals `low`. */
  lineItems: LineItem[]
  subtotal: number
  /** 0 unless rush was requested and is offered. */
  rushFee: number
  rushRequested: boolean
  /** Starting estimate: exact sum, never rounded. */
  low: number
  /** low plus the buffer, rounded up to the rounding step. Equals low when the buffer is 0. */
  high: number
  /** Recurring monthly price, never added to the one-time totals. */
  monthly: number
  /** Typical weeks after scope confirmation. Rush never shortens this automatically. */
  weeks: number
}
