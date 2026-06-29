import { describe, expect, it } from 'vitest'
import {
  blockedGatewaySyncMessage,
  gatewaySyncBlockedReason,
  libraryVisibilityNotice,
  syncStatusLabel,
} from './App'
import { createGatewayError, type GatewaySession } from './deviceIdentity'

const session = (role: GatewaySession['auth']['role'], allowedVisibilities: string[] = ['default']): GatewaySession => ({
  authenticated: true,
  auth: {
    deviceId: 'device-123',
    deviceName: '客厅平板',
    role,
    allowedVisibilities,
    pairingCode: '428193',
  },
})

describe('device authorization UI state', () => {
  it('explains default, trusted, disabled, and unknown library visibility', () => {
    expect(libraryVisibilityNotice(session('default'), 2)).toContain('普通设备仅显示默认书库')
    expect(libraryVisibilityNotice(session('trusted', ['default', 'trusted']), 4)).toContain('受信设备可看到默认书库和受信书库')
    expect(libraryVisibilityNotice(session('disabled'), 0)).toContain('设备已禁用，不能同步云端书库')
    expect(libraryVisibilityNotice(null, 0)).toContain('刷新授权状态后会显示当前设备可见范围')
  })

  it('blocks sync when the current session is disabled', () => {
    expect(gatewaySyncBlockedReason(session('disabled'))).toBe('设备已禁用，不能同步云端书库。')
    expect(gatewaySyncBlockedReason(session('default'))).toBeNull()
  })

  it('surfaces backend disabled or unauthorized errors as blocking sync errors', () => {
    expect(
      blockedGatewaySyncMessage(
        createGatewayError({
          error: { code: 'device_disabled', statusCode: 403 },
        }),
      ),
    ).toContain('设备已被禁用')
    expect(
      blockedGatewaySyncMessage(
        createGatewayError({
          error: { code: 'device_unauthorized', statusCode: 403 },
        }),
      ),
    ).toContain('设备未授权')
  })

  it('formats recent sync state for settings', () => {
    expect(syncStatusLabel({ status: 'never' })).toBe('尚未同步')
    expect(syncStatusLabel({ status: 'blocked', message: '设备未授权，请刷新授权状态。' })).toBe('同步被阻止：设备未授权，请刷新授权状态。')
    expect(syncStatusLabel({ status: 'synced', at: '2026-06-29T10:20:30.000Z', bookCount: 3 })).toContain('3 本')
  })
})
