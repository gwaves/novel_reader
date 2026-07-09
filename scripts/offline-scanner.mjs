#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { validateModel } from './offline-scanner/llm.mjs'
import { getConfig } from './offline-scanner/config.mjs'
import {
  importBookFromMain,
  exportResultsToMain,
  createBookDataPackage,
  listJobs,
  getSourceBook,
  getSourceChaptersByBook,
  getOfflineSummary,
  getOfflineExtraction,
  updateJob,
  listMainBooks,
  offlineDbPath,
  mainDbPath,
} from './offline-scanner/db.mjs'
import {
  createScanJob,
  getOrCreateJob,
  resumeJob,
  scanSummary,
  scanKg,
  stopScan,
  resetStop,
} from './offline-scanner/scanner.mjs'
import {
  loadConfig,
  syncConfigFromMain,
  printConfig,
  configPath,
} from './offline-scanner/config.mjs'

const COMMANDS = [
  'import', 'list', 'scan', 'resume', 'status', 'export', 'bundle', 'help', 'config', 'sync', 'stop'
]

function toSafeFilename(value) {
  return String(value || 'book')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'book'
}

function printHelp() {
  console.log(`
📚 Novel Reader Offline Scanner
   独立 CLI 扫描工具，支持断点续传，将结果存入独立 SQLite 数据库。

用法:
  node scripts/offline-scanner.mjs <command> [args...]

命令:
  list                     列出主数据库中的所有书籍
  import <bookId>          从主数据库导入书籍到离线数据库
  scan <type> <bookId>     创建扫描任务并执行
                           type: summary | kg | all
  resume <type> <bookId>   恢复中断的扫描任务
                           type: summary | kg | all
  status [bookId]          查看所有任务或指定书籍的状态
  export <bookId>          将离线扫描结果导入主数据库
  bundle <bookId> [path]   导出某本书的离线扫描数据包，供网页导入
  sync                     同步主项目模型配置到离线配置文件
  config                   显示当前模型配置
  stop                     发送停止信号（需要另一个终端执行）
  help                     显示此帮助

环境变量（仅在需要时覆盖配置文件）:
  NOVEL_READER_OFFLINE_DB    离线数据库路径（默认 ~/.novel_reader/offline.sqlite）
  NOVEL_READER_MAIN_DB       主数据库路径（默认 ~/.novel_reader/novel_reader.sqlite）
  NOVEL_READER_OFFLINE_CONFIG 配置文件路径（默认 ~/.novel_reader/offline-config.json）

  OFFLINE_AI_PROVIDER        覆盖提供商: ollama | openai
  OFFLINE_OLLAMA_MODEL       覆盖 Ollama 模型
  OFFLINE_OLLAMA_CONCURRENCY 覆盖 Ollama 并发度
  OFFLINE_OLLAMA_BASE_URL    覆盖 Ollama Base URL
  OFFLINE_OPENAI_MODEL       覆盖 OpenAI 模型
  OFFLINE_OPENAI_CONCURRENCY 覆盖 OpenAI 并发度
  OFFLINE_OPENAI_BASE_URL    覆盖 OpenAI Base URL
  OFFLINE_OPENAI_API_KEY     覆盖 OpenAI API Key
  OFFLINE_REQUEST_TIMEOUT_MS 覆盖单次请求超时（默认 300000ms）

配置文件:
  默认路径: ~/.novel_reader/offline-config.json
  首次运行 scan/resume 时自动从主项目同步生成。
  使用 'sync' 命令手动重新同步。

示例:
  # 1. 导入书籍
  node scripts/offline-scanner.mjs import file-365a976c422e99bb943cea65

  # 2. 同步主项目配置（如更换了前端模型）
  node scripts/offline-scanner.mjs sync

  # 3. 扫描概要
  node scripts/offline-scanner.mjs scan summary <bookId>

  # 4. 扫描知识图谱
  node scripts/offline-scanner.mjs scan kg <bookId>

  # 5. 扫描两者
  node scripts/offline-scanner.mjs scan all <bookId>

  # 6. 断点续传
  node scripts/offline-scanner.mjs resume all <bookId>

  # 7. 另一个终端停止
  node scripts/offline-scanner.mjs stop

  # 8. 查看进度
  node scripts/offline-scanner.mjs status <bookId>

  # 9. 导出到主数据库
  node scripts/offline-scanner.mjs export <bookId>

  # 10. 导出为网页可导入的数据包
  node scripts/offline-scanner.mjs bundle <bookId>
`)
}

