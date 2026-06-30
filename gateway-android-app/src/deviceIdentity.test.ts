import { describe, expect, it } from 'vitest'
import {
  buildGatewayHeaders,
  createGatewayError,
  deviceRoleLabel,
  errorMessage,
  loadGatewaySettings,
  normalizeGatewaySession,
  type GatewaySettings,
  type StorageLike,
} from './deviceIdentity'

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

const defaults: GatewaySettings = {
  baseUrl: 'https://gateway.example',
  token: 'token',
  deviceId: 'default-device',
  deviceName: 'Android Phone',
}

describe('device identity', () => {
  it('generates and persists a stable device id on first settings load', () => {
    const storage = memoryStorage()
    const first = loadGatewaySettings(storage, 'settings', defaults, () => 'generated-device-id')
    const second = loadGatewaySettings(storage, 'settings', defaults, () => 'second-device-id')

    expect(first.deviceId).toBe('generated-device-id')
    expect(second.deviceId).toBe('generated-device-id')
    expect(JSON.parse(storage.getItem('settings') ?? '{}')).toMatchObject({
      deviceId: 'generated-device-id',
    })
  })

  it('keeps old baseUrl token and deviceName settings while adding deviceId', () => {
    const storage = memoryStorage({
      settings: JSON.stringify({
        baseUrl: 'https://old.example',
        token: 'old-token',
        deviceName: '客厅平板',
      }),
    })

    expect(loadGatewaySettings(storage, 'settings', defaults, () => 'new-id')).toEqual({
      baseUrl: 'https://old.example',
      token: 'old-token',
      deviceName: '客厅平板',
      deviceId: 'new-id',
    })
  })

  it('builds protected request headers with stable device metadata', () => {
    expect(
      buildGatewayHeaders(
        {
          baseUrl: 'https://gateway.example',
          token: ' token ',
          deviceName: ' 客厅平板 ',
          deviceId: 'device-123',
        },
        {
          appVersion: '0.1.0',
          model: 'Pixel Tablet',
          platform: 'android',
        },
      ),
    ).toMatchObject({
      Authorization: 'Bearer token',
      'X-App-Version': '0.1.0',
      'X-Device-Id': 'device-123',
      'X-Device-Model': 'Pixel Tablet',
      'X-Device-Name': '客厅平板',
      'X-Device-Platform': 'android',
    })
  })

  it('uses the app version fallback when metadata does not provide one', () => {
    expect(
      buildGatewayHeaders(
        {
          baseUrl: 'https://gateway.example',
          token: 'token',
          deviceName: 'Android Phone',
          deviceId: 'device-123',
        },
        {},
      ),
    ).toMatchObject({
      'X-App-Version': '0.2.0',
    })
  })

  it('normalizes session auth details and role labels', () => {
    const session = normalizeGatewaySession({
      authenticated: true,
      auth: {
        role: 'trusted',
        allowedVisibilities: ['default', 'trusted'],
        pairingCode: '428193',
      },
    })

    expect(session?.auth.role).toBe('trusted')
    expect(session?.auth.allowedVisibilities).toEqual(['default', 'trusted'])
    expect(session?.auth.pairingCode).toBe('428193')
    expect(deviceRoleLabel('default')).toBe('普通设备')
    expect(deviceRoleLabel('trusted')).toBe('受信设备')
    expect(deviceRoleLabel('disabled')).toBe('已禁用')
  })

  it('translates disabled gateway errors clearly', () => {
    const error = createGatewayError({
      error: {
        code: 'device_disabled',
        message: 'This device is disabled.',
        statusCode: 403,
      },
    })

    expect(errorMessage(error)).toContain('设备已被禁用')
  })
})
