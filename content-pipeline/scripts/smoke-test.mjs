#!/usr/bin/env node

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const workRoot = resolve(repoRoot, 'tmp/content-pipeline-smoke-auto')
const mainDbPath = join(workRoot, 'main.sqlite')
const offlineDbPath = join(workRoot, 'offline.sqlite')
const pipelineBin = join(repoRoot, 'content-pipeline/scripts/content-pipeline.mjs')

await main().catch((error) => {
  console.error(`content pipeline smoke 失败：${error.message}`)
  process.exitCode = 1
})

async function main() {
  await rm(workRoot, { recursive: true, force: true })
  await mkdir(workRoot, { recursive: true })

  const txtFile = join(workRoot, 'sample.txt')
  const pdfFile = join(workRoot, 'sample.pdf')
  const epubFile = join(workRoot, 'sample.epub')
  await writeFile(txtFile, '第一章 开始\n这是第一章正文。\n\n第二章 继续\n这是第二章正文。\n', 'utf8')
  await writeFile(pdfFile, '%PDF-1.4 smoke', 'utf8')
  await createMinimalEpub(epubFile)

  const txtManifest = await ingest(txtFile)
  const epubManifest = await ingest(epubFile)
  await expectFailure([
    pipelineBin,
    'ingest',
    '--file',
    pdfFile,
    '--main-db',
    mainDbPath,
    '--work-root',
    join(workRoot, 'work'),
  ])

  await runPipeline(txtManifest, ['import'])
  await runPipeline(txtManifest, ['scan'], ['--dry-run', '--scan-type', 'summary'])
  await runPipeline(txtManifest, ['embedding'], ['--dry-run', '--limit', '1'])
  await runPipeline(epubManifest, ['import'])

  assertManifestStage(txtManifest, 'ingest', 'completed')
  assertManifestStage(txtManifest, 'offlineImport', 'completed')
  assertManifestStage(txtManifest, 'scan', 'skipped')
  assertManifestStage(txtManifest, 'embedding', 'skipped')
  assertManifestStage(epubManifest, 'ingest', 'completed')
  assertManifestStage(epubManifest, 'offlineImport', 'completed')

  const db = new DatabaseSync(mainDbPath, { readOnly: true })
  try {
    const bookCount = db.prepare('SELECT COUNT(*) AS count FROM books').get().count
    const chapterCount = db.prepare('SELECT COUNT(*) AS count FROM chapters').get().count
    if (bookCount !== 2) throw new Error(`主库书籍数量不正确：${bookCount}`)
    if (chapterCount !== 4) throw new Error(`主库章节数量不正确：${chapterCount}`)
  } finally {
    db.close()
  }

  console.log('content pipeline smoke 通过。')
  console.log(`临时目录：${workRoot}`)
}

async function ingest(filePath) {
  const output = await run([
    pipelineBin,
    'ingest',
    '--file',
    filePath,
    '--main-db',
    mainDbPath,
    '--work-root',
    join(workRoot, 'work'),
  ])
  const manifestLine = output.split(/\r?\n/).find((line) => line.startsWith('manifest：'))
  if (!manifestLine) throw new Error(`ingest 输出缺少 manifest 路径：${filePath}`)
  return manifestLine.replace('manifest：', '').trim()
}

async function runPipeline(manifestPath, steps, extraArgs = []) {
  await run([
    pipelineBin,
    'run',
    '--manifest',
    manifestPath,
    '--steps',
    steps.join(','),
    ...extraArgs,
  ], {
    NOVEL_READER_MAIN_DB: mainDbPath,
    NOVEL_READER_OFFLINE_DB: offlineDbPath,
  })
}

function assertManifestStage(manifestPath, stageName, expected) {
  const db = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const actual = db.stages?.[stageName]?.status
  if (actual !== expected) {
    throw new Error(`${manifestPath} ${stageName} 期望 ${expected}，实际 ${actual}`)
  }
}

async function expectFailure(args) {
  const result = await spawnCommand(process.execPath, args, { env: process.env })
  if (result.code === 0) throw new Error(`命令应失败但成功：${args.join(' ')}`)
}

async function run(args, extraEnv = {}) {
  const result = await spawnCommand(process.execPath, args, {
    env: { ...process.env, ...extraEnv },
  })
  if (result.code !== 0) {
    throw new Error(`命令失败：${args.join(' ')}\n${result.output}`)
  }
  return result.output
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code, output }))
  })
}

async function createMinimalEpub(targetPath) {
  const sourceRoot = join(workRoot, 'epub-src')
  await mkdir(join(sourceRoot, 'META-INF'), { recursive: true })
  await mkdir(join(sourceRoot, 'OEBPS/text'), { recursive: true })
  await writeFile(join(sourceRoot, 'mimetype'), 'application/epub+zip', 'utf8')
  await writeFile(
    join(sourceRoot, 'META-INF/container.xml'),
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'utf8',
  )
  await writeFile(
    join(sourceRoot, 'OEBPS/content.opf'),
    '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Smoke EPUB</dc:title></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    'utf8',
  )
  await writeFile(join(sourceRoot, 'OEBPS/text/ch1.xhtml'), '<html><body><h1>第一章 EPUB</h1><p>这是 EPUB 第一章。</p></body></html>', 'utf8')
  await writeFile(join(sourceRoot, 'OEBPS/text/ch2.xhtml'), '<html><body><h1>第二章 EPUB</h1><p>这是 EPUB 第二章。</p></body></html>', 'utf8')

  await runShell('zip', ['-X0', targetPath, 'mimetype'], sourceRoot)
  await runShell('zip', ['-Xr9D', targetPath, 'META-INF', 'OEBPS'], sourceRoot)
}

async function runShell(command, args, cwd) {
  const result = await spawnCommand(command, args, { env: process.env, cwd })
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} 失败`)
}
