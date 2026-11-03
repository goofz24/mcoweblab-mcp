#!/usr/bin/env node
/**
 * Checks a bilingual product description written with the skill.
 *
 *   node check_description.mjs <product-facts.md> <output.md> [brand-voice.md]
 *
 * It can't judge whether the writing is good. It catches the mistakes that matter most on a live
 * store: a missing section, text that's too long for Shopify/Google, a Spanish list that doesn't
 * match the English one, numbers that aren't in the facts, and risky claims the client never made.
 * Exit code 0 = all checks pass, 1 = something to fix, 2 = bad usage.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Claims that get small shops in trouble when they aren't true. Flagged unless the facts file uses them.
const RISKY_CLAIMS = [
  'organic', 'orgánico', 'orgánica', 'handmade', 'hecho a mano', 'hecha a mano', 'artisan', 'artesanal',
  'best', 'mejor', 'award', 'premiado', 'premiada', '#1', 'número uno', 'eco-friendly', 'ecológico', 'ecológica',
  'sustainable', 'sostenible', 'hypoallergenic', 'hipoalergénico', 'gluten-free', 'sin gluten', 'vegan', 'vegano',
  'vegana', 'natural', 'all-natural', 'certified', 'certificado', 'certificada', 'guaranteed', 'garantizado',
  'garantizada', 'cure', 'cura', 'healthy', 'saludable', 'fair trade', 'comercio justo', 'limited edition',
  'edición limitada', 'local', 'shade-grown', 'de sombra',
]

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const words = (s) => s.split(/\s+/).filter(Boolean).length

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`)
  if (start === -1) return null
  const rest = text.slice(start + heading.length + 3)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

function field(block, label) {
  const m = block.match(new RegExp(`\\*\\*${label}:\\*\\*[ \\t]*(.*)`))
  return m ? m[1].trim() : null
}

function multiline(block, label, nextLabel) {
  const start = block.indexOf(`**${label}:**`)
  if (start === -1) return null
  const after = block.slice(start + label.length + 5)
  const end = nextLabel ? after.indexOf(`**${nextLabel}:**`) : -1
  return (end === -1 ? after : after.slice(0, end)).trim()
}

const bullets = (text) => (text ?? '').split('\n').filter((l) => /^\s*[-*] /.test(l))
// Numbers like 12, 3.5, 3,5 and 100. Commas and dots both count as decimal marks.
const numbers = (text) => [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.'))

export function check(factsText, outputText, voiceText = '') {
  const problems = []
  const checked = []
  const need = (ok, message) => {
    checked.push(message)
    if (!ok) problems.push(message)
  }

  const en = section(outputText, 'English')
  const es = section(outputText, 'Español')
  const notes = section(outputText, 'Notes for the shop owner')
  need(en !== null, 'Has an "## English" section')
  need(es !== null, 'Has an "## Español" section')
  need(notes !== null, 'Has a "## Notes for the shop owner" section')
  if (en === null || es === null) return { ok: false, problems, checked }

  const langs = [
    { name: 'English', block: en, title: 'Title', meta: 'Meta description', desc: 'Description', list: 'Highlights', maxWords: 120 },
    { name: 'Spanish', block: es, title: 'Título', meta: 'Meta descripción', desc: 'Descripción', list: 'Puntos clave', maxWords: 130 },
  ]
  const bulletCounts = []
  for (const l of langs) {
    const title = field(l.block, l.title)
    const meta = field(l.block, l.meta)
    const desc = multiline(l.block, l.desc, l.list)
    const list = bullets(multiline(l.block, l.list))
    need(!!title && title.length <= 70, `${l.name} title is present and at most 70 characters (${title?.length ?? 0})`)
    need(!!meta && meta.length <= 155, `${l.name} meta description is present and at most 155 characters (${meta?.length ?? 0})`)
    const n = desc ? words(desc) : 0
    need(n >= 50 && n <= l.maxWords, `${l.name} description is 50 to ${l.maxWords} words (${n})`)
    need(list.length >= 3 && list.length <= 5, `${l.name} has 3 to 5 highlights (${list.length})`)
    bulletCounts.push(list.length)
  }
  need(bulletCounts[0] === bulletCounts[1], `English and Spanish have the same number of highlights (${bulletCounts.join(' vs ')})`)

  if (notes !== null) {
    need(field(notes, 'Facts used') !== null, 'Notes list the facts used')
    need(field(notes, 'Questions for the client') !== null, 'Notes include questions for the client (or "None")')
  }

  // Only the copy the shopper sees, not the notes, is checked for claims and numbers.
  const copy = fold(en + '\n' + es)
  // Owner's notes are opinions, not facts, so a claim found only there still counts as invented.
  const facts = fold(factsText.split('\n').filter((line) => !/owner.s notes/i.test(line)).join('\n'))

  const factNumbers = new Set(numbers(facts))
  const invented = [...new Set(numbers(copy).filter((n) => !factNumbers.has(n)))]
  need(invented.length === 0, `Every number in the copy is in the facts${invented.length ? ` (not in facts: ${invented.join(', ')})` : ''}`)

  const hasTerm = (text, term) => new RegExp(`(^|[^a-z0-9])${fold(term).replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}($|[^a-z0-9])`).test(text)
  const risky = RISKY_CLAIMS.filter((term) => hasTerm(copy, term) && !hasTerm(facts, term))
  need(risky.length === 0, `No risky claims that aren't in the facts${risky.length ? ` (found: ${risky.join(', ')})` : ''}`)

  const neverLine = voiceText.match(/\*\*Never say:\*\*[ \t]*(.*)/)
  if (neverLine && neverLine[1].trim()) {
    const banned = neverLine[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    const used = banned.filter((term) => hasTerm(copy, term))
    need(used.length === 0, `Avoids the brand's "never say" words${used.length ? ` (found: ${used.join(', ')})` : ''}`)
  }

  return { ok: problems.length === 0, problems, checked }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [factsPath, outputPath, voicePath] = process.argv.slice(2)
  if (!factsPath || !outputPath) {
    console.error('Usage: node check_description.mjs <product-facts.md> <output.md> [brand-voice.md]')
    process.exit(2)
  }
  const result = check(
    readFileSync(factsPath, 'utf8'),
    readFileSync(outputPath, 'utf8'),
    voicePath ? readFileSync(voicePath, 'utf8') : '',
  )
  for (const line of result.checked) console.log(`${result.problems.includes(line) ? 'FAIL' : 'ok  '} ${line}`)
  console.log(result.ok ? '\nAll checks passed.' : `\n${result.problems.length} problem(s) to fix.`)
  process.exit(result.ok ? 0 : 1)
}
