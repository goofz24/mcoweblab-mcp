import { z } from 'zod'

/**
 * The IT helper tools read two SAMPLE files: a small bilingual knowledge base and an
 * asset inventory. Like the price list, they are checked when the server starts, so a
 * broken file stops the server instead of giving Claude wrong answers.
 */

const localized = z.object({ en: z.string().min(1), es: z.string().min(1) })
const localizedList = z.object({ en: z.array(z.string().min(1)).min(1), es: z.array(z.string().min(1)).min(1) })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates must look like 2026-11-06')

export const KB_CATEGORIES = ['access', 'network', 'hardware', 'software', 'security'] as const

const kbArticleSchema = z.object({
  id: z.string().regex(/^KB\d{4}$/, 'KB ids look like KB0001'),
  category: z.enum(KB_CATEGORIES),
  /** false: a technician must handle it (password resets, security, admin rights). */
  selfService: z.boolean(),
  title: localized,
  keywords: localizedList,
  summary: localized,
  steps: localizedList,
  escalateWhen: localized,
})

export const ASSET_STATUSES = ['ordered', 'received', 'deployed', 'repair', 'retired', 'disposed'] as const

const assetSchema = z.object({
  tag: z.string().regex(/^[A-Z]{2,5}-[A-Z]{2}-\d{3}$/, 'asset tags look like MCO-LT-001'),
  type: z.string().min(1),
  model: z.string().min(1),
  serial: z.string().min(1),
  assignedTo: z.string().min(1).nullable(),
  location: z.string().min(1),
  status: z.enum(ASSET_STATUSES),
  purchased: isoDate,
  warrantyEnd: isoDate,
  notes: z.string(),
})

const kbFileSchema = z.object({ sample: z.boolean(), articles: z.array(kbArticleSchema).min(1) })
const assetFileSchema = z.object({ sample: z.boolean(), assets: z.array(assetSchema).min(1) })

export type KbArticle = z.infer<typeof kbArticleSchema>
export type KbFile = z.infer<typeof kbFileSchema>
export type Asset = z.infer<typeof assetSchema>
export type AssetFile = z.infer<typeof assetFileSchema>
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export interface ItData {
  kb: KbFile
  assets: AssetFile
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, fileName: string, idOf: (item: unknown) => string, list: (data: T) => unknown[]): T {
  const result = schema.safeParse(raw)
  if (!result.success) throw new Error(`${fileName} is invalid:\n${z.prettifyError(result.error)}`)
  const ids = list(result.data).map(idOf)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate) throw new Error(`${fileName} has the id "${duplicate}" twice`)
  return result.data
}

export function parseKb(raw: unknown): KbFile {
  return parseWith(kbFileSchema, raw, 'it-kb.json', (a) => (a as KbArticle).id, (d) => d.articles)
}

export function parseAssets(raw: unknown): AssetFile {
  return parseWith(assetFileSchema, raw, 'it-assets.json', (a) => (a as Asset).tag, (d) => d.assets)
}
