import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const viteBin = join(rootDir, 'node_modules', '.bin', 'vite')
const apiServer = join(rootDir, 'scripts', 'local-db-server.mjs')
const host = process.env.NOVEL_READER_HOST || '0.0.0.0'

const children = [
  spawn(process.execPath, ['--no-warnings', apiServer], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(viteBin, ['--host', host], {
    cwd: rootDir,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  }),
]

let isShuttingDown = false

function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true

  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (isShuttingDown) return

    shutdown(signal ?? 'SIGTERM')
    process.exitCode = code ?? 1
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
