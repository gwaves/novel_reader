import { buildGatewayApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = buildGatewayApp(config)

try {
  await app.listen({
    host: config.host,
    port: config.port,
  })
} catch (error) {
  app.log.error(error, 'failed to start gateway')
  process.exitCode = 1
}
