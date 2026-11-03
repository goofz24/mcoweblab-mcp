import type { SizeChartFile } from '../data.js'
import type { Lang } from '../pricing/types.js'
import { ToolInputError } from './errors.js'

export type Unit = 'in' | 'cm'

export interface SizeChartResult {
  chart: string
  name: string
  unit: Unit
  /** True while the charts are demo data, not the Size Guide app's real presets. */
  sampleData: boolean
  howToMeasure: string
  columns: { id: string; name: string }[]
  rows: { size: string; measurements: Record<string, { min: number; max: number }> }[]
  /** Only when the caller gave a body measurement. */
  recommendation?: SizeRecommendation
}

export interface SizeRecommendation {
  measurement: string
  value: number
  /** The size to suggest, or null when the person is larger than the largest size. */
  size: string | null
  /** fits: inside a size's range. between: in the gap between two sizes, so we suggest the larger one. */
  fit: 'fits' | 'between' | 'below-smallest' | 'above-largest'
  explanation: string
}

const CM_PER_INCH = 2.54

/** Centimeters rounded to the nearest half centimeter, the way most size charts print them. */
export function inchesToCm(inches: number): number {
  return Math.round(inches * CM_PER_INCH * 2) / 2
}

export interface BodyMeasurement {
  /** A measurement id from the chart, for example "chest". */
  measurement: string
  /** The person's measurement, in the same unit as the chart being asked for. */
  value: number
}

export function getSizeChart(
  file: SizeChartFile,
  chartId: string,
  unit: Unit,
  lang: Lang,
  body?: BodyMeasurement,
): SizeChartResult {
  const chart = file.charts.find((c) => c.id === chartId)
  if (!chart) {
    throw new ToolInputError(`Unknown chart "${chartId}". Available charts: ${file.charts.map((c) => c.id).join(', ')}.`)
  }
  const convert = (value: number) => (unit === 'cm' ? inchesToCm(value) : value)
  const result: SizeChartResult = {
    chart: chart.id,
    name: chart.name[lang],
    unit,
    sampleData: file.sample,
    howToMeasure: chart.howToMeasure[lang],
    columns: chart.measurements.map((m) => ({ id: m.id, name: m.name[lang] })),
    rows: chart.sizes.map((row) => ({
      size: row.size,
      measurements: Object.fromEntries(
        chart.measurements.map((m) => {
          // data.ts already checked that every row has a valid [min, max] for every measurement.
          const [min, max] = row[m.id] as [number, number]
          return [m.id, { min: convert(min), max: convert(max) }]
        }),
      ),
    })),
  }
  if (body) {
    if (!chart.measurements.some((m) => m.id === body.measurement)) {
      throw new ToolInputError(
        `The ${chart.id} chart has no "${body.measurement}" measurement. Use one of: ${chart.measurements.map((m) => m.id).join(', ')}.`,
      )
    }
    result.recommendation = recommendSize(result, body, lang)
  }
  return result
}

/**
 * Picks a size from the chart, so Claude doesn't have to guess. Many charts leave gaps
 * between sizes (S ends at 37 in, M starts at 38 in). Testing with Claude showed a 96 cm chest
 * lands in such a gap, so the rule is: in a gap, suggest the larger size, the usual retail advice.
 */
export function recommendSize(chart: SizeChartResult, body: BodyMeasurement, lang: Lang): SizeRecommendation {
  const es = lang === 'es'
  const u = chart.unit
  const name = chart.columns.find((c) => c.id === body.measurement)?.name ?? body.measurement
  const v = body.value
  const ranges = chart.rows.map((row) => ({ size: row.size, ...row.measurements[body.measurement] }))
  const base = { measurement: body.measurement, value: v }

  const first = ranges[0]
  const last = ranges[ranges.length - 1]
  if (v < first.min) {
    return {
      ...base,
      size: first.size,
      fit: 'below-smallest',
      explanation: es
        ? `${name} ${v} ${u} es menor que la talla más pequeña (${first.size}, desde ${first.min} ${u}). ${first.size} es la más cercana.`
        : `${name} ${v} ${u} is below the smallest size (${first.size}, from ${first.min} ${u}). ${first.size} is the closest.`,
    }
  }
  if (v > last.max) {
    return {
      ...base,
      size: null,
      fit: 'above-largest',
      explanation: es
        ? `${name} ${v} ${u} es mayor que la talla más grande (${last.size}, hasta ${last.max} ${u}). Esta tabla no tiene una talla que le quede.`
        : `${name} ${v} ${u} is above the largest size (${last.size}, up to ${last.max} ${u}). This chart has no size that fits.`,
    }
  }
  const fit = ranges.find((r) => v >= r.min && v <= r.max)
  if (fit) {
    return {
      ...base,
      size: fit.size,
      fit: 'fits',
      explanation: es
        ? `${name} ${v} ${u} está dentro de la talla ${fit.size} (${fit.min}-${fit.max} ${u}).`
        : `${name} ${v} ${u} is within size ${fit.size} (${fit.min}-${fit.max} ${u}).`,
    }
  }
  const i = ranges.findIndex((r) => r.min > v)
  const smaller = ranges[i - 1]
  const larger = ranges[i]
  return {
    ...base,
    size: larger.size,
    fit: 'between',
    explanation: es
      ? `${name} ${v} ${u} queda entre ${smaller.size} (hasta ${smaller.max} ${u}) y ${larger.size} (desde ${larger.min} ${u}). Se sugiere la talla más grande, ${larger.size}, para que no quede apretada.`
      : `${name} ${v} ${u} falls between ${smaller.size} (up to ${smaller.max} ${u}) and ${larger.size} (from ${larger.min} ${u}). The larger size, ${larger.size}, is suggested so it isn't tight.`,
  }
}

/** A Markdown table, which Claude can show to a shopper as is. */
export function formatSizeChart(r: SizeChartResult, lang: Lang): string {
  const es = lang === 'es'
  const cell = (v: { min: number; max: number }) => (v.min === v.max ? `${v.min}` : `${v.min}-${v.max}`)
  const lines: string[] = []
  if (r.sampleData) {
    lines.push(es ? 'DATOS DE EJEMPLO: no son medidas reales de una tienda.' : 'SAMPLE DATA: these are not a real store\'s measurements.')
  }
  lines.push(`${r.name} (${r.unit})`, '')
  lines.push(`| ${es ? 'Talla' : 'Size'} | ${r.columns.map((c) => c.name).join(' | ')} |`)
  lines.push(`|${' --- |'.repeat(r.columns.length + 1)}`)
  for (const row of r.rows) {
    lines.push(`| ${row.size} | ${r.columns.map((c) => cell(row.measurements[c.id])).join(' | ')} |`)
  }
  lines.push('', r.howToMeasure)
  if (r.recommendation) lines.push('', `${es ? 'Recomendación' : 'Recommendation'}: ${r.recommendation.explanation}`)
  return lines.join('\n')
}
