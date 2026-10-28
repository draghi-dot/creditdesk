import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authUrl, exchangeCode, message, pkce, send } from '../server/gmail.ts'

const client = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' }

test('the message is RFC 5322 plain text in UTF-8, with non-ASCII headers encoded', () => {
  const raw = message({ fromName: 'Ioana Marinescu', from: 'ioana@bank.example.ro', toName: 'Ștefan Pop', to: 'stefan@client.example.ro', subject: 'CONPET SA: suma solicitată', body: 'Bună ziua,\nVă rugăm să confirmați suma.' })
  const [head, body] = raw.split('\r\n\r\n')
  assert.match(head, /^From: Ioana Marinescu <ioana@bank\.example\.ro>\r\n/)
  assert.match(head, /\r\nTo: =\?UTF-8\?B\?.+\?= <stefan@client\.example\.ro>\r\n/)
  assert.match(head, /\r\nSubject: =\?UTF-8\?B\?.+\?=\r\n/)
  assert.ok(head.includes('Content-Type: text/plain; charset="UTF-8"') && head.includes('Content-Transfer-Encoding: base64'))
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Bună ziua,\r\nVă rugăm să confirmați suma.')
  const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)![1]
  assert.equal(Buffer.from(subject, 'base64').toString('utf8'), 'CONPET SA: suma solicitată')
})

test('sign-in uses PKCE; the code is exchanged for a refresh token and the mailbox address', async () => {
  const { verifier, challenge } = pkce()
  const url = new URL(authUrl(client, 'http://127.0.0.1:5173/api/gmail/callback', 'state-1', challenge))
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge'), challenge)
  const claims = Buffer.from(JSON.stringify({ email: 'ioana@bank.example.ro' })).toString('base64url')
  let sent: URLSearchParams | null = null
  globalThis.fetch = async (_url: any, init: any) => {
    sent = new URLSearchParams(String(init.body))
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r-1', id_token: 'h.' + claims + '.s' }), { status: 200 })
  }
  assert.deepEqual(await exchangeCode(client, 'code-1', 'http://127.0.0.1:5173/api/gmail/callback', verifier), { refreshToken: 'r-1', email: 'ioana@bank.example.ro' })
  assert.equal(sent!.get('code_verifier'), verifier)
  assert.equal(sent!.get('grant_type'), 'authorization_code')
})

test('sending refreshes the access token and posts the message base64url-encoded', async () => {
  const calls: { url: string; init: any }[] = []
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'access-9' }), { status: 200 }) : new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
  }
  assert.deepEqual(await send(client, 'r-1', 'Subject: x\r\n\r\nhello'), { id: 'msg-1' })
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('grant_type'), 'refresh_token')
  assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  assert.equal(calls[1].init.headers.authorization, 'Bearer access-9')
  assert.equal(Buffer.from(JSON.parse(calls[1].init.body).raw, 'base64url').toString(), 'Subject: x\r\n\r\nhello')
  globalThis.fetch = async (url: any) => String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }) : new Response(JSON.stringify({ error: { message: 'Invalid To header' } }), { status: 400 })
  await assert.rejects(send(client, 'r-1', 'x'), /Gmail did not send the message: Invalid To header/)
})
