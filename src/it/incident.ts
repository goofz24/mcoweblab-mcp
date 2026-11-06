import type { Lang } from '../pricing/types.js'
import { ToolInputError } from '../tools/errors.js'
import type { ItData } from './itData.js'
import { normalize } from './kb.js'
import { redactPasswords } from './redact.js'

/**
 * Prepares a ServiceNow incident, but never creates it. The result has the field values
 * (named like ServiceNow's incident table columns) and, when a ServiceNow instance is set,
 * a link that opens a NEW incident form already filled in. A technician reviews it and
 * clicks Submit. Human in the loop by design.
 *
 * Guardrails applied here, in code, not left to the AI:
 * - Passwords typed into the text are removed before they reach the draft.
 * - Possible security incidents (phishing, malware, "I clicked a link") are flagged,
 *   raised to urgency 1 and routed to Security.
 * - Password resets and admin-rights requests are flagged as needing a person.
 */

/** ServiceNow's default incident categories. */
export const INCIDENT_CATEGORIES = ['inquiry', 'software', 'hardware', 'network', 'database'] as const
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number]
export type Level = 1 | 2 | 3

export interface IncidentRequest {
  shortDescription: string
  description: string
  category: IncidentCategory
  /** 1 = high (many people / whole business), 2 = medium, 3 = low (one person). */
  impact?: Level
  /** 1 = high (work stopped), 2 = medium, 3 = low (can wait). */
  urgency?: Level
  callerName?: string
  assetTag?: string
  kbArticleId?: string
}

export interface IncidentDraft {
  created: false
  fields: {
    short_description: string
    description: string
    category: IncidentCategory
    impact: Level
    urgency: Level
    priority: number
    assignment_group: string
  }
  priorityLabel: string
  escalateToHuman: boolean
  escalationReasons: string[]
  warnings: string[]
  linkedAsset: string | null
  linkedKb: string | null
  /** Opens a pre-filled NEW incident form. Null until SERVICENOW_INSTANCE is set. */
  createUrl: string | null
  nextStep: string
}

/**
 * ServiceNow's standard priority lookup: impact x urgency.
 * 1 Critical, 2 High, 3 Moderate, 4 Low, 5 Planning.
 */
export const PRIORITY_MATRIX: Record<Level, Record<Level, number>> = {
  1: { 1: 1, 2: 2, 3: 3 },
  2: { 1: 2, 2: 3, 3: 4 },
  3: { 1: 3, 2: 4, 3: 5 },
}
const PRIORITY_LABELS: Record<number, { en: string; es: string }> = {
  1: { en: '1 - Critical', es: '1 - Crítica' },
  2: { en: '2 - High', es: '2 - Alta' },
  3: { en: '3 - Moderate', es: '3 - Moderada' },
  4: { en: '4 - Low', es: '4 - Baja' },
  5: { en: '5 - Planning', es: '5 - Planificación' },
}

const ASSIGNMENT_GROUPS: Record<IncidentCategory, string> = {
  inquiry: 'Service Desk',
  software: 'Service Desk',
  hardware: 'Desktop Support',
  network: 'Network',
  database: 'Database',
}

const SECURITY_WORDS = [
  'phishing', 'hacked', 'hacker', 'ransomware', 'malware', 'virus', 'suspicious link', 'clicked a link', 'clicked the link',
  'strange login', 'someone logged in', 'data breach', 'hackeado', 'hackearon', 'enlace sospechoso', 'le di click', 'le di clic',
  'correo sospechoso', 'suspicious email', 'estafa', 'scam',
]
const PASSWORD_RESET_WORDS = ['reset my password', 'forgot my password', 'forgot password', 'account locked', 'locked out', 'olvide mi contrasena', 'cuenta bloqueada', 'restablecer mi contrasena', 'restablecer contrasena']
const ACCESS_REQUEST_WORDS = ['admin rights', 'administrator rights', 'admin access', 'local admin', 'make me admin', 'permisos de administrador', 'acceso de administrador']

function containsAny(text: string, words: string[]): boolean {
  const t = ` ${normalize(text)} `
  return words.some((w) => t.includes(` ${normalize(w)} `))
}

function clean(value: string): string {
  // "^" separates fields in a ServiceNow query string; never let it into a value.
  return value.replace(/\^/g, ' ').trim()
}

export function buildCreateUrl(instance: string, fields: IncidentDraft['fields']): string {
  const query = [
    `short_description=${clean(fields.short_description)}`,
    `description=${clean(fields.description)}`,
    `category=${fields.category}`,
    `impact=${fields.impact}`,
    `urgency=${fields.urgency}`,
    `assignment_group=${clean(fields.assignment_group)}`,
  ].join('^')
  return `https://${instance}.service-now.com/incident.do?sys_id=-1&sysparm_query=${encodeURIComponent(query)}`
}

/** Instance names look like "dev123456". Anything else is ignored, so the link can't point somewhere else. */
export function validInstance(instance: string | undefined): string | null {
  return instance && /^[a-z0-9][a-z0-9-]{2,62}$/.test(instance) ? instance : null
}

