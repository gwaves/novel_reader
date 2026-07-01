#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2))
const checks = []

if (!options.gatewayUrl) {
  fail(
    'Usage: npm run gateway:apk-metadata-smoke -- --gateway-url <url> [--version-name <version>] [--version-code <code>] [--build-number <number>] [--git-commit <sha>]',
  )
}

const gatewayUrl = options.gatewayUrl.replace(/\/+$/, '')
const manifest = await jsonRequest('/downloads/android-app.json')

check(manifest?.schemaVersion === 1, 'android-app.json schemaVersion is 1')
check(typeof manifest?.versionName === 'string' && manifest.versionName.length > 0, 'android-app.json has versionName')
check(Number.isInteger(manifest?.versionCode) && manifest.versionCode > 0, 'android-app.json has positive versionCode')
check(Number.isInteger(manifest?.buildNumber) && manifest.buildNumber >= 0, 'android-app.json has buildNumber')
check(typeof manifest?.gitCommit === 'string' && manifest.gitCommit.length >= 7, 'android-app.json has gitCommit')
check(manifest?.latestFileName === 'ai_novel_reader.apk', 'latestFileName is fixed')
check(manifest?.latestUrl === '/downloads/ai_novel_reader.apk', 'latestUrl points to fixed APK')
check(
  typeof manifest?.versionedFileName === 'string' &&
    manifest.versionedFileName.length > 0 &&
    manifest?.versionedUrl === `/downloads/${manifest.versionedFileName}`,
  'versionedUrl matches versionedFileName',
)

if (options.versionName) check(manifest.versionName === options.versionName, `versionName matches ${options.versionName}`)
if (options.versionCode) check(String(manifest.versionCode) === String(options.versionCode), `versionCode matches ${options.versionCode}`)
if (options.buildNumber) check(String(manifest.buildNumber) === String(options.buildNumber), `buildNumber matches ${options.buildNumber}`)
if (options.gitCommit) check(String(manifest.gitCommit).startsWith(options.gitCommit), `gitCommit starts with ${options.gitCommit}`)

const latest = await headRequest(manifest.latestUrl)
const versioned = await headRequest(manifest.versionedUrl)
check(latest.status === 200, 'latest APK returns 200')
check(versioned.status === 200, 'versioned APK returns 200')
check(
  latest.contentType.includes('application/vnd.android.package-archive'),
  'latest APK content-type is Android package',
)
check(
  versioned.contentType.includes('application/vnd.android.package-archive'),
  'versioned APK content-type is Android package',
)
check(latest.contentLength > 0, 'latest APK has content-length')
check(versioned.contentLength > 0, 'versioned APK has content-length')
check(latest.contentLength === versioned.contentLength, 'latest and versioned APK sizes match')

const failed = checks.filter((item) => !item.ok)
if (failed.length > 0) {
  for (const item of failed) console.error(`FAIL: ${item.label}`)
  process.exit(1)
}

for (const item of checks) console.log(`OK: ${item.label}`)
console.log(`Gateway APK metadata smoke passed for ${gatewayUrl}`)

async function jsonRequest(path) {
  const response = await fetch(`${gatewayUrl}${path}`)
  if (!response.ok) fail(`${path} returned ${response.status}`)
  return response.json()
}

async function headRequest(path) {
  const response = await fetch(`${gatewayUrl}${path}`, { method: 'HEAD' })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    contentLength: Number(response.headers.get('content-length') || 0),
  }
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
