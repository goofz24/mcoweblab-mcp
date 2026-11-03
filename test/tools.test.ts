import { describe, expect, it } from 'vitest'
import { loadShopData, parseSizeCharts } from '../src/data.js'
import { ToolInputError } from '../src/tools/errors.js'
import { formatQuote, getQuote } from '../src/tools/getQuote.js'
import { formatSizeChart, getSizeChart, inchesToCm } from '../src/tools/getSizeChart.js'
import { listServices } from '../src/tools/listServices.js'

// Uses the real data files, so a broken pricing.json or size-charts.json fails the tests.
const data = loadShopData()
const approved = { ...data.pricing, unconfirmed: [] } // the same prices, as if Mel had approved every value

describe('list_services', () => {
  it('lists the four services with the starting prices from mcoweblab.com/services', () => {
    const result = listServices(data.pricing, 'en')
    expect(result.services.map((s) => [s.id, s.startingPrice])).toEqual([
      ['custom-website', 399],
      ['shopify-store', 800],
      ['qr-menu', 250],
      ['wallet-card', 150],
    ])
    expect(result.services.every((s) => s.startingPriceConfirmed)).toBe(true)
    expect(result.maintenance).toMatchObject({ monthlyPrice: 50, monthlyPriceConfirmed: true })
  })

  it('marks draft add-on prices and only offers add-ons that fit the service', () => {
    const shopify = listServices(data.pricing, 'en').services.find((s) => s.id === 'shopify-store')!
    expect(shopify.addons.map((a) => a.id)).toContain('product-upload')
    expect(shopify.addons.map((a) => a.id)).not.toContain('menu-photos')
    expect(shopify.addons.every((a) => a.priceConfirmed === false)).toBe(true)
  })

  it('speaks Spanish when asked', () => {
    expect(listServices(data.pricing, 'es').services[1].name).toBe('Tienda Shopify')
  })

  it('reports that rush delivery is off (Mel turned it off for the first launch)', () => {
    expect(listServices(data.pricing, 'en').rushDeliveryOffered).toBe(false)
  })
})

describe('get_quote', () => {
  it('prices a 5-page Shopify store with Spanish translation', () => {
    const q = getQuote(data.pricing, { projectType: 'shopify-store', pages: 5, addons: ['bilingual'] }, 'en')
    expect(q.lineItems.map((i) => [i.id, i.amount])).toEqual([
      ['shopify-store', 800],
      ['bilingual', 150],
    ])
    expect(q.estimateLow).toBe(950)
    expect(q.estimateHigh).toBe(1190) // 950 + 25% = 1187.50, rounded UP to the next $10
    expect(q.typicalWeeks).toBe(4) // 3 base weeks + 1 for the bilingual add-on
  })

  it('says exactly which draft values the quote used', () => {
    const q = getQuote(data.pricing, { projectType: 'shopify-store', addons: ['bilingual'] }, 'en')
    expect(q.isDraft).toBe(true)
    expect(q.unconfirmedValuesUsed).toEqual([
      'projectTypes.shopify-store.includedPages',
      'projectTypes.shopify-store.baseWeeks',
      'addons.bilingual.price',
      'addons.bilingual.extraWeeks',
      'estimate.upperBufferPercent',
    ])
    expect(q.lineItems.find((i) => i.id === 'shopify-store')!.confirmed).toBe(true)
    expect(q.lineItems.find((i) => i.id === 'bilingual')!.confirmed).toBe(false)
    expect(formatQuote(q, 'en')).toMatch(/^DRAFT:/)
  })

  it('is not a draft once every value it uses is approved', () => {
    const q = getQuote(approved, { projectType: 'custom-website' }, 'en')
    expect(q.isDraft).toBe(false)
    expect(q.unconfirmedValuesUsed).toEqual([])
    expect(formatQuote(q, 'en')).not.toMatch(/DRAFT/)
  })

  it('keeps the $399 starting price exact (no rounding to $400)', () => {
    const q = getQuote(data.pricing, { projectType: 'custom-website' }, 'en')
    expect(q.estimateLow).toBe(399)
    expect(q.estimateHigh).toBe(500) // 399 + 25% = 498.75, rounded up to $500
  })

  it('adds extra pages and the extra time they take', () => {
    const q = getQuote(data.pricing, { projectType: 'custom-website', pages: 8 }, 'en')
    expect(q.lineItems[1]).toMatchObject({ id: 'extra-pages', amount: 300, name: '5 extra pages' })
    expect(q.estimateLow).toBe(699)
    expect(q.typicalWeeks).toBe(4) // 2 base weeks + ceil(5 / 3) = 2
  })

  it('uses the included pages when fewer are asked for, and says so', () => {
    const q = getQuote(data.pricing, { projectType: 'shopify-store', pages: 2 }, 'en')
    expect(q.pages).toBe(5)
    expect(q.notes[0]).toMatch(/already includes 5 page/)
  })

  it('adds monthly maintenance separately from the one-time price', () => {
    const q = getQuote(data.pricing, { projectType: 'qr-menu', maintenance: true }, 'en')
    expect(q.monthly).toBe(50)
    expect(q.estimateLow).toBe(250)
  })

  it('counts a repeated add-on once', () => {
    const q = getQuote(data.pricing, { projectType: 'custom-website', addons: ['seo-starter', 'seo-starter'] }, 'en')
    expect(q.lineItems.filter((i) => i.id === 'seo-starter')).toHaveLength(1)
  })

  it('explains mistakes so Claude can fix its request', () => {
    expect(() => getQuote(data.pricing, { projectType: 'mobile-app' }, 'en')).toThrow(
      /Unknown projectType "mobile-app". Use one of: custom-website, shopify-store, qr-menu, wallet-card/,
    )
    expect(() => getQuote(data.pricing, { projectType: 'qr-menu', addons: ['product-upload'] }, 'en')).toThrow(
      /isn't available for qr-menu. Add-ons for qr-menu: bilingual, copywriting, menu-photos/,
    )
    expect(() => getQuote(data.pricing, { projectType: 'custom-website', pages: 50 }, 'en')).toThrow(ToolInputError)
  })

  it('answers in Spanish', () => {
    const q = getQuote(data.pricing, { projectType: 'custom-website', pages: 4 }, 'es')
    expect(q.projectName).toBe('Sitio web a la medida')
    expect(formatQuote(q, 'es')).toMatch(/^BORRADOR:/)
  })
})

