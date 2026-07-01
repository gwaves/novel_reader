#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2))

if (!options.gatewayUrl || !options.adminToken || !options.mobileToken || !options.bookId) {
  fail(
    'Usage: npm run gateway:ops-metrics-smoke -- --gateway-url <url> --admin-token <token> --mobile-token <token> --book-id <bookId> [--device-id <id>] [--device-name <name>] [--audio-chapter-id <chapterId>] [--error-url <path>]',
  )
}

const gatewayUrl = options.gatewayUrl.replace(/\/+$/, '')
const adminHeaders = { Authorization: `Bearer ${options.adminToken}` }
const mobileHeaders = {
  Authorization: `Bearer ${options.mobileToken}`,
  ...(options.deviceId ? { 'X-Device-Id': options.deviceId } : {}),
  ...(options.deviceName ? { 'X-Device-Name': options.deviceName } : {}),
}
const bookId = options.bookId
const packagePath = `/mobile/books/${encodeURIComponent(bookId)}/package/download`
const audioPath = options.audioChapterId
  ? `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(options.audioChapterId)}/download`
  : null
const missingPath = `/ops-metrics-smoke-missing-${Date.now()}`
const errorPath = options.errorUrl || null

const checks = []

await request('/admin/books', { headers: { Authorization: 'Bearer intentionally-invalid-token' } })
await request(missingPath)
await request(packagePath, { headers: mobileHeaders })
if (audioPath) await request(audioPath, { headers: mobileHeaders })
if (errorPath) await request(errorPath, { headers: mobileHeaders })

const metrics = await jsonRequest('/admin/metrics', { headers: adminHeaders })
const events = await jsonRequest('/admin/events', { headers: adminHeaders })
const requests = await jsonRequest('/admin/requests', { headers: adminHeaders })

check(metrics?.requests?.last24Hours >= 3, 'metrics.requests.last24Hours includes smoke requests')
check(metrics?.requests?.errorRate > 0, 'metrics.requests.errorRate is above 0 after 401/404')
check(metrics?.downloads?.packageLast24Hours >= 1, 'metrics.downloads.packageLast24Hours increased')
check(
  Array.isArray(metrics?.downloads?.topBooks) &&
    metrics.downloads.topBooks.some((book) => book.bookId === bookId && book.packageDownloads >= 1),
  'metrics.downloads.topBooks includes the package download bookId',
)
check(
  Array.isArray(metrics?.trends?.requests) &&
    metrics.trends.requests.at(-1)?.errorCount >= 1,
  'metrics.trends.requests latest bucket includes errors',
)
check(
  Array.isArray(metrics?.trends?.downloads) &&
    metrics.trends.downloads.at(-1)?.packageDownloads >= 1,
  'metrics.trends.downloads latest bucket includes package download',
)

const eventItems = Array.isArray(events?.events) ? events.events : []
check(
  eventItems.some((event) => event.statusCode === 401 && event.url === '/admin/books'),
  'events identify 401 route /admin/books',
)
check(
  eventItems.some((event) => event.statusCode === 404 && event.url === missingPath),
  `events identify 404 route ${missingPath}`,
)
check(
  eventItems.some((event) => event.statusCode === 200 && event.bookId === bookId && event.text.includes('数据包')),
  'events identify package download bookId',
)
if (audioPath) {
  check(
    eventItems.some((event) => event.statusCode === 200 && event.bookId === bookId && event.text.includes('章节音频')),
    'events identify audio download bookId',
  )
}
if (errorPath) {
  check(
    eventItems.some((event) => event.statusCode >= 500 && event.url === errorPath),
    `events identify 5xx route ${errorPath}`,
  )
}

const requestItems = Array.isArray(requests?.requests) ? requests.requests : []
check(
  requestItems.some((request) => request.statusCode === 401 && request.url === '/admin/books'),
  'requests identify 401 route /admin/books',
)
check(
  requestItems.some((request) => request.statusCode === 404 && request.url === missingPath),
  `requests identify 404 route ${missingPath}`,
)
check(
  requestItems.some(
    (request) =>
      request.statusCode === 200 &&
      request.url === packagePath &&
      request.bookId === bookId &&
      request.downloadKind === 'package',
  ),
  'requests identify package download kind and bookId',
)
if (audioPath) {
  check(
    requestItems.some(
      (request) =>
        request.statusCode === 200 &&
        request.url === audioPath &&
        request.bookId === bookId &&
        request.downloadKind === 'audio',
    ),
    'requests identify audio download kind and bookId',
  )
}

const failed = checks.filter((item) => !item.ok)
if (failed.length > 0) {
  for (const item of failed) console.error(`FAIL: ${item.label}`)
  process.exit(1)
}

for (const item of checks) console.log(`OK: ${item.label}`)
console.log(`Gateway ops metrics smoke passed for ${gatewayUrl}`)

async function request(path, init = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    redirect: 'manual',
    ...init,
  })
  await response.arrayBuffer()
  return response
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    redirect: 'manual',
    ...init,
  })
  if (!response.ok) {
    fail(`${path} returned ${response.status}`)
  }
  return response.json()
}

function check(ok, label) {
  checks.push({ ok: Boolean(ok), label })
}

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    parsed[key] = args[index + 1]
    index += 1
  }
  return parsed
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