async function runList() {
  const books = listMainBooks()
  if (!books.length) {
    console.log('📭 主数据库中没有书籍。')
    return
  }
  console.log(`📚 主数据库书籍列表 (${books.length} 本):`)
  console.log('')
  for (const book of books) {
    const date = new Date(book.imported_at).toLocaleDateString('zh-CN')
    console.log(`  ${book.id} | ${book.title} | ${book.chapter_count} 章 | 导入于 ${date}`)
  }
  console.log('')
  console.log('💡 用法: node scripts/offline-scanner.mjs import <bookId>')
}

async function runImport(bookId) {
  console.log(`📥 从主数据库导入书籍 ${bookId}...`)
  console.log(`   主数据库: ${mainDbPath}`)
  const result = importBookFromMain(mainDbPath, bookId)
  console.log(`   ✅ 导入完成：`)
  console.log(`      书名: ${result.book.title}`)
  console.log(`      章节数: ${result.chapterCount}`)
  console.log(`      已有 Summary: ${result.summaryCount}`)
  console.log(`      已有 KG 提取: ${result.extractionCount}`)
}

async function runExport(bookId) {
  console.log(`📤 导出扫描结果到主数据库...`)
  console.log(`   主数据库: ${mainDbPath}`)
  const result = exportResultsToMain(mainDbPath, bookId)
  console.log(`   ✅ 导出完成：`)
  console.log(`      Summary: ${result.summaryCount}`)
  console.log(`      KG 提取: ${result.extractionCount}`)
  console.log(`      KG 实体: ${result.entityCount}`)
  console.log(`      KG 关系: ${result.relationCount}`)
}

async function runBundle(bookId, outputPath) {
  console.log(`📦 生成离线扫描数据包...`)
  const dataPackage = createBookDataPackage(bookId)
  const filename = outputPath || `novel-reader-${toSafeFilename(dataPackage.book.title)}-${bookId}-offline-data.json`

  writeFileSync(filename, `${JSON.stringify(dataPackage, null, 2)}\n`, 'utf8')

  console.log(`   ✅ 数据包已生成：${filename}`)
  console.log(`      书名: ${dataPackage.book.title}`)
  console.log(`      章节: ${dataPackage.counts.chapters}`)
  console.log(`      Summary: ${dataPackage.counts.summaries}`)
  console.log(`      KG 提取: ${dataPackage.counts.kgChapterExtractions}`)
  console.log(`      KG 实体: ${dataPackage.counts.kgEntities}`)
  console.log(`      KG 关系: ${dataPackage.counts.kgRelations}`)
}

async function runStatus(bookId) {
  if (bookId) {
    const book = getSourceBook(bookId)
    if (!book) {
      console.log(`❌ 书籍 ${bookId} 未在离线数据库中找到。请先运行 import。`)
      return
    }
    const chapters = getSourceChaptersByBook(bookId)
    const summaryCount = chapters.filter(c => getOfflineSummary(c.id)).length
    const extractionCount = chapters.filter(c => {
      const e = getOfflineExtraction(c.id)
      return e && e.status === 'completed'
    }).length

    console.log(`📖 ${book.title} (${bookId})`)
    console.log(`   总章节: ${chapters.length}`)
    console.log(`   Summary: ${summaryCount}/${chapters.length} (${Math.round(summaryCount / chapters.length * 100)}%)`)
    console.log(`   KG 提取: ${extractionCount}/${chapters.length} (${Math.round(extractionCount / chapters.length * 100)}%)`)
  }

  const jobs = listJobs()
  if (!jobs.length) {
    console.log('📭 没有扫描任务。')
    return
  }
  console.log('📋 扫描任务列表：')
  for (const job of jobs) {
    const pct = job.total_chapters > 0
      ? Math.round((job.completed_chapters / job.total_chapters) * 100)
      : 0
    console.log(`  ${job.id} | ${job.scan_type} | ${job.status} | ${job.completed_chapters}/${job.total_chapters} (${pct}%) | book: ${job.book_id}`)
  }
}

