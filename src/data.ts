import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parsePricing } from './pricing/parsePricing.js'
import type { PricingData } from './pricing/types.js'

/** Everything the tools read. Loaded once when the server starts. */
export interface ShopData {
  pricing: PricingData
  sizeCharts: SizeChartFile
}

const localized = z.object({ en: z.string().min(1), es: z.string().min(1) })
const range = z.tuple([z.number().positive(), z.number().positive()]).refine(([min, max]) => min <= max, {
  message: 'a range must be [min, max] with min <= max',
})

const sizeChartSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: localized,
    measurements: z.array(z.object({ id: z.string().min(1), name: localized })).min(1),
    howToMeasure: localized,
    sizes: z.array(z.object({ size: z.string().min(1) }).catchall(z.unknown())).min(1),
  })
  // Every size row must have a [min, max] range for every measurement the chart lists.
  .superRefine((chart, ctx) => {
    chart.sizes.forEach((row, i) => {
      for (const m of chart.measurements) {
        if (!range.safeParse(row[m.id]).success) {
          ctx.addIssue({ code: 'custom', path: ['sizes', i, m.id], message: `size ${row.size} needs a valid ${m.id} range` })
        }
      }
    })
  })

const sizeChartFileSchema = z.object({
  sample: z.boolean(),
  charts: z.array(sizeChartSchema).min(1),
})

export type SizeChart = z.infer<typeof sizeChartSchema>
export type SizeChartFile = z.infer<typeof sizeChartFileSchema>

export function parseSizeCharts(raw: unknown): SizeChartFile {
  const result = sizeChartFileSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`size-charts.json is invalid:\n${z.prettifyError(result.error)}`)
  }
  const ids = result.data.charts.map((c) => c.id)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate) throw new Error(`size-charts.json has two charts with the id "${duplicate}"`)
  return result.data
}

function readJson(fileUrl: URL): unknown {
  return JSON.parse(readFileSync(fileUrl, 'utf8'))
}

/**
 * Reads data/pricing.json and data/size-charts.json and checks them.
 * The path is relative to this file, so it works from src/ (tests) and from dist/ (built server).
 * If either file is broken the server refuses to start, instead of giving Claude wrong prices.
 */
export function loadShopData(dataDir = new URL('../data/', import.meta.url)): ShopData {
  return {
    pricing: parsePricing(readJson(new URL('pricing.json', dataDir))),
    sizeCharts: parseSizeCharts(readJson(new URL('size-charts.json', dataDir))),
  }
}
