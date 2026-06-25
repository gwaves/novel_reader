#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const defaultSourceApi = process.env.NOVEL_READER_API_BASE_URL || 'http://127.0.0.1:5174'
const defaultDeviceName = process.env.GATEWAY_DEVICE_NAME || 'PC Publisher'
const defaultTimeoutMs = 120_000

main().catch((error) => {
  console.error(`发布失败：${error.message}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const bookId = options.bookId?.trim()
  const gatewayUrl = trimTrailingSlash(options.gatewayUrl || process.env.GATEWAY_BASE_URL || '')
  const gatewayToken = options.gatewayToken || process.env.GATEWAY_DEV_ACCESS_TOKEN || ''
  const sourceApi = trimTrailingSlash(options.sourceApi || defaultSourceApi)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeoutMs

  if (!bookId) throw new Error('缺少 --book-id')
  if (!gatewayUrl) throw new Error('缺少 --gateway-url 或 GATEWAY_BASE_URL')
  if (!gatewayToken) throw new Error('缺少 --gateway-token 或 GATEWAY_DEV_ACCESS_TOKEN')

  const bookPackage = await loadBookPackage({
    bookId,
    sourceApi,
    sourceFile: options.sourceFile,
    sourceToken: options.sourceToken || process.env.NOVEL_READER_SYNC_TOKEN || '',
    timeoutMs,
  })
  const normalizedBookId = normalizePackageBookId(bookPackage, bookId)
  assertMobileBookPackage(bookPackage, normalizedBookId)

  const chapterCount = Array.isArray(bookPackage.chapters) ? bookPackage.chapters.length : 0
  const bookTitle = getBookTitle(bookPackage)

  if (options.dryRun) {
    console.log(`DRY RUN：已读取《${bookTitle}》(${normalizedBookId})，章节 ${chapterCount}，未上传。`)
    return
  }

  const response = await fetch(`${gatewayUrl}/admin/books/${encodeURIComponent(normalizedBookId)}/package`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
      'x-device-name': options.deviceName || defaultDeviceName,
    },
    body: JSON.stringify(bookPackage),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`Gateway 返回 ${response.status}：${await readResponseText(response)}`)
  }

  const result = await response.json()
  console.log(`已发布《${bookTitle}》到 Gateway。`)
  console.log(`bookId: ${result.book?.id ?? normalizedBookId}`)
  console.log(`chapters: ${chapterCount}`)
  console.log(`updatedAt: ${result.book?.updatedAt ?? 'unknown'}`)
}

async function loadBookPackage({ bookId, sourceApi, sourceFile, sourceToken, timeoutMs }) {
  if (sourceFile) {
    const rawPackage = await readFile(sourceFile, 'utf8')
    return parseJson(rawPackage, `文件 ${sourceFile}`)
  }

  const response = await fetch(`${sourceApi}/api/mobile/books/${encodeURIComponent(bookId)}/package`, {
    headers: sourceToken ? { authorization: `Bearer ${sourceToken}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`本地 API 返回 ${response.status}：${await readResponseText(response)}`)
  }

  return response.json()
}

function parseArgs(argv) {
  const options = {
    bookId: '',
    sourceApi: '',
    sourceFile: '',
    sourceToken: '',
    gatewayUrl: '',
    gatewayToken: '',
    deviceName: '',
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--book-id') {
      options.bookId = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-api') {
      options.sourceApi = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-file') {
      options.sourceFile = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-token') {
      options.sourceToken = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-url') {
      options.gatewayUrl = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-token') {
      options.gatewayToken = readArgValue(argv, ++index, arg)
    } else if (arg === '--device-name') {
      options.deviceName = readArgValue(argv, ++index, arg)
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

function readArgValue(argv, index, name) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} 不是合法 JSON`)
  }
}

function normalizePackageBookId(bookPackage, requestedBookId) {
  const packageBook = bookPackage?.book
  const rawId = packageBook?.id
  const normalized = typeof rawId === 'number' && Number.isInteger(rawId) ? String(rawId) : String(rawId || '').trim()
  if (!normalized) throw new Error('package.book.id 不能为空')
  if (normalized !== requestedBookId) {
    throw new Error(`package.book.id (${normalized}) 与 --book-id (${requestedBookId}) 不一致`)
  }
  packageBook.id = normalized
  return normalized
}

function assertMobileBookPackage(bookPackage, bookId) {
  if (!bookPackage || typeof bookPackage !== 'object' || Array.isArray(bookPackage)) {
    throw new Error('移动端数据包必须是 JSON object')
  }
  if (bookPackage.schemaVersion !== 1) {
    throw new Error('移动端数据包 schemaVersion 必须是 1')
  }
  if (!bookPackage.book || typeof bookPackage.book !== 'object' || Array.isArray(bookPackage.book)) {
    throw new Error('移动端数据包缺少 book 对象')
  }
  if (String(bookPackage.book.id) !== bookId) {
    throw new Error('移动端数据包 book.id 校验失败')
  }
  if (!getBookTitle(bookPackage)) {
    throw new Error('移动端数据包缺少 book.title')
  }
}

function getBookTitle(bookPackage) {
  return typeof bookPackage.book?.title === 'string' && bookPackage.book.title.trim()
    ? bookPackage.book.title.trim()
    : basename(String(bookPackage.book?.id ?? 'unknown'))
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
  node gateway/scripts/publish-package.mjs --book-id <id> --gateway-url <url> --gateway-token <token>

常用参数：
  --book-id <id>          要发布的书籍 ID，必须与 package.book.id 一致
  --source-api <url>      PC 本地 API 地址，默认 ${defaultSourceApi}
  --source-file <path>    从已有 package JSON 文件读取，跳过本地 API
  --source-token <token>  访问 PC 本地 API 的 bearer token，可用 NOVEL_READER_SYNC_TOKEN
  --gateway-url <url>     Gateway 公网或内网地址，可用 GATEWAY_BASE_URL
  --gateway-token <token> Gateway bearer token，可用 GATEWAY_DEV_ACCESS_TOKEN
  --device-name <name>    登记到 Gateway 的发布设备名，默认 ${defaultDeviceName}
  --dry-run               只读取和校验，不上传
  --timeout-ms <ms>       请求超时时间，默认 ${defaultTimeoutMs}
`)
}