async function runScan(scanType, bookId) {
  if (!['summary', 'kg', 'all'].includes(scanType)) {
    console.error(`❌ 无效扫描类型: ${scanType}。可选: summary, kg, all`)
    process.exit(1)
  }

  const book = getSourceBook(bookId)
  if (!book) {
    console.error(`❌ 书籍 ${bookId} 未在离线数据库中找到。请先运行: node scripts/offline-scanner.mjs import ${bookId}`)
    process.exit(1)
  }

  // 加载配置（如果不存在则自动生成，不会覆盖已有配置）
  console.log('⚙️  加载模型配置...')
  loadConfig()

  console.log(`🚀 开始 ${scanType} 扫描: ${book.title} (${bookId})`)

  // 验证模型
  console.log('🔍 验证模型连接...')
  try {
    await validateModel()
    console.log('   ✅ 模型连接正常')
  } catch (error) {
    console.error(`   ❌ 模型验证失败: ${error.message}`)
    process.exit(1)
  }

  resetStop()

  const config = getConfig()

  if (scanType === 'all') {
    const summaryJobId = createScanJob(bookId, 'summary')
    const summaryResult = await scanSummary(bookId, summaryJobId)
    const summaryStatus = summaryResult.wasCancelled ? 'cancelled' : (summaryResult.failed > 0 ? 'failed' : 'completed')
    updateJob(summaryJobId, summaryStatus, summaryResult.completed, summaryResult.failed, null)
    console.log(`   ✅ Summary 扫描完成: ${summaryResult.completed} 成功, ${summaryResult.failed} 失败`)

    const kgJobId = createScanJob(bookId, 'kg')
    const kgResult = await scanKg(bookId, kgJobId)
    const kgStatus = kgResult.wasCancelled ? 'cancelled' : (kgResult.failed > 0 ? 'failed' : 'completed')
    updateJob(kgJobId, kgStatus, kgResult.completed, kgResult.failed, null)
    console.log(`   ✅ KG 扫描完成: ${kgResult.completed} 成功, ${kgResult.failed} 失败`)
  } else if (scanType === 'summary') {
    const jobId = createScanJob(bookId, 'summary')
    const result = await scanSummary(bookId, jobId)
    const status = result.wasCancelled ? 'cancelled' : (result.failed > 0 ? 'failed' : 'completed')
    updateJob(jobId, status, result.completed, result.failed, null)
    console.log(`   ✅ 扫描完成: ${result.completed} 成功, ${result.failed} 失败`)
  } else {
    const jobId = createScanJob(bookId, 'kg')
    const result = await scanKg(bookId, jobId)
    const status = result.wasCancelled ? 'cancelled' : (result.failed > 0 ? 'failed' : 'completed')
    updateJob(jobId, status, result.completed, result.failed, null)
    console.log(`   ✅ 扫描完成: ${result.completed} 成功, ${result.failed} 失败`)
  }

  console.log('')
  console.log('💡 提示: 运行以下命令将结果导入主数据库:')
  console.log(`   node scripts/offline-scanner.mjs export ${bookId}`)
}

