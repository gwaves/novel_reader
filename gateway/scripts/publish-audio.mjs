#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const defaultSourceApi = process.env.NOVEL_READER_API_BASE_URL || 'http://127.0.0.1:5174'
const defaultAudioDir = process.env.GATEWAY_AUDIO_DIR || join(process.cwd(), 'gateway', 'data', 'audio')
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
  const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : ''
  const gatewayAudioDir = resolve(options.gatewayAudioDir || defaultAudioDir)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeoutMs

  if (!bookId) throw new Error('缺少 --book-id')
  if (!sourceRoot) throw new Error('缺少 --source-root')

  const bookPackage = await loadBookPackage({
    bookId,
    packageFile: options.packageFile,
    sourceApi: trimTrailingSlash(options.sourceApi || defaultSourceApi),
    sourceToken: options.sourceToken || process.env.NOVEL_READER_SYNC_TOKEN || '',
    timeoutMs,
  })
  const chapterMap = buildChapterMap(bookPackage)
  const artifacts = await collectAudioArtifacts(sourceRoot)
  if (artifacts.length === 0) {
    throw new Error(`没有在 ${sourceRoot} 下找到 audio/chapter.mp3`)
  }

  const bookAudioDir = join(gatewayAudioDir, 'books', bookId)
  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    chapters: [],
  }
  const copiedFiles = []

  for (const artifact of artifacts) {
    const chapter = chapterMap.get(artifact.chapterNumber)
    if (!chapter) {
      if (options.strict) throw new Error(`package 中找不到第 ${artifact.chapterNumber} 章`)
      console.warn(`跳过第 ${artifact.chapterNumber} 章：package 中没有对应章节。`)
      continue
    }

    const chapterId = normalizeId(chapter.id)
    const targetSegment = `ch${String(artifact.chapterNumber).padStart(3, '0')}-${safePathSegment(chapterId)}`
    const targetDir = join(bookAudioDir, targetSegment)
    const targetMp3 = join(targetDir, 'chapter.mp3')
    const targetManifest = artifact.manifestPath ? join(targetDir, 'manifest.json') : ''
    const mp3Stat = await stat(artifact.mp3Path)
    const manifest = artifact.manifestPath ? await readManifest(artifact.manifestPath) : null
    const durationMs = readDurationMs(manifest)

    catalog.chapters.push({
      chapterId,
      title: chapter.title || `第 ${artifact.chapterNumber} 章`,
      fileName: relative(bookAudioDir, targetMp3),
      ...(targetManifest
        ? {
            manifestFileName: relative(bookAudioDir, targetManifest),
            timelineVersion: readTimelineVersion(manifest),
          }
        : {}),
      ...(durationMs == null ? {} : { durationMs }),
      sizeBytes: mp3Stat.size,
      updatedAt: mp3Stat.mtime.toISOString(),
    })

    if (!options.dryRun) {
      await mkdir(targetDir, { recursive: true })
      await copyFile(artifact.mp3Path, targetMp3)
      copiedFiles.push(targetMp3)
      if (artifact.manifestPath && targetManifest) {
        await copyFile(artifact.manifestPath, targetManifest)
        copiedFiles.push(targetManifest)
      }
    }
  }

  catalog.chapters.sort((left, right) => {
    const leftIndex = chapterMap.getReverseIndex(left.chapterId)
    const rightIndex = chapterMap.getReverseIndex(right.chapterId)
    return leftIndex - rightIndex || left.title.localeCompare(right.title)
  })

  if (catalog.chapters.length === 0) {
    throw new Error('没有可发布的章节音频')
  }

  if (options.dryRun) {
    console.log(`DRY RUN：将发布 ${catalog.chapters.length} 章音频到 ${bookAudioDir}`)
    for (const chapter of catalog.chapters) {
      console.log(`- ${chapter.chapterId} ${chapter.title} -> ${chapter.fileName}`)
    }
    return
  }

  await mkdir(bookAudioDir, { recursive: true })
  await writeFile(join(bookAudioDir, 'audio.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

  console.log(`已发布 ${catalog.chapters.length} 章音频到 Gateway 目录。`)
  console.log(`audio.json: ${join(bookAudioDir, 'audio.json')}`)
  console.log(`files: ${copiedFiles.length}`)
}

async function loadBookPackage({ bookId, packageFile, sourceApi, sourceToken, timeoutMs }) {
  if (packageFile) {
    return JSON.parse(await readFile(packageFile, 'utf8'))
  }

  const response = await fetch(`${sourceApi}/api/mobile/books/${encodeURIComponent(bookId)}/package`, {
    headers: sourceToken ? { authorization: `Bearer ${sourceToken}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`本地 API 返回 ${response.status}：${await response.text()}`)
  }
  return response.json()
}

function buildChapterMap(bookPackage) {
  if (!bookPackage || bookPackage.schemaVersion !== 1 || !Array.isArray(bookPackage.chapters)) {
    throw new Error('移动端数据包缺少 chapters')
  }

  const byIndex = new Map()
  const reverseIndex = new Map()
  bookPackage.chapters.forEach((chapter, position) => {
    const index = Number(chapter.index ?? chapter.chapterIndex ?? position + 1)
    if (!Number.isInteger(index) || index <= 0 || !chapter.id) return
    const normalized = {
      id: normalizeId(chapter.id),
      title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `第 ${index} 章`,
    }
    byIndex.set(index, normalized)
    reverseIndex.set(normalized.id, index)
  })
  byIndex.getReverseIndex = (chapterId) => reverseIndex.get(chapterId) ?? Number.MAX_SAFE_INTEGER
  return byIndex
}

async function collectAudioArtifacts(root) {
  const artifacts = []
  await walk(root, 5, async (filePath) => {
    if (!filePath.endsWith('/audio/chapter.mp3')) return
    const chapterNumber = inferChapterNumber(filePath)
    if (!chapterNumber) {
      console.warn(`跳过无法识别章节号的音频：${filePath}`)
      return
    }
    const manifestPath = join(dirname(filePath), 'manifest.json')
    artifacts.push({
      chapterNumber,
      mp3Path: filePath,
      manifestPath: await exists(manifestPath) ? manifestPath : '',
    })
  })
  artifacts.sort((left, right) => left.chapterNumber - right.chapterNumber)
  return artifacts
}

async function walk(dir, depth, onFile) {
  if (depth < 0) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'segments' || entry.name === 'work') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, depth - 1, onFile)
    } else if (entry.isFile()) {
      await onFile(fullPath)
    }
  }
}

function inferChapterNumber(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const match =
    normalized.match(/(?:^|\/)ch(?:apter)?[-_ ]?0*(\d+)[^/]*(?:\/audio\/chapter\.mp3)$/i) ||
    normalized.match(/(?:^|\/)(?:第)?0*(\d+)(?:章|[-_ ]?chapter)[^/]*(?:\/audio\/chapter\.mp3)$/i)
  if (!match) return null
  const number = Number(match[1])
  return Number.isInteger(number) && number > 0 ? number : null
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error(`${manifestPath} 不是合法 manifest JSON`)
  }
}

function readDurationMs(manifest) {
  const duration = Number(manifest?.duration)
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 1000) : null
}

function readTimelineVersion(manifest) {
  const version = Number(manifest?.timelineVersion)
  return Number.isInteger(version) && version >= 0 ? version : undefined
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const options = {
    bookId: '',
    sourceRoot: '',
    gatewayAudioDir: '',
    packageFile: '',
    sourceApi: '',
    sourceToken: '',
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
    strict: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--strict') {
      options.strict = true
    } else if (arg === '--book-id') {
      options.bookId = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-root') {
      options.sourceRoot = readArgValue(argv, ++index, arg)
    } else if (arg === '--gateway-audio-dir') {
      options.gatewayAudioDir = readArgValue(argv, ++index, arg)
    } else if (arg === '--package-file') {
      options.packageFile = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-api') {
      options.sourceApi = readArgValue(argv, ++index, arg)
    } else if (arg === '--source-token') {
      options.sourceToken = readArgValue(argv, ++index, arg)
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

function normalizeId(value) {
  return String(value).trim()
}

function safePathSegment(value) {
  return normalizeId(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'chapter'
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function printUsage() {
  console.log(`用法：
  node gateway/scripts/publish-audio.mjs --book-id <id> --source-root <offline-tts-output> --gateway-audio-dir <dir>

常用参数：
  --book-id <id>             书籍 ID
  --source-root <path>       offline-tts 输出父目录，例如 tmp/tts/yaodao
  --gateway-audio-dir <path> Gateway 音频根目录，默认 GATEWAY_AUDIO_DIR 或 ${defaultAudioDir}
  --package-file <path>      从 package JSON 文件读取章节映射，跳过本地 API
  --source-api <url>         PC 本地 API 地址，默认 ${defaultSourceApi}
  --source-token <token>     访问 PC 本地 API 的 bearer token，可用 NOVEL_READER_SYNC_TOKEN
  --dry-run                  只扫描和校验，不复制文件
  --strict                   source-root 中出现 package 无法匹配的章节时直接失败
  --timeout-ms <ms>          请求超时时间，默认 ${defaultTimeoutMs}
`)
}
