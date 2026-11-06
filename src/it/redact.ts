import { userInfo } from 'node:os'

/**
 * Guardrail: hide things that should never reach a chat, a ticket or a log.
 * - Passwords typed into a request ("my password is Summer2026!") are replaced.
 * - MAC addresses (hardware ids) in command output are replaced.
 * - The Windows/Linux user name in file paths is replaced, so paths like
 *   C:\Users\jdoe\... don't leak who is signed in.
 * It is a safety net, not a guarantee: the tools are also built to not collect personal data.
 */

export const PASSWORD_MASK = '[password removed]'

// "password: x", "password = x", "password is x", "contraseña: x", "mi clave es x", "pwd=x"
const PASSWORD_PATTERN =
  /\b(passwords?|passcode|pwd|pass|contraseñas?|contrasena|clave)(\s*(?:(?:is|es|was|era)\b|:|=)\s*|\s+)(["']?)([^\s"',;]{4,})\3/giu

// Words that commonly follow "password" in normal sentences and are not secrets.
const NOT_A_SECRET = new Set([
  'reset', 'expired', 'expira', 'expiró', 'expiro', 'change', 'changed', 'cambiar', 'cambio', 'nueva', 'new', 'locked',
  'manager', 'policy', 'page', 'link', 'enlace', 'doesn', 'does', 'didn', 'isn', 'stopped', 'not', 'para', 'that', 'this',
  'from', 'with', 'field', 'prompt', 'again', 'otra', 'temporal', 'temporary', 'olvidada', 'forgot', 'for', 'and', 'del',
  'the', 'una', 'mi', 'tu', 'su', 'de', 'en', 'it', 'is', 'es',
])

export function redactPasswords(text: string): { text: string; redacted: boolean } {
  let redacted = false
  const out = text.replace(PASSWORD_PATTERN, (match, word: string, sep: string, quote: string, value: string) => {
    const explicit = /[:=]|\b(is|es|was|era)\b/i.test(sep)
    // "password reset", "password expired": a normal word, not a secret.
    if (NOT_A_SECRET.has(value.toLowerCase())) return match
    // Without ":" / "=" / "is", only treat it as a secret if it looks like one (has a digit or symbol).
    if (!explicit && !/[\d\p{P}\p{S}]/u.test(value)) return match
    redacted = true
    return `${word}${sep}${quote}${PASSWORD_MASK}${quote}`
  })
  return { text: out, redacted }
}

const MAC_PATTERN = /\b[0-9A-F]{2}(?:[-:][0-9A-F]{2}){5}\b/gi

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function currentUserName(): string | null {
  try {
    const name = userInfo().username
    return name && name.length >= 2 ? name : null
  } catch {
    return null
  }
}

/** For command output: hides MAC addresses, the signed-in user's name, and passwords. */
export function redactOutput(text: string, userName: string | null = currentUserName()): string {
  let out = text.replace(MAC_PATTERN, '[MAC hidden]')
  out = out.replace(/([\\/](?:Users|home)[\\/])([^\\/\s]+)/gi, '$1<user>')
  if (userName) out = out.replace(new RegExp(`\\b${escapeRegExp(userName)}\\b`, 'gi'), '<user>')
  return redactPasswords(out).text
}

/** Deep copy of tool arguments with passwords removed from every string, for the audit log. */
export function redactArgs(value: unknown): unknown {
  if (typeof value === 'string') return redactPasswords(value).text
  if (Array.isArray(value)) return value.map(redactArgs)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactArgs(v)]))
  }
  return value
}
