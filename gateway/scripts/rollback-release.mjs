#!/usr/bin/env node

import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const defaultGatewayDataDir = process.env.GATEWAY_DATA_DIR || join(process.env.HOME || '.', '.novel_reader_gateway')
const defaultAudioDir = process.env.GATEWAY_AUDIO_DIR || join(defaultGatewayDataDir, 'audio')
const defaultDownloadsDir = process.env.GATEWAY_DOWNLOADS_DIR || join(defaultGatewayDataDir, 'downloads')
const latestApkFileName = 'ai_novel_reader.apk'
const defaultTimeoutMs = 120_000

main().catch((error) => {
  console.error(`回滚失败：${error.message}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  if (!options.target) throw new Error('缺少 --target package|audio|apk')
  if (!['package', 'audio', 'apk'].includes(options.target)) throw new Error('--target 必须是 package、audio 或 apk')

  if (options.target === 'package') {
    await rollbackPackage(options)
  } else if (options.target === 'audio') {
    await rollbackAudio(options)
  } else {
    await rollbackApk(options)
  }
}

async function rollbackPackage(options) {
  const bookId = readBookId(options)
  const gatewayUrl = trimTrailingSlash(options.gatewayUrl || process.env.GATEWAY_BASE_URL || '')
  const gatewayToken = options.gatewayToken || process.env.GATEWAY_DEV_ACCESS_TOKEN || ''
  if (!options.packageFile) throw new Error('package 回滚缺少 --package-file')
  if (!gatewayUrl) throw new Error('package 回滚缺少 --gateway-url 或 GATEWAY_BASE_URL')
  if (!gatewayToken) throw new Error('package 回滚缺少 --gateway-token 或 GATEWAY_DEV_ACCESS_TOKEN')

  const bookPackage = await readJsonFile(options.packageFile, 'package 备份')
  assertPackageMatchesBook(bookPackage, bookId)

  if (!options.apply) {
    console.log(`DRY RUN：将把 ${options.packageFile} 回滚发布到 ${gatewayUrl}/admin/books/${bookId}/package`)
    console.log('追加 --apply 才会写入 Gateway。')
    return
  }

  const response = await fetch(`${gatewayUrl}/admin/books/${encodeURIComponent(bookId)}/package`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
      'x-device-name': options.deviceName || 'Rollback Operator',
    },
    body: JSON.stringify(bookPackage),
    signal: AbortSignal.timeout(readTimeoutMs(options)),
  })

  if (!response.ok) {
    throw new Error(`Gateway 返回 ${response.status}：${await readResponseText(response)}`)
  }

  console.log(`已回滚 package：${bookId}`)
  console.log('建议继续执行 production-pipeline verify 或 Gateway package 可见性验收。')
}

async function rollbackAudio(options) {
  const bookId = readBookId(options)
  if (!options.backupAudioDir) throw new Error('audio 回滚缺少 --backup-audio-dir')
  const backupBookAudioDir = resolve(options.backupAudioDir)
  const gatewayAudioDir = resolve(options.gatewayAudioDir || defaultAudioDir)
  const targetBookAudioDir = resolve(gatewayAudioDir, 'books', bookId)
  await assertFile(join(backupBookAudioDir, 'audio.json'), 'audio 备份缺少 audio.json')

  if (!options.apply) {
    console.log(`DRY RUN：将用 ${backupBookAudioDir} 替换 ${targetBookAudioDir}`)
    console.log('追加 --apply 才会替换本地 Gateway audio 目录。')
    return
  }

  await mkdir(resolve(gatewayAudioDir, 'books'), { recursive: true })
  await rm(targetBookAudioDir, { recursive: true, force: true })
  await cp(backupBookAudioDir, targetBookAudioDir, { recursive: true, force: true, preserveTimestamps: true })

  console.log(`已回滚 audio：${bookId}`)
  console.log(`audio 目录：${targetBookAudioDir}`)
  console.log('如果是远端 Gateway，请同步该目录后执行 admin audio refresh 并重新验收音频 coverage。')
}

async function rollbackApk(options) {
  const downloadsDir = resolve(options.downloadsDir || defaultDownloadsDir)
  const versionedFileName = options.versionedApk
    ? basename(options.versionedApk)
    : options.version
      ? `ai_novel_reader-v${safeFileVersion(options.version)}.apk`
      : ''
  if (!versionedFileName) throw new Error('APK 回滚缺少 --versioned-apk 或 --version')

  const sourceApk = resolve(options.versionedApk || join(downloadsDir, versionedFileName))
  const latestApk = join(downloadsDir, latestApkFileName)
  await assertFile(sourceApk, 'versioned APK 不存在')

  let manifest = null
  if (options.androidAppFile) {
    manifest = await readJsonFile(options.androidAppFile, 'android-app 备份')
  } else {
    manifest = await readExistingAndroidManifest(downloadsDir)
    manifest = {
      ...manifest,
      version: options.version || manifest.version,
      latestFileName: latestApkFileName,
      versionedFileName,
      latestUrl: `/downloads/${latestApkFileName}`,
      versionedUrl: `/downloads/${versionedFileName}`,
      rolledBackAt: new Date().toISOString(),
    }
  }
  assertAndroidManifest(manifest, versionedFileName)

  if (!options.apply) {
    console.log(`DRY RUN：将把 ${sourceApk} 恢复为 ${latestApk}`)
    console.log(`DRY RUN：将写入 ${join(downloadsDir, 'android-app.json')}`)
    console.log('追加 --apply 才会替换 APK latest 与 android-app.json。')
    return
  }

  await mkdir(downloadsDir, { recursive: true })
  await copyFile(sourceApk, latestApk)
  await writeFile(join(downloadsDir, 'android-app.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`已回滚 APK：${versionedFileName} -> ${latestApkFileName}`)
  console.log('建议继续校验 /downloads/android-app.json、latest APK 和真机更新提示。')
}

function parseArgs(argv) {
  const options = {
    target: '',
    bookId: '',
    packageFile: '',
    gatewayUrl: '',
    gatewayToken: '',
    deviceName: '',
    backupAudioDir: '',
    gatewayAudioDir: '',
    downloadsDir: '',
    version: '',
    versionedApk: '',
    androidAppFile: '',
    timeoutMs: defaultTimeoutMs,
    apply: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--apply') {
      options.apply = true
    } else if (arg === '--target') {
      options.target = readArgValue(argv, ++index, arg)
    } else if (arg === '--book-id') {
      options.bookId = readArgValue(argv, ++index, arg)
    } else if (arg === '--package-file') {
      options.packageFile = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-url') {
      options.gatewayUrl = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-token') {
      options.gatewayToken = readArgValue(argv, ++index, arg)
    } else if (arg === '--device-name') {
      options.deviceName = readArgValue(argv, ++index, arg)
    } else if (arg === '--backup-audio-dir') {
      options.backupAudioDir = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-audio-dir') {
      options.gatewayAudioDir = readArgValue(argv, ++index, arg)
    } else if (arg === '--downloads-dir') {
      options.downloadsDir = readArgValue(argv, ++index, arg)
    } else if (arg === '--version') {
      options.version = readArgValue(argv, ++index, arg)
    } else if (arg === '--versioned-apk') {
      options.versionedApk = readArgValue(argv, ++index, arg)
    } else if (arg === '--android-app-file') {
      options.androidAppFile = readArgValue(argv, ++index, arg)
    } else if (arg === '--timeout-ms') {
      const value = Number(readArgValue(argv, ++index, arg))
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout-ms 必须是正数')
      options.timeoutMs = Math.floor(value)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  return options
}

function readBookId(options) {
  const bookId = options.bookId.trim()
  if (!bookId) throw new Error(`${options.target} 回滚缺少 --book-id`)
  return bookId
}

function readArgValue(argv, index, name) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function readTimeoutMs(options) {
  return Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeoutMs
}

async function readJsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`${label} 不是合法 JSON：${path}`)
  }
}

async function readExistingAndroidManifest(downloadsDir) {
  const path = join(downloadsDir, 'android-app.json')
  try {
    return await readJsonFile(path, '现有 android-app.json')
  } catch {
    return {
      schemaVersion: 1,
      appName: 'AI小说助手',
      version: '',
    }
  }
}

function assertPackageMatchesBook(bookPackage, bookId) {
  if (!bookPackage || typeof bookPackage !== 'object' || Array.isArray(bookPackage)) {
    throw new Error('package 备份必须是 JSON object')
  }
  if (bookPackage.schemaVersion !== 1 || !bookPackage.book || typeof bookPackage.book !== 'object') {
    throw new Error('package 备份 schema 无效')
  }
  const packageBookId = String(bookPackage.book.id || '').trim()
  if (!packageBookId) throw new Error('package 备份缺少 book.id')
  if (packageBookId !== bookId) throw new Error(`package book.id (${packageBookId}) 与 --book-id (${bookId}) 不一致`)
}

function assertAndroidManifest(manifest, versionedFileName) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('android-app manifest 必须是 JSON object')
  }
  if (manifest.schemaVersion !== 1) throw new Error('android-app manifest schemaVersion 必须是 1')
  if (manifest.latestFileName !== latestApkFileName) throw new Error(`android-app manifest latestFileName 必须是 ${latestApkFileName}`)
  if (manifest.versionedFileName !== versionedFileName) {
    throw new Error(`android-app manifest versionedFileName 必须是 ${versionedFileName}`)
  }
}

async function assertFile(path, message) {
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new Error(message)
  } catch {
    throw new Error(`${message}：${path}`)
  }
}

function safeFileVersion(version) {
  return version.replace(/[^0-9A-Za-z._-]+/g, '-')
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

async function readResponseText(response) {
  const text = await response.text()
  return text.slice(0, 500)
}

function printUsage() {
  console.log(`用法：
  npm run gateway:rollback-release -- --target package --book-id <id> --package-file backup/package.json --gateway-url <url> --gateway-token <token>
  npm run gateway:rollback-release -- --target audio --book-id <id> --backup-audio-dir backup/audio/books/<id> --gateway-audio-dir <dir>
  npm run gateway:rollback-release -- --target apk --downloads-dir <dir> --version <version>

默认只做 dry-run；追加 --apply 才会写入 Gateway 或本地目录。

package 参数：
  --book-id <id>           书籍 ID，必须与 package.book.id 一致
  --package-file <path>    要恢复的完整 package JSON
  --gateway-url <url>      Gateway 地址，可用 GATEWAY_BASE_URL
  --gateway-token <token>  Gateway admin token，可用 GATEWAY_DEV_ACCESS_TOKEN
  --device-name <name>     记录到 Gateway 的操作设备名

audio 参数：
  --book-id <id>             书籍 ID
  --backup-audio-dir <path>  备份的 book audio 目录，目录内必须有 audio.json
  --gateway-audio-dir <path> Gateway audio 根目录，默认 ${defaultAudioDir}

APK 参数：
  --downloads-dir <path>     Gateway downloads 目录，默认 ${defaultDownloadsDir}
  --version <version>        使用 downloads/ai_novel_reader-v<version>.apk
  --versioned-apk <path>     直接指定要恢复的 versioned APK
  --android-app-file <path>  指定要恢复的 android-app.json；未提供时基于现有元数据改写 latest/versioned 字段
`)
}
