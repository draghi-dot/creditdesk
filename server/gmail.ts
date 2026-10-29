/**
 * Gmail for each employee: Google OAuth 2.0 (authorization code with PKCE),
 * send-only scope, refresh tokens kept in the engine database. Nothing is
 * sent except when an employee presses Send on a request.
 *
 * The OAuth client comes from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or
 * from the client JSON downloaded from Google Cloud saved as
 * <data folder>/google-oauth.json.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OAuthClient { clientId: string; clientSecret: string }

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const SCOPES = ['openid', 'email', SEND_SCOPE]
/** Said when Google connected the mailbox but the send permission was left unticked. */
export const NO_SEND = 'Google connected the mailbox without permission to send email. Connect Gmail again and tick “Send email on your behalf” on Google\'s page.'

/** Gmail refused because the stored permission does not include sending. */
export class MissingSendPermission extends Error {}
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

const base64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function loadClient(dataDir: string): OAuthClient | null {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
  const file = join(dataDir, 'google-oauth.json')
  if (!existsSync(file)) return null
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    const c = json.installed ?? json.web ?? json
    return c.client_id && c.client_secret ? { clientId: c.client_id, clientSecret: c.client_secret } : null
  } catch { return null }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl(client: OAuthClient, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), state,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  })
  return AUTH + '?' + q
}

async function token(params: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) })
  const body = await res.json().catch(() => ({})) as Record<string, any>
  if (!res.ok) throw new Error('Google refused the request: ' + (body.error_description ?? body.error ?? 'HTTP ' + res.status))
  return body
}

/** Exchange the code Google returned for a refresh token and the mailbox address (from the ID token). */
export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string, verifier: string): Promise<{ refreshToken: string; email: string }> {
  const body = await token({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier })
  // Google lets the person untick each permission; without the send one the mailbox is of no use here.
  if (!String(body.scope ?? '').split(' ').includes(SEND_SCOPE)) { if (body.refresh_token) await revoke(body.refresh_token); throw new Error(NO_SEND) }
  if (!body.refresh_token) throw new Error('Google did not return a refresh token; remove Finra from the Google account\'s third-party access and connect again.')
  const claims = JSON.parse(Buffer.from(String(body.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8') || '{}')
  if (!claims.email) throw new Error('Google did not say which mailbox was connected.')
  return { refreshToken: body.refresh_token, email: claims.email }
}

export async function accessToken(client: OAuthClient, refreshToken: string): Promise<string> {
  return (await token({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })).access_token
}

/** A header value, encoded only when it is not plain ASCII (RFC 2047). */
const header = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?='
const address = (name: string, email: string) => (name ? header(name.replace(/["\\]/g, '')) + ' ' : '') + '<' + email + '>'

/** An RFC 5322 plain-text message in UTF-8. */
export function message(m: { fromName: string; from: string; toName: string; to: string; subject: string; body: string }): string {
  const body = Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  return [
    'From: ' + address(m.fromName, m.from), 'To: ' + address(m.toName, m.to), 'Subject: ' + header(m.subject),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n')
}

export async function send(client: OAuthClient, refreshToken: string, raw: string): Promise<{ id: string }> {
  const res = await fetch(SEND, {
    method: 'POST', headers: { authorization: 'Bearer ' + await accessToken(client, refreshToken), 'content-type': 'application/json' },
    body: JSON.stringify({ raw: base64url(raw) }), signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, any>
  if (res.status === 403 && /insufficient.*scope/i.test(body.error?.message ?? '')) throw new MissingSendPermission(NO_SEND)
  if (!res.ok) throw new Error('Gmail did not send the message: ' + (body.error?.message ?? 'HTTP ' + res.status))
  return { id: body.id }
}

export async function revoke(refreshToken: string): Promise<void> {
  await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }), signal: AbortSignal.timeout(10_000) }).catch(() => {})
}
