import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_CONFIG_PATH = join(homedir(), '.novel_reader', 'offline-config.json')
const MAIN_DB_PATH = process.env.NOVEL_READER_MAIN_DB || join(homedir(), '.novel_reader', 'novel_reader.sqlite')

export const configPath = process.env.NOVEL_READER_OFFLINE_CONFIG || DEFAULT_CONFIG_PATH

export function loadMainConfig() {
  const db = new DatabaseSync(MAIN_DB_PATH)
  let config = null

  try {
    const row = db.prepare("SELECT value_json FROM app_state WHERE key = 'novel-reader-mvp-state'").get()
    if (!row) return null

    const state = JSON.parse(row.value_json)
    const activeConfig = state.openaiConfigs?.find(c => c.id === state.activeOpenAIConfigId) || state.openaiConfigs?.[0]

    config = {
      provider: state.aiProvider || 'ollama',
      ollama: {
        baseUrl: process.env.OFFLINE_OLLAMA_BASE_URL || 'http://localhost:11434',
        model: state.ollamaModel || 'qwen2.5:7b',
        temperature: Number.isFinite(state.ollamaTemperature) ? state.ollamaTemperature : 1,
        concurrency: Number.isFinite(state.ollamaConcurrency) ? Math.max(1, Math.min(10, state.ollamaConcurrency)) : 1,
        thinkingEnabled: Boolean(state.thinkingEnabled),
      },
      openai: activeConfig ? {
        baseUrl: activeConfig.baseUrl || 'https://api.openai.com/v1',
        apiKey: activeConfig.apiKey || '',
        model: activeConfig.model || 'gpt-4.1-mini',
        temperature: Number.isFinite(activeConfig.temperature) ? activeConfig.temperature : 1,
        concurrency: Number.isFinite(activeConfig.concurrency) ? Math.max(1, Math.min(10, activeConfig.concurrency)) : 3,
        thinkingEnabled: Boolean(activeConfig.thinkingEnabled),
      } : null,
      generatedAt: new Date().toISOString(),
      source: MAIN_DB_PATH,
    }
  } finally {
    db.close()
  }

  return config
}

export function saveConfig(config) {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function loadConfig() {
  if (!existsSync(configPath)) {
    const mainConfig = loadMainConfig()
    if (mainConfig) {
      saveConfig(mainConfig)
      console.log(`  ✅ 已自动生成配置文件: ${configPath}`)
      return mainConfig
    }
    // 默认配置
    const defaultConfig = {
      provider: 'ollama',
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5:7b',
        temperature: 1,
        concurrency: 1,
        thinkingEnabled: false,
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4.1-mini',
        temperature: 1,
        concurrency: 3,
        thinkingEnabled: false,
      },
      generatedAt: new Date().toISOString(),
      source: 'default',
    }
    saveConfig(defaultConfig)
    console.log(`  ✅ 已生成默认配置文件: ${configPath}`)
    return defaultConfig
  }

  const raw = readFileSync(configPath, 'utf-8')
  const config = JSON.parse(raw)

  // 环境变量覆盖（用于快速调试，不修改配置文件）
  if (process.env.OFFLINE_AI_PROVIDER) {
    config.provider = process.env.OFFLINE_AI_PROVIDER
  }
  if (process.env.OFFLINE_OLLAMA_MODEL) {
    config.ollama.model = process.env.OFFLINE_OLLAMA_MODEL
  }
  if (process.env.OFFLINE_OLLAMA_CONCURRENCY) {
    config.ollama.concurrency = Math.max(1, Math.min(10, Number(process.env.OFFLINE_OLLAMA_CONCURRENCY)))
  }
  if (process.env.OFFLINE_OLLAMA_BASE_URL) {
    config.ollama.baseUrl = process.env.OFFLINE_OLLAMA_BASE_URL
  }
  if (process.env.OFFLINE_OPENAI_MODEL) {
    config.openai.model = process.env.OFFLINE_OPENAI_MODEL
  }
  if (process.env.OFFLINE_OPENAI_CONCURRENCY) {
    config.openai.concurrency = Math.max(1, Math.min(10, Number(process.env.OFFLINE_OPENAI_CONCURRENCY)))
  }
  if (process.env.OFFLINE_OPENAI_BASE_URL) {
    config.openai.baseUrl = process.env.OFFLINE_OPENAI_BASE_URL
  }
  if (process.env.OFFLINE_OPENAI_API_KEY) {
    config.openai.apiKey = process.env.OFFLINE_OPENAI_API_KEY
  }

  return config
}

export function syncConfigFromMain() {
  const mainConfig = loadMainConfig()
  if (!mainConfig) {
    console.log('  ⚠️  无法从主数据库读取配置，使用现有配置文件。')
    return loadConfig()
  }
  saveConfig(mainConfig)
  console.log(`  ✅ 已同步主项目配置到: ${configPath}`)
  console.log(`     提供商: ${mainConfig.provider}`)
  if (mainConfig.provider === 'ollama') {
    console.log(`     模型: ${mainConfig.ollama.model} | 并发: ${mainConfig.ollama.concurrency}`)
  } else {
    console.log(`     模型: ${mainConfig.openai.model} | 并发: ${mainConfig.openai.concurrency}`)
  }
  return mainConfig
}

export function getConfig() {
  const config = loadConfig()

  if (config.provider === 'openai') {
    return {
      provider: 'openai',
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      model: config.openai.model,
      temperature: config.openai.temperature,
      concurrency: config.openai.concurrency,
      thinkingEnabled: config.openai.thinkingEnabled,
    }
  }

  return {
    provider: 'ollama',
    baseUrl: config.ollama.baseUrl,
    model: config.ollama.model,
    temperature: config.ollama.temperature,
    concurrency: config.ollama.concurrency,
    thinkingEnabled: config.ollama.thinkingEnabled,
  }
}

export function printConfig() {
  const config = loadConfig()
  console.log('⚙️  当前离线扫描器配置：')
  console.log(`   配置文件: ${configPath}`)
  console.log(`   提供商: ${config.provider}`)
  if (config.provider === 'ollama') {
    console.log(`   模型: ${config.ollama.model}`)
    console.log(`   Temperature: ${config.ollama.temperature}`)
    console.log(`   并发: ${config.ollama.concurrency}`)
    console.log(`   Base URL: ${config.ollama.baseUrl}`)
  } else {
    console.log(`   模型: ${config.openai.model}`)
    console.log(`   Base URL: ${config.openai.baseUrl}`)
    console.log(`   Temperature: ${config.openai.temperature}`)
    console.log(`   并发: ${config.openai.concurrency}`)
    console.log(`   API Key: ${config.openai.apiKey ? '已设置' : '未设置'}`)
  }
  console.log(`   生成时间: ${config.generatedAt}`)
  console.log(`   来源: ${config.source}`)
}
