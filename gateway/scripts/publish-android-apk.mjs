#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const defaultProjectRoot = resolve(new URL('../..', import.meta.url).pathname)
const defaultApkDir = join(defaultProjectRoot, 'gateway-android-app/android/app/build/outputs/apk/debug')
const latestFileName = 'novel_gateway.apk'
const buildInfoPath = join(defaultProjectRoot, 'gateway-android-app/build-info.json')

main().catch((error) => {
  console.error(`发布 APK 失败：${error.message}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const buildInfo = await readAndroidBuildInfo()
  const version = options.version || buildInfo.versionName
  const downloadsDir = resolve(options.downloadsDir || process.env.GATEWAY_DOWNLOADS_DIR || join(process.env.GATEWAY_DATA_DIR || join(process.env.HOME || '.', '.novel_reader_gateway'), 'downloads'))
  const sourceApk = resolve(options.sourceApk || join(defaultApkDir, `novel_gateway-v${buildInfo.versionName}-debug.apk`))
  const versionedFileName = `novel_gateway-v${safeFileVersion(version)}-debug.apk`

  await mkdir(downloadsDir, { recursive: true })
  await copyFile(sourceApk, join(downloadsDir, latestFileName))
  await copyFile(sourceApk, join(downloadsDir, versionedFileName))
  await writeFile(
    join(downloadsDir, 'android-app.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appName: 'AI小说助手',
        version,
        baseVersion: buildInfo.baseVersion,
        versionName: buildInfo.versionName,
        versionCode: buildInfo.versionCode,
        buildNumber: buildInfo.buildNumber,
        gitCommit: buildInfo.gitCommit,
        dirty: buildInfo.dirty,
        buildTime: buildInfo.buildTime,
        latestFileName,
        versionedFileName,
        latestUrl: `/downloads/${latestFileName}`,
        versionedUrl: `/downloads/${versionedFileName}`,
        sourceFileName: basename(sourceApk),
        publishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )

  console.log(`已发布 APK 到 ${downloadsDir}`)
  console.log(`latest: /downloads/${latestFileName}`)
  console.log(`versioned: /downloads/${versionedFileName}`)
}

async function readAndroidBuildInfo() {
  try {
    const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'))
    if (typeof buildInfo.versionName === 'string' && buildInfo.versionName.trim()) {
      return {
        baseVersion: readNonEmptyString(buildInfo.baseVersion) || await readPackageVersion(),
        versionName: buildInfo.versionName.trim(),
        versionCode: Number.isInteger(buildInfo.versionCode) ? buildInfo.versionCode : 0,
        buildNumber: Number.isInteger(buildInfo.buildNumber) ? buildInfo.buildNumber : 0,
        gitCommit: readNonEmptyString(buildInfo.gitCommit) || 'unknown',
        dirty: Boolean(buildInfo.dirty),
        buildTime: readNonEmptyString(buildInfo.buildTime) || '',
      }
    }
  } catch {
    // Fall back to package.json below for older builds.
  }
  const baseVersion = await readPackageVersion()
  return {
    baseVersion,
    versionName: baseVersion,
    versionCode: 0,
    buildNumber: 0,
    gitCommit: 'unknown',
    dirty: false,
    buildTime: '',
  }
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(join(defaultProjectRoot, 'gateway-android-app/package.json'), 'utf8'))
  const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''
  if (!version) throw new Error('gateway-android-app/package.json 缺少 version')
  return version
}

function safeFileVersion(version) {
  return version.replace(/[^0-9A-Za-z._-]+/g, '-')
}

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function parseArgs(argv) {
  const options = {
    sourceApk: '',
    downloadsDir: '',
    version: '',
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--source-apk') {
      options.sourceApk = readArgValue(argv, ++index, arg)
    } else if (arg === '--downloads-dir') {
      options.downloadsDir = readArgValue(argv, ++index, arg)
    } else if (arg === '--version') {
      options.version = readArgValue(argv, ++index, arg)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  return options
}

function readArgValue(argv, index, name) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function printUsage() {
  console.log(`用法：
  npm run gateway:publish-android-apk
  npm run gateway:publish-android-apk -- --downloads-dir /srv/novel-reader/downloads
  npm run gateway:publish-android-apk -- --source-apk path/to/app.apk --version 0.2.0

说明：
  默认读取 gateway-android-app 的 debug APK，并发布到 GATEWAY_DOWNLOADS_DIR。
  最新版固定文件名：${latestFileName}
  同时保留版本文件：novel_gateway-v<version>-debug.apk`)
}