export function draftIncident(data: ItData, request: IncidentRequest, lang: Lang, instance: string | null = null): IncidentDraft {
  const es = lang === 'es'
  const warnings: string[] = []
  const reasons: string[] = []

  const short = redactPasswords(request.shortDescription.trim())
  const desc = redactPasswords(request.description.trim())
  if (short.redacted || desc.redacted) {
    warnings.push(
      es
        ? 'Se quitó una contraseña del texto. Nunca pongas contraseñas en un ticket; dile a la persona que la cambie.'
        : 'A password was removed from the text. Never put passwords in a ticket; tell the person to change it.',
    )
  }

  let impact: Level = request.impact ?? 3
  let urgency: Level = request.urgency ?? 3
  let group = ASSIGNMENT_GROUPS[request.category]
  const allText = `${short.text} ${desc.text}`

  if (containsAny(allText, SECURITY_WORDS)) {
    reasons.push(es ? 'Posible incidente de seguridad: un técnico debe verlo de inmediato.' : 'Possible security incident: a technician must look at it right away.')
    if (urgency !== 1) {
      warnings.push(es ? 'La urgencia se subió a 1 por ser un posible incidente de seguridad.' : 'Urgency raised to 1 because it may be a security incident.')
      urgency = 1
    }
    impact = Math.min(impact, 2) as Level
    group = 'Security'
  }
  if (containsAny(allText, PASSWORD_RESET_WORDS)) {
    reasons.push(es ? 'Restablecer contraseña: una persona debe verificar la identidad primero.' : 'Password reset: a person must verify identity first.')
  }
  if (containsAny(allText, ACCESS_REQUEST_WORDS)) {
    reasons.push(
      es
        ? 'Pedido de permisos de administrador: necesita la aprobación del supervisor. Es una solicitud, no un incidente.'
        : 'Admin rights request: needs a manager\'s approval. This is a request, not an incident.',
    )
  }

  let linkedAsset: string | null = null
  if (request.assetTag) {
    const asset = data.assets.assets.find((a) => normalize(a.tag) === normalize(request.assetTag!))
    if (!asset) {
      throw new ToolInputError(`Unknown asset tag "${request.assetTag}". Look it up with lookup_asset first, or leave assetTag out.`)
    }
    linkedAsset = `${asset.tag} (${asset.model}, serial ${asset.serial})`
  }
  let linkedKb: string | null = null
  if (request.kbArticleId) {
    const article = data.kb.articles.find((a) => a.id === request.kbArticleId!.toUpperCase())
    if (!article) {
      throw new ToolInputError(`Unknown KB article "${request.kbArticleId}". Find one with search_kb first, or leave kbArticleId out.`)
    }
    linkedKb = `${article.id} ${article.title.en}`
  }

  const description = [
    desc.text,
    '',
    request.callerName ? `Reported by: ${request.callerName.trim()}` : null,
    linkedAsset ? `Asset: ${linkedAsset}` : null,
    linkedKb ? `KB already tried or suggested: ${linkedKb}` : null,
    reasons.length ? `Flags: ${reasons.join(' ')}` : null,
    'Drafted by the MCO WebLab IT helper (AI). Reviewed and submitted by a technician.',
  ]
    .filter((l) => l !== null)
    .join('\n')

  const priority = PRIORITY_MATRIX[impact][urgency]
  const fields = {
    short_description: short.text.slice(0, 160),
    description,
    category: request.category,
    impact,
    urgency,
    priority,
    assignment_group: group,
  }

  return {
    created: false,
    fields,
    priorityLabel: PRIORITY_LABELS[priority][lang],
    escalateToHuman: reasons.length > 0,
    escalationReasons: reasons,
    warnings,
    linkedAsset,
    linkedKb,
    createUrl: instance ? buildCreateUrl(instance, fields) : null,
    nextStep: instance
      ? es
        ? 'Abre el enlace, revisa cada campo y haz clic en Enviar en ServiceNow. Esta herramienta no crea el ticket.'
        : 'Open the link, review every field and click Submit in ServiceNow. This tool does not create the ticket.'
      : es
        ? 'Copia estos campos en un incidente nuevo en ServiceNow y revisa antes de enviar. (Para un enlace pre-llenado, configura SERVICENOW_INSTANCE.)'
        : 'Copy these fields into a new ServiceNow incident and review before submitting. (For a pre-filled link, set SERVICENOW_INSTANCE.)',
  }
}

export function formatIncident(d: IncidentDraft, lang: Lang): string {
  const es = lang === 'es'
  const lines = [
    es ? 'BORRADOR DE INCIDENTE (no se ha creado nada)' : 'INCIDENT DRAFT (nothing has been created)',
    `${es ? 'Resumen' : 'Short description'}: ${d.fields.short_description}`,
    `${es ? 'Categoría' : 'Category'}: ${d.fields.category} | ${es ? 'Impacto' : 'Impact'} ${d.fields.impact} | ${es ? 'Urgencia' : 'Urgency'} ${d.fields.urgency} | ${es ? 'Prioridad' : 'Priority'} ${d.priorityLabel}`,
    `${es ? 'Grupo asignado' : 'Assignment group'}: ${d.fields.assignment_group}`,
    '',
    d.fields.description,
  ]
  if (d.escalateToHuman) lines.push('', `${es ? 'ESCALAR A UNA PERSONA' : 'ESCALATE TO A PERSON'}: ${d.escalationReasons.join(' ')}`)
  for (const w of d.warnings) lines.push(`! ${w}`)
  if (d.createUrl) lines.push('', `${es ? 'Enlace para crear (revisar primero)' : 'Create link (review first)'}: ${d.createUrl}`)
  lines.push('', d.nextStep)
  return lines.join('\n')
}
