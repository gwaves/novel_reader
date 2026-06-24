import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GatewayAuthContext } from './auth.js'
import type { GatewayConfig } from './config.js'

export type GatewayDeviceRecord = {
  name: string
  firstSeenAt: string
  lastSeenAt: string
}

export type GatewayDeviceRegistry = {
  schemaVersion: 1
  devices: GatewayDeviceRecord[]
}

export async function touchGatewayDevice(config: GatewayConfig, auth: GatewayAuthContext) {
  if (!auth.deviceName) return

  await mkdir(config.dataDir, { recursive: true })
  const registry = await readDeviceRegistry(config)
  const now = new Date().toISOString()
  const existing = registry.devices.find((device) => device.name === auth.deviceName)

  if (existing) {
    existing.lastSeenAt = now
  } else {
    registry.devices.push({
      name: auth.deviceName,
      firstSeenAt: now,
      lastSeenAt: now,
    })
  }

  registry.devices.sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
  await writeDeviceRegistry(config, registry)
}

export async function readDeviceRegistry(config: GatewayConfig): Promise<GatewayDeviceRegistry> {
  let rawRegistry: string
  try {
    rawRegistry = await readFile(join(config.dataDir, 'devices.json'), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        devices: [],
      }
    }
    throw error
  }

  const registry = JSON.parse(rawRegistry) as unknown
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.devices)) {
    return {
      schemaVersion: 1,
      devices: [],
    }
  }

  return {
    schemaVersion: 1,
    devices: registry.devices.flatMap((device) => normalizeDevice(device)),
  }
}

async function writeDeviceRegistry(config: GatewayConfig, registry: GatewayDeviceRegistry) {
  const path = join(config.dataDir, 'devices.json')
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(tmpPath, path)
}

function normalizeDevice(device: unknown): GatewayDeviceRecord[] {
  if (!isRecord(device)) return []
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  const firstSeenAt = typeof device.firstSeenAt === 'string' ? device.firstSeenAt : ''
  const lastSeenAt = typeof device.lastSeenAt === 'string' ? device.lastSeenAt : ''
  if (!name || Number.isNaN(Date.parse(firstSeenAt)) || Number.isNaN(Date.parse(lastSeenAt))) return []
  return [
    {
      name,
      firstSeenAt,
      lastSeenAt,
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
