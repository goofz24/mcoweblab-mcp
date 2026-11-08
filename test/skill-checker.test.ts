import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain JavaScript file with no type declarations
import { check } from '../skills/bilingual-product-descriptions/scripts/check_description.mjs'

type Result = { ok: boolean; problems: string[] }
// Normalize line endings so the edits below match on Windows checkouts (CRLF) too.
const read = (path: string) =>
  readFileSync(new URL(`../skills/bilingual-product-descriptions/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const facts = read('examples/01-coffee/facts.md')
const voice = read('examples/01-coffee/voice.md')
const good = read('examples/01-coffee/expected-output.md')
const run = (output: string): Result => check(facts, output, voice)

describe('skill output checker', () => {
  it('passes the example output', () => {
    expect(run(good)).toMatchObject({ ok: true, problems: [] })
  })

  it('catches a claim that is only in the owner\'s notes', () => {
    const r = run(good.replace('made for your everyday cup', 'the best coffee for your everyday cup'))
    expect(r.ok).toBe(false)
    expect(r.problems.join()).toMatch(/risky claims .*best/)
  })

  it('catches an invented number', () => {
    const r = run(good.replace('12 oz bag\n- Grown', '16 oz bag\n- Grown'))
    expect(r.problems.join()).toMatch(/not in facts: 16/)
  })

  it('catches an invented claim in the Spanish only', () => {
    const r = run(good.replace('Café de las montañas', 'Café orgánico de las montañas'))
    expect(r.problems.join()).toMatch(/orgánico/)
  })

  it('catches a "never say" word from the brand voice', () => {
    const r = run(good.replace('made for your everyday cup', 'never cheap, made for your everyday cup'))
    expect(r.problems.join()).toMatch(/never say.*cheap/)
  })

  it('catches a Spanish list that does not match the English one', () => {
    const r = run(good.replace('- Notas de chocolate, caramelo y un toque cítrico\n', ''))
    expect(r.problems.join()).toMatch(/same number of highlights \(4 vs 3\)/)
  })

  it('catches a meta description that is too long and a missing section', () => {
    expect(run(good.replace('**Meta description:** ', `**Meta description:** ${'x'.repeat(100)} `)).problems.join()).toMatch(
      /English meta description/,
    )
    expect(run(good.replace('## Español', '## Spanish')).ok).toBe(false)
  })
})
