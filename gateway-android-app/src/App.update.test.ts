import { describe, expect, it } from 'vitest'
import { appUpdateStatusLabel, normalizeAppUpdateManifest, resolveAppUpdateManifest } from './App'

describe('app update checks', () => {
  it('normalizes Gateway Android update manifests', () => {
    expect(
      normalizeAppUpdateManifest({
        versionName: '0.2.0+build.235.gabcdef0',
        versionCode: 2000235,
        buildNumber: 235,
        gitCommit: 'abcdef0',
        latestUrl: '/downloads/novel_gateway.apk',
        latestFileName: 'novel_gateway.apk',
        publishedAt: '2026-07-01T12:00:00.000Z',
      }),
    ).toEqual({
      versionName: '0.2.0+build.235.gabcdef0',
      versionCode: 2000235,
      buildNumber: 235,
      gitCommit: 'abcdef0',
      latestUrl: '/downloads/novel_gateway.apk',
      latestFileName: 'novel_gateway.apk',
      publishedAt: '2026-07-01T12:00:00.000Z',
    })

    expect(normalizeAppUpdateManifest({ versionCode: 2000235, latestUrl: '/downloads/novel_gateway.apk' })).toBeNull()
    expect(normalizeAppUpdateManifest({ versionName: '0.2.0', latestUrl: '/downloads/novel_gateway.apk' })).toBeNull()
  })

  it('marks equal or older Gateway APK manifests as current', () => {
    const equalManifest = {
      versionName: '0.2.0+build.233.gcurrent',
      versionCode: 2000233,
      latestUrl: '/downloads/novel_gateway.apk',
    }
    const olderManifest = {
      versionName: '0.2.0+build.232.gold',
      versionCode: 2000232,
      latestUrl: '/downloads/novel_gateway.apk',
    }

    expect(resolveAppUpdateManifest(equalManifest, 2000233, '0.2.0+build.233.gcurrent')).toEqual({
      status: 'current',
      manifest: equalManifest,
      message: '已是最新版本 0.2.0+build.233.gcurrent',
    })
    expect(resolveAppUpdateManifest(olderManifest, 2000233, '0.2.0+build.233.gcurrent')).toEqual({
      status: 'current',
      manifest: olderManifest,
      message: '已是最新版本 0.2.0+build.233.gcurrent',
    })
    expect(appUpdateStatusLabel({ status: 'current', manifest: equalManifest, message: '已是最新版本' })).toBe('已是最新')
  })

  it('requires a strictly higher versionCode before offering install', () => {
    const manifest = {
      versionName: '0.2.0+build.234.gnext',
      versionCode: 2000234,
      latestUrl: '/downloads/novel_gateway.apk',
    }

    expect(resolveAppUpdateManifest(manifest, 2000233, '0.2.0+build.233.gcurrent')).toEqual({
      status: 'available',
      manifest,
      message: '发现新版本 0.2.0+build.234.gnext',
    })
    expect(appUpdateStatusLabel({ status: 'available', manifest, message: '发现新版本' })).toBe('有新版本')
  })
})