describe('get_size_chart', () => {
  it('returns inches as stored', () => {
    const r = getSizeChart(data.sizeCharts, 'unisex-tshirt', 'in', 'en')
    expect(r.rows[0]).toEqual({ size: 'S', measurements: { chest: { min: 34, max: 37 }, length: { min: 28, max: 28 } } })
    expect(r.sampleData).toBe(true)
  })

  it('converts to centimeters, rounded to the nearest half centimeter', () => {
    expect(inchesToCm(34)).toBe(86.5) // 86.36
    expect(inchesToCm(37)).toBe(94) // 93.98
    const r = getSizeChart(data.sizeCharts, 'unisex-tshirt', 'cm', 'en')
    expect(r.rows[0].measurements.chest).toEqual({ min: 86.5, max: 94 })
  })

  it('formats a Markdown table with a sample-data warning', () => {
    const text = formatSizeChart(getSizeChart(data.sizeCharts, 'womens-top', 'in', 'es'), 'es')
    expect(text).toMatch(/^DATOS DE EJEMPLO/)
    expect(text).toContain('| Talla | Busto | Cintura |')
    expect(text).toContain('| M | 35-36 | 28-29 |')
  })

  describe('size recommendation', () => {
    const recommend = (unit: 'in' | 'cm', measurement: string, value: number, lang: 'en' | 'es' = 'en') =>
      getSizeChart(data.sizeCharts, 'unisex-tshirt', unit, lang, { measurement, value }).recommendation!

    it('finds the size whose range contains the measurement', () => {
      expect(recommend('in', 'chest', 40)).toMatchObject({ size: 'M', fit: 'fits' })
      expect(recommend('in', 'chest', 37)).toMatchObject({ size: 'S', fit: 'fits' }) // edges count
    })

    it('suggests the larger size in a gap between sizes (the 96 cm case Claude hit in testing)', () => {
      const r = recommend('cm', 'chest', 96, 'es')
      expect(r).toMatchObject({ size: 'M', fit: 'between' })
      expect(r.explanation).toContain('queda entre S (hasta 94 cm) y M (desde 96.5 cm)')
    })

    it('handles people smaller than the smallest or larger than the largest size', () => {
      expect(recommend('in', 'chest', 30)).toMatchObject({ size: 'S', fit: 'below-smallest' })
      expect(recommend('in', 'chest', 60)).toMatchObject({ size: null, fit: 'above-largest' })
    })

    it('rejects a measurement the chart does not have', () => {
      expect(() => recommend('in', 'waist', 30)).toThrow(/has no "waist" measurement. Use one of: chest, length/)
    })
  })

  it('lists the available charts when asked for one that does not exist', () => {
    expect(() => getSizeChart(data.sizeCharts, 'shoes', 'in', 'en')).toThrow(/Available charts: unisex-tshirt, womens-top, kids-tshirt/)
  })
})

describe('size chart data checks', () => {
  const chart = {
    id: 'test',
    name: { en: 'Test', es: 'Prueba' },
    measurements: [{ id: 'chest', name: { en: 'Chest', es: 'Pecho' } }],
    howToMeasure: { en: 'x', es: 'x' },
    sizes: [{ size: 'S', chest: [34, 37] }],
  }

  it('accepts a valid chart', () => {
    expect(() => parseSizeCharts({ sample: true, charts: [chart] })).not.toThrow()
  })

  it('rejects a row missing a measurement or with min above max', () => {
    expect(() => parseSizeCharts({ sample: true, charts: [{ ...chart, sizes: [{ size: 'S' }] }] })).toThrow(/needs a valid chest range/)
    expect(() => parseSizeCharts({ sample: true, charts: [{ ...chart, sizes: [{ size: 'S', chest: [40, 30] }] }] })).toThrow()
  })

  it('rejects two charts with the same id', () => {
    expect(() => parseSizeCharts({ sample: true, charts: [chart, chart] })).toThrow(/two charts with the id "test"/)
  })
})
