import { describe, expect, it } from 'vitest'
import {
  blockedGatewaySyncMessage,
  cloudActionBlockedReason,
  gatewaySyncBlockedReason,
  localCacheReadableWhenDisabled,
  libraryVisibilityNotice,
  roleChangeNotice,
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
    expect(libraryVisibilityNotice(session('default'), 0)).toContain('普通设备仅默认书库')
    expect(libraryVisibilityNotice(session('trusted', ['default', 'trusted']), 4)).toContain('受信设备可看到默认书库和受信书库')
    expect(libraryVisibilityNotice(session('disabled'), 0)).toContain('本地缓存仍可读，云端同步已禁用')
    expect(libraryVisibilityNotice(null, 0)).toContain('刷新授权状态后会显示当前设备可见范围')
  })

  it('blocks sync when the current session is disabled', () => {
    expect(gatewaySyncBlockedReason(session('disabled'))).toBe('设备已禁用，本地缓存仍可读，云端同步已禁用。')
    expect(gatewaySyncBlockedReason(session('default'))).toBeNull()
  })

  it('reports trusted role expansion after authorization refresh', () => {
    expect(roleChangeNotice(session('default'), session('trusted', ['default', 'trusted']), 2, 5)).toBe(
      '授权已更新：受信设备可看到默认书库和受信书库，可见书从 2 本增加到 5 本。',
    )
    expect(roleChangeNotice(session('trusted', ['default', 'trusted']), session('disabled'), 5, 0)).toContain(
      '本地缓存仍可读，云端同步已禁用',
    )
    expect(roleChangeNotice(null, session('trusted', ['default', 'trusted']), 0, 4)).toBeNull()
  })

  it('keeps disabled devices readable only when local cache exists', () => {
    expect(localCacheReadableWhenDisabled(session('disabled'), true)).toBe(true)
    expect(localCacheReadableWhenDisabled(session('disabled'), false)).toBe(false)
    expect(localCacheReadableWhenDisabled(session('trusted', ['default', 'trusted']), true)).toBe(true)
  })

  it('uses one disabled message for cloud-only operations', () => {
    expect(cloudActionBlockedReason(session('disabled'), '加入书架')).toBe('设备已禁用，不能加入书架。本地缓存仍可读，云端同步已禁用。')
    expect(cloudActionBlockedReason(session('disabled'), '下载 MP3')).toBe('设备已禁用，不能下载 MP3。本地缓存仍可读，云端同步已禁用。')
    expect(cloudActionBlockedReason(session('default'), '加入书架')).toBeNull()
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
