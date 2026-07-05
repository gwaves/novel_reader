export type GatewaySettings = {
  baseUrl: string
  token: string
  deviceId: string
  deviceName: string
}

export type DeviceRole = 'default' | 'trusted' | 'disabled'

export type GatewaySessionAuth = {
  mode?: string
  deviceId: string
  deviceName: string
  role: DeviceRole
  allowedVisibilities: string[]
  pairingCode: string
}

export type GatewaySession = {
  authenticated: boolean
  auth: GatewaySessionAuth
}

export type DeviceMetadata = {
  appVersion: string
  model: string
  platform: string
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class GatewayError extends Error {
  code?: string
  statusCode?: number

  constructor(message: string, options: { code?: string; statusCode?: number } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

const fallbackDeviceName = 'Android Phone'
const fallbackDeviceModel = 'Unknown Android Device'
const fallbackDevicePlatform = 'android'
const fallbackAppVersion = '0.7.0'

export function loadGatewaySettings(
  storage: StorageLike,
  settingsKey: string,
  defaults: GatewaySettings,
  createDeviceId: () => string = generateDeviceId,
): GatewaySettings {
  const parsed = readStoredSettings(storage, settingsKey)
  const settings = normalizeGatewaySettings(parsed, defaults, createDeviceId)
  const needsPersist =
    parsed?.baseUrl !== settings.baseUrl ||
    parsed?.token !== settings.token ||
    parsed?.deviceName !== settings.deviceName ||
    parsed?.deviceId !== settings.deviceId

  if (needsPersist) {
    storage.setItem(settingsKey, JSON.stringify(settings))
  }

  return settings
}

export function normalizeGatewaySettings(
  parsed: Partial<GatewaySettings> | null | undefined,
  defaults: GatewaySettings,
  createDeviceId: () => string = generateDeviceId,
): GatewaySettings {
  return {
    baseUrl: readNonEmptyString(parsed?.baseUrl) || defaults.baseUrl,
    token: typeof parsed?.token === 'string' ? parsed.token : defaults.token,
    deviceName: readNonEmptyString(parsed?.deviceName) || defaults.deviceName || fallbackDeviceName,
    deviceId: readNonEmptyString(parsed?.deviceId) || createDeviceId(),
  }
}

export function buildGatewayHeaders(
  settings: GatewaySettings,
  metadata: Partial<DeviceMetadata> = {},
  extraHeaders: Record<string, string> = {},
) {
  return {
    Authorization: `Bearer ${settings.token.trim()}`,
    'X-Device-Id': settings.deviceId.trim(),
    'X-Device-Name': settings.deviceName.trim() || fallbackDeviceName,
    'X-Device-Model': readNonEmptyString(metadata.model) || fallbackDeviceModel,
    'X-Device-Platform': readNonEmptyString(metadata.platform) || fallbackDevicePlatform,
    'X-App-Version': readNonEmptyString(metadata.appVersion) || fallbackAppVersion,
    ...extraHeaders,
  }
}

export function getDeviceMetadata(appVersion: string): DeviceMetadata {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return {
    appVersion,
    model: inferDeviceModel(userAgent),
    platform: inferDevicePlatform(userAgent),
  }
}

export function normalizeGatewaySession(value: unknown): GatewaySession | null {
  if (!isRecord(value)) return null
  const auth = isRecord(value.auth) ? value.auth : {}
  const role = normalizeDeviceRole(auth.role)
  return {
    authenticated: value.authenticated === true,
    auth: {
      mode: readNonEmptyString(auth.mode) || undefined,
      deviceId: readNonEmptyString(auth.deviceId),
      deviceName: readNonEmptyString(auth.deviceName),
      role,
      allowedVisibilities: readStringArray(auth.allowedVisibilities),
      pairingCode: readNonEmptyString(auth.pairingCode),
    },
  }
}

export function deviceRoleLabel(role: DeviceRole) {
  if (role === 'trusted') return '受信设备'
  if (role === 'disabled') return '已禁用'
  return '普通设备'
}

export function deviceRoleDescription(role: DeviceRole) {
  if (role === 'trusted') return '可访问默认书库和受信书库'
  if (role === 'disabled') return '当前设备已被禁用，不能访问受保护 Gateway API'
  return '可访问默认书库'
}

export function createGatewayError(body: unknown, fallbackMessage = '请求失败', statusCode?: number) {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  const message = readNonEmptyString(error?.message) || fallbackMessage
  const code = readNonEmptyString(error?.code) || undefined
  const bodyStatusCode = typeof error?.statusCode === 'number' ? error.statusCode : undefined
  return new GatewayError(message, {
    code,
    statusCode: bodyStatusCode ?? statusCode,
  })
}

export function isDeviceDisabledError(error: unknown) {
  return error instanceof GatewayError && error.code === 'device_disabled'
}

export function isDeviceUnauthorizedError(error: unknown) {
  return (
    error instanceof GatewayError &&
    (error.code === 'device_unauthorized' || error.code === 'device_not_authorized' || error.code === 'unauthorized_device')
  )
}

export function isInvalidTokenError(error: unknown) {
  return error instanceof GatewayError && (error.code === 'invalid_token' || /bearer token is invalid/i.test(error.message))
}

export function isDeviceAccessBlockedError(error: unknown) {
  return isDeviceDisabledError(error) || isDeviceUnauthorizedError(error)
}

export function errorMessage(error: unknown) {
  if (isDeviceDisabledError(error)) {
    return '设备已被禁用，不能访问 Gateway。请在管理后台启用后再刷新授权状态。'
  }
  if (isDeviceUnauthorizedError(error)) {
    return '设备未授权，不能同步云端书库。请在管理后台确认设备角色后再刷新授权状态。'
  }
  if (isInvalidTokenError(error)) {
    return 'Gateway Token 无效，请在设置页检查 Token 后重试。'
  }
  return error instanceof Error ? error.message : '请求失败'
}

function readStoredSettings(storage: StorageLike, settingsKey: string): Partial<GatewaySettings> | null {
  try {
    const value = storage.getItem(settingsKey)
    if (!value) return null
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function generateDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const random = Math.random().toString(36).slice(2, 12)
  return `device-${Date.now().toString(36)}-${random}`
}

function inferDevicePlatform(userAgent: string) {
  if (/android/i.test(userAgent)) return 'android'
  if (/iphone|ipad|ios/i.test(userAgent)) return 'ios'
  if (/macintosh|windows|linux/i.test(userAgent)) return 'web'
  return fallbackDevicePlatform
}

function inferDeviceModel(userAgent: string) {
  const androidMatch = userAgent.match(/Android\s+[^;]+;\s*([^;)]+)[;)]/i)
  return readNonEmptyString(androidMatch?.[1]) || fallbackDeviceModel
}

function normalizeDeviceRole(value: unknown): DeviceRole {
  if (value === 'trusted' || value === 'disabled') return value
  return 'default'
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : []
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
