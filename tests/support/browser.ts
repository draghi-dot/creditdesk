/**
 * A headless Chromium driven over the DevTools protocol, without a browser
 * automation dependency. Uses CHROME_PATH, or the first Chromium-based
 * browser found (Chrome, Chromium, Brave, Edge).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

export const findChrome = (): string | null => process.env.CHROME_PATH ?? CANDIDATES.find(p => existsSync(p)) ?? null

export interface Page {
  goto(url: string): Promise<void>
  eval<T = any>(expression: string): Promise<T>
  /** Polls `expression` until it returns something truthy, and returns it. */
  waitFor<T = any>(expression: string, what: string, timeoutMs?: number): Promise<T>
  /** Clicks the first element matching `selector` whose text includes `text`. */
  click(selector: string, text?: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  screenshot(file: string, fullPage?: boolean): Promise<void>
  /** Uncaught exceptions and console errors seen on the page. */
  errors: string[]
  close(): Promise<void>
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

/** The first page's debugger address; the initial tab can appear a moment after the browser starts listening. */
async function pageTarget(base: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const targets = await (await fetch(base + '/json/list')).json() as { type: string; webSocketDebuggerUrl: string }[]
    const page = targets.find(t => t.type === 'page')
    if (page) return page.webSocketDebuggerUrl
    await new Promise(r => setTimeout(r, 100))
  }
  const created = await (await fetch(base + '/json/new?about:blank', { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
  return created.webSocketDebuggerUrl
}

export async function launch(width = 1440, height = 960): Promise<Page> {
  const binary = findChrome()
  if (!binary) throw new Error('No Chromium-based browser found; set CHROME_PATH')
  const profile = mkdtempSync(join(tmpdir(), 'creditdesk-browser-'))
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=' + width + ',' + height, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('The browser did not start:\n' + output)), 20_000)
    child.stderr!.on('data', chunk => {
      output += chunk
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(output)
      if (found) { clearTimeout(timer); resolve(found[1]) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('The browser exited (' + code + '):\n' + output)) })
  })
  const quit = () => { child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }) }
  let ws: WebSocket
  try {
    ws = new WebSocket(await pageTarget('http://127.0.0.1:' + new URL(endpoint).port))
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to the browser')) })
  } catch (err) { quit(); throw err }

  let nextId = 0
  const pending = new Map<number, Pending>()
  const errors: string[] = []
  let loaded: (() => void) | null = null
  ws.onmessage = message => {
    const data = JSON.parse(String(message.data))
    if (data.id) {
      const call = pending.get(data.id)!
      pending.delete(data.id)
      if (data.error) call.reject(new Error(data.error.message))
      else call.resolve(data.result)
    } else if (data.method === 'Page.loadEventFired') loaded?.()
    else if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text)
    else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') errors.push(data.params.args.map((a: any) => a.value ?? a.description).join(' '))
  }
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const find = (selector: string, text?: string) => 'Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).find(el => ' + (text ? 'el.textContent.includes(' + JSON.stringify(text) + ')' : 'true') + ')'

  const page: Page = {
    errors,
    async goto(url) {
      const load = new Promise<void>(resolve => { loaded = resolve })
      const result = await send('Page.navigate', { url })
      if (result.errorText) throw new Error(result.errorText + ': ' + url)
      // A same-document navigation (only the hash changes) fires no load event.
      if (!result.loaderId) return
      await Promise.race([load, new Promise((_, reject) => setTimeout(() => reject(new Error('page did not load: ' + url)), 20_000).unref())])
    },
    eval: evaluate,
    async waitFor(expression, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const value = await evaluate(expression).catch(() => null)
        if (value) return value
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what)
        await new Promise(r => setTimeout(r, 40))
      }
    },
    async click(selector, text) {
      const clicked = await evaluate('(() => { const el = ' + find(selector, text) + '; if (!el || el.disabled) return false; el.scrollIntoView({ block: "center" }); el.click(); return true })()')
      if (!clicked) throw new Error('Nothing clickable: ' + selector + (text ? ' "' + text + '"' : ''))
    },
    async type(selector, text) {
      const focused = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.focus(); return true })()')
      if (!focused) throw new Error('No input: ' + selector)
      await send('Input.insertText', { text })
    },
    async screenshot(file, fullPage = false) {
      const size = fullPage ? await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })') : null
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(size ? { clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } } : {}) })
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
    },
    async close() {
      ws.close()
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', () => resolve()); child.kill('SIGTERM') } })
      rmSync(profile, { recursive: true, force: true })
    },
  }
  return page
}
