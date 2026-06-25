import { buildGatewayApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = buildGatewayApp(config)

try {
  await app.listen({
    host: config.host,
    port: config.port,
  })
  await waitForever()
} catch (error) {
  app.log.error(error, 'failed to start gateway')
  process.exitCode = 1
}

function waitForever() {
  return new Promise<void>(() => {
    setInterval(() => {
      app.log.trace('gateway keepalive')
    }, 60_000)
  })
}