async function runResume(scanType, bookId) {
  if (!['summary', 'kg', 'all'].includes(scanType)) {
    console.error(`❌ 无效扫描类型: ${scanType}。可选: summary, kg, all`)
    process.exit(1)
  }

  const book = getSourceBook(bookId)
  if (!book) {
    console.error(`❌ 书籍 ${bookId} 未在离线数据库中找到。请先运行 import。`)
    process.exit(1)
  }

  // 加载配置（如果不存在则自动生成，不会覆盖已有配置）
  console.log('⚙️  加载模型配置...')
  loadConfig()

  console.log(`🔄 恢复 ${scanType} 扫描: ${book.title} (${bookId})`)

  resetStop()

  const config = getConfig()

  if (scanType === 'all') {
    const summaryJobId = resumeJob(bookId, 'summary')
    const summaryResult = await scanSummary(bookId, summaryJobId)
    const summaryStatus = summaryResult.wasCancelled ? 'cancelled' : (summaryResult.failed > 0 ? 'failed' : 'completed')
    updateJob(summaryJobId, summaryStatus, summaryResult.completed, summaryResult.failed, null)
    console.log(`   ✅ Summary 恢复完成: ${summaryResult.completed} 成功, ${summaryResult.failed} 失败`)

    const kgJobId = resumeJob(bookId, 'kg')
    const kgResult = await scanKg(bookId, kgJobId)
    const kgStatus = kgResult.wasCancelled ? 'cancelled' : (kgResult.failed > 0 ? 'failed' : 'completed')
    updateJob(kgJobId, kgStatus, kgResult.completed, kgResult.failed, null)
    console.log(`   ✅ KG 恢复完成: ${kgResult.completed} 成功, ${kgResult.failed} 失败`)
  } else if (scanType === 'summary') {
    const jobId = resumeJob(bookId, 'summary')
    const result = await scanSummary(bookId, jobId)
    const status = result.wasCancelled ? 'cancelled' : (result.failed > 0 ? 'failed' : 'completed')
    updateJob(jobId, status, result.completed, result.failed, null)
    console.log(`   ✅ 恢复完成: ${result.completed} 成功, ${result.failed} 失败`)
  } else {
    const jobId = resumeJob(bookId, 'kg')
    const result = await scanKg(bookId, jobId)
    const status = result.wasCancelled ? 'cancelled' : (result.failed > 0 ? 'failed' : 'completed')
    updateJob(jobId, status, result.completed, result.failed, null)
    console.log(`   ✅ 恢复完成: ${result.completed} 成功, ${result.failed} 失败`)
  }

  console.log('')
  console.log('💡 提示: 运行以下命令将结果导入主数据库:')
  console.log(`   node scripts/offline-scanner.mjs export ${bookId}`)
}

function runStop() {
  console.log('🛑 发送停止信号...')
  stopScan()
  console.log('   已发送。正在运行的扫描任务将在当前章节处理完后停止。')
}

// ========================
// 主入口
// ========================

async function main() {
  const [,, command, ...args] = process.argv

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    printHelp()
    return
  }

  if (command === 'config') {
    printConfig()
    return
  }

  if (command === 'sync') {
    syncConfigFromMain()
    return
  }

  if (command === 'stop') {
    runStop()
    return
  }

  if (command === 'status') {
    await runStatus(args[0])
    return
  }

  if (command === 'list') {
    await runList()
    return
  }

  if (command === 'import') {
    if (!args[0]) {
      console.error('❌ 需要 bookId。用法: import <bookId>')
      process.exit(1)
    }
    await runImport(args[0])
    return
  }

  if (command === 'export') {
    if (!args[0]) {
      console.error('❌ 需要 bookId。用法: export <bookId>')
      process.exit(1)
    }
    await runExport(args[0])
    return
  }

  if (command === 'bundle') {
    if (!args[0]) {
      console.error('❌ 需要 bookId。用法: bundle <bookId> [path]')
      process.exit(1)
    }
    await runBundle(args[0], args[1])
    return
  }

  if (command === 'scan') {
    const [type, bookId] = args
    if (!type || !bookId) {
      console.error('❌ 用法: scan <summary|kg|all> <bookId>')
      process.exit(1)
    }
    await runScan(type, bookId)
    return
  }

  if (command === 'resume') {
    const [type, bookId] = args
    if (!type || !bookId) {
      console.error('❌ 用法: resume <summary|kg|all> <bookId>')
      process.exit(1)
    }
    await runResume(type, bookId)
    return
  }

  console.error(`❌ 未知命令: ${command}`)
  console.error('运行 "node scripts/offline-scanner.mjs help" 查看帮助。')
  process.exit(1)
}

main().catch((error) => {
  console.error('❌ 致命错误:', error.message)
  console.error(error.stack)
  process.exit(1)
})
