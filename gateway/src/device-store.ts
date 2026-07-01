import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomInt, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { GatewayAuthContext } from './auth.js'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export type GatewayDeviceRole = 'default' | 'trusted' | 'disabled'

export type GatewayDeviceRecord = {
  id: string
  name: string
  model?: string
  platform?: string
  appVersion?: string
  pairingCode: string
  role: GatewayDeviceRole
  firstSeenAt: string
  lastSeenAt: string
  lastIp?: string
}

export type GatewayDeviceRegistry = {
  schemaVersion: 1
  devices: GatewayDeviceRecord[]
}

export async function touchGatewayDevice(config: GatewayConfig, auth: GatewayAuthContext, lastIp?: string) {
  const deviceId = auth.deviceId || (auth.deviceName ? legacyDeviceId(auth.deviceName) : undefined)
  if (!deviceId && !auth.deviceName) return undefined

  await mkdir(config.dataDir, { recursive: true })
  const registry = await readDeviceRegistry(config)
  const now = new Date().toISOString()
  const existing = registry.devices.find((device) => device.id === deviceId)
    ?? (auth.deviceName ? registry.devices.find((device) => device.id === legacyDeviceId(auth.deviceName!)) : undefined)

  if (existing) {
    existing.id = deviceId ?? existing.id
    existing.name = auth.deviceName ?? existing.name
    existing.model = auth.deviceModel ?? existing.model
    existing.platform = auth.devicePlatform ?? existing.platform
    existing.appVersion = auth.appVersion ?? existing.appVersion
    existing.pairingCode = existing.pairingCode || generatePairingCode()
    existing.role = normalizeRole(existing.role)
    existing.lastSeenAt = now
    existing.lastIp = lastIp ?? existing.lastIp
  } else {
    registry.devices.push({
      id: deviceId ?? legacyDeviceId(auth.deviceName!),
      name: auth.deviceName ?? deviceId!,
      model: auth.deviceModel,
      platform: auth.devicePlatform,
      appVersion: auth.appVersion,
      pairingCode: generatePairingCode(),
      role: 'default',
      firstSeenAt: now,
      lastSeenAt: now,
      lastIp,
    })
  }

  registry.devices.sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
  await writeDeviceRegistry(config, registry)
  return registry.devices.find((device) => device.id === (deviceId ?? legacyDeviceId(auth.deviceName!)))
}

export async function updateGatewayDevice(
  config: GatewayConfig,
  deviceId: string,
  patch: { name?: unknown; role?: unknown },
) {
  const registry = await readDeviceRegistry(config)
  const device = registry.devices.find((candidate) => candidate.id === deviceId)
  if (!device) {
    throw new GatewayHttpError(404, 'device_not_found', `Gateway device ${deviceId} was not found.`)
  }

  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      throw new GatewayHttpError(400, 'invalid_device_update', 'Device name must be a non-empty string.')
    }
    device.name = patch.name.trim().slice(0, 80)
  }
  if (patch.role !== undefined) {
    if (!isDeviceRole(patch.role)) {
      throw new GatewayHttpError(400, 'invalid_device_update', 'Device role is invalid.')
    }
    device.role = patch.role
  }

  await writeDeviceRegistry(config, registry)
  return device
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
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(tmpPath, path)
}

function normalizeDevice(device: unknown): GatewayDeviceRecord[] {
  if (!isRecord(device)) return []
  const rawName = typeof device.name === 'string' ? device.name.trim() : ''
  const rawId = typeof device.id === 'string' ? device.id.trim() : ''
  const id = rawId || (rawName ? legacyDeviceId(rawName) : '')
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  const now = new Date().toISOString()
  const firstSeenAt = typeof device.firstSeenAt === 'string' ? device.firstSeenAt : now
  const lastSeenAt = typeof device.lastSeenAt === 'string' ? device.lastSeenAt : firstSeenAt
  if (!id || !name || Number.isNaN(Date.parse(firstSeenAt)) || Number.isNaN(Date.parse(lastSeenAt))) return []
  return [
    {
      id,
      name,
      model: readOptionalString(device, 'model'),
      platform: readOptionalString(device, 'platform'),
      appVersion: readOptionalString(device, 'appVersion'),
      pairingCode: readPairingCode(device.pairingCode),
      role: normalizeRole(device.role),
      firstSeenAt,
      lastSeenAt,
      lastIp: readOptionalString(device, 'lastIp'),
    },
  ]
}

function legacyDeviceId(name: string) {
  return `legacy:${name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'device'}`
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readPairingCode(value: unknown) {
  return typeof value === 'string' && /^\d{6}$/.test(value) ? value : generatePairingCode()
}

function generatePairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function normalizeRole(value: unknown): GatewayDeviceRole {
  return isDeviceRole(value) ? value : 'default'
}

function isDeviceRole(value: unknown): value is GatewayDeviceRole {
  return value === 'default' || value === 'trusted' || value === 'disabled'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
