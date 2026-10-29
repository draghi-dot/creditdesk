// Runs the assessment engine and the Vite workspace together; stops both on exit.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const port = process.env.ENGINE_PORT ?? '8787'
const vitePort = process.env.VITE_PORT ?? '5173'

const free = p => new Promise(resolve => {
  const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)))
  probe.listen(Number(p), '127.0.0.1')
})
for (const [p, what, env] of [[port, 'engine', 'ENGINE_PORT'], [vitePort, 'workspace', 'VITE_PORT']]) {
  if (await free(p)) continue
  console.error(`Port ${p} (${what}) is already in use, probably by an earlier dev server.\n` +
    `  Stop it:   lsof -ti tcp:${p} | xargs kill\n` +
    `  or use another port:   ${env}=${Number(p) + 1} npm run dev`)
  process.exit(1)
}

const children = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=src/assessment.ts', '--watch-path=src/analysis.ts', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, PORT: port } }),
  spawn('npx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit', env: { ...process.env, ENGINE_PORT: port, VITE_PORT: vitePort } }),
]
const stop = () => { for (const child of children) child.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', code => { if (code) { stop(); process.exitCode = code } })
console.log(`\nFinra workspace: http://127.0.0.1:${vitePort}  (engine API on :${port})\n`)
