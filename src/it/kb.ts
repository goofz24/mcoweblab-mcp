import type { Lang } from '../pricing/types.js'
import type { KbArticle, KbFile } from './itData.js'

/**
 * Bilingual keyword search. People write "la impresora no imprime", "printer offline" or a
 * mix of both, so every article is matched against its English AND Spanish keywords no
 * matter which language the answer is in. Accents and case are ignored ("contraseña" ==
 * "contrasena"). Simple on purpose: easy to explain, test and debug, no AI needed.
 */

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOP_WORDS = new Set(
  'the and for not my is it to a an of on in with can cant won wont doesnt de la el los las un una mi no se que y en con por para es esta me lo le'.split(' '),
)

export interface KbMatch {
  id: string
  title: string
  category: KbArticle['category']
  selfService: boolean
  score: number
  matchedKeywords: string[]
  summary: string
  steps: string[]
  escalateWhen: string
}

export interface KbSearchResult {
  query: string
  sampleData: boolean
  matches: KbMatch[]
}

function scoreArticle(article: KbArticle, query: string, words: Set<string>): { score: number; matched: string[] } {
  const matched: string[] = []
  let score = 0
  for (const keyword of [...article.keywords.en, ...article.keywords.es]) {
    const k = normalize(keyword)
    if (!k) continue
    // Whole-phrase match, on word boundaries: "vpn" matches "my vpn fails", not "vpnx".
    if (` ${query} `.includes(` ${k} `)) {
      if (!matched.includes(k)) {
        matched.push(k)
        score += k.includes(' ') ? 4 : 3 // a multi-word phrase is a stronger signal
      }
    }
  }
  // Small bonus for words that also appear in the title.
  for (const w of new Set([...normalize(article.title.en).split(' '), ...normalize(article.title.es).split(' ')])) {
    if (w.length > 3 && !STOP_WORDS.has(w) && words.has(w)) score += 1
  }
  return { score, matched }
}

export function searchKb(kb: KbFile, query: string, lang: Lang, limit = 3): KbSearchResult {
  const q = normalize(query)
  const words = new Set(q.split(' ').filter((w) => w && !STOP_WORDS.has(w)))
  const matches = kb.articles
    .map((article) => ({ article, ...scoreArticle(article, q, words) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id))
    .slice(0, limit)
    .map(({ article, score, matched }) => ({
      id: article.id,
      title: article.title[lang],
      category: article.category,
      selfService: article.selfService,
      score,
      matchedKeywords: matched,
      summary: article.summary[lang],
      steps: article.steps[lang],
      escalateWhen: article.escalateWhen[lang],
    }))
  return { query, sampleData: kb.sample, matches }
}

export function formatKbResult(r: KbSearchResult, lang: Lang): string {
  const es = lang === 'es'
  if (r.matches.length === 0) {
    return es
      ? `No hay artículos para "${r.query}". Ofrece preparar un borrador de incidente (draft_incident) para que un técnico lo vea.`
      : `No articles match "${r.query}". Offer to prepare an incident draft (draft_incident) so a technician can look at it.`
  }
  const lines: string[] = []
  if (r.sampleData) lines.push(es ? 'Base de conocimiento de EJEMPLO.' : 'SAMPLE knowledge base.')
  for (const m of r.matches) {
    lines.push('', `${m.id}: ${m.title}`)
    if (!m.selfService) {
      lines.push(
        es
          ? 'SOLO TÉCNICO: no guíes a la persona para hacerlo sola. Explica el proceso y ofrece un borrador de ticket.'
          : 'TECHNICIAN ONLY: do not walk the person through doing this alone. Explain the process and offer a ticket draft.',
      )
    }
    lines.push(m.summary)
    m.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    lines.push(`${es ? 'Escalar cuando' : 'Escalate when'}: ${m.escalateWhen}`)
  }
  return lines.join('\n').trim()
}
