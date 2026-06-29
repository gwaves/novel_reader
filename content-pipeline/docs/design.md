# 内容生产系统设计

## 背景

Gateway Android 已经可以消费 Gateway 中的书籍 package 和章节 MP3。项目内也已经存在离线扫描器、离线 TTS 和 Gateway 发布脚本，但这些能力目前分散在不同目录，缺少统一的生产状态、断点信息和发布记录。

内容生产系统的第一目标是把这些散点收束成一条可重复、可审计、可恢复的流水线。它既服务本地批量生产，也为后续 Gateway 接收用户提交文件、异步调度生产任务打基础。

## 产品目标

- 一条命令可以驱动已有书籍完成概要、知识图谱、音频和 Gateway 发布。
- 每本书有独立 manifest，记录输入、阶段状态、产物路径、失败原因和发布时间。
- 支持断点续跑，不因为单章失败丢失已完成结果。
- 支持先从主数据库已有书籍生产，再扩展到 TXT、EPUB、PDF 文件提交。
- Gateway 未来可以把上传任务转成同一套 manifest 和生产命令。

## 非目标

- 第一版不重写 TXT/EPUB 导入逻辑。
- 第一版不直接实现 PDF OCR 和版面修复。
- 第一版不引入新的队列服务、账号系统或多租户计费。
- 第一版不让移动端承担 embedding、知识图谱或 MP3 生产。

## 架构

```text
content-pipeline CLI
  -> production-manifest.json
  -> scripts/offline-scanner.mjs
  -> offline-tts/scripts/tts-director.mjs
  -> gateway/scripts/publish-package.mjs
  -> gateway/scripts/publish-audio.mjs
  -> Gateway
```

## Manifest

`production-manifest.json` 是内容生产的事实记录。它不保存 Gateway token、模型 API key 等敏感值，只保存任务状态和可公开的路径/参数。

核心字段：

- `schemaVersion`：manifest schema 版本。
- `book`：书籍 ID、标题和来源信息。
- `workspace`：当前书籍的生产目录。
- `stages`：每个阶段的状态、开始/结束时间、耗时、错误和产物路径。
- `runs`：最近执行过的命令记录，包含命令摘要和耗时，便于排查失败与性能瓶颈。

阶段状态：

- `pending`：尚未开始。
- `running`：正在执行。
- `completed`：成功完成。
- `failed`：执行失败，可重试。
- `skipped`：本次未执行或当前条件不适用。

## 阶段定义

### 1. ingest

近期只记录来源。已有书籍通过 `--book-id` 从主数据库进入流水线。后续接入 TXT、EPUB 和 PDF 时，`ingest` 负责：

- 计算文件 hash。
- 保存原始文件副本或对象存储 key。
- 调用导入器生成书籍和章节。
- 写回生成的 `bookId`。

### 2. scan

复用 `scripts/offline-scanner.mjs`：

```text
import -> scan all -> export
```

当前覆盖 summary 和 knowledge graph。embedding 后续需要补成独立阶段，或者让本地 API 暴露批量生产命令。

真实执行 `scan` 前，内容生产 CLI 默认先运行 `scripts/offline-scanner.mjs sync`，从 PC 端主数据库同步当前大模型配置到离线扫描配置，避免使用过期的 `~/.novel_reader/offline-config.json`。如果需要刻意使用离线配置文件，可传 `--skip-config-sync`。

### 3. audio

复用 `offline-tts/scripts/tts-director.mjs batch-pipeline`，输出导演脚本、审计文件、MP3 和 timeline manifest。

生产策略：

- LLM 阶段按章节串行，降低本地模型服务过载风险。
- TTS 阶段允许章节级并发。
- 默认使用 `--resume`。
- 常规 TTS 推荐参数为 `--tts-concurrency 16 --tts-chapters 2`；服务波动、网络不稳定或排障时降到 `--tts-concurrency 8 --tts-chapters 2`。继续提高前应先记录片段级请求耗时和异常重试率。

### 4. publish-package

复用 `gateway/scripts/publish-package.mjs`，把本地移动数据包上传到 Gateway。

### 5. publish-audio

复用 `gateway/scripts/publish-audio.mjs`，把音频目录整理到 Gateway audio 目录，并生成 `audio.json`。

## Gateway 用户提交入口

后续移动端可以增加“提交小说”入口，上传 TXT、EPUB 或 PDF 到 Gateway。Gateway 不应同步阻塞等待全量生产完成，而应返回任务 ID：

```text
submitted -> accepted -> ingesting -> producing -> review_needed -> published -> failed
```

移动端显示任务状态。生产完成后，书籍自动进入用户书库；音频可在稍后逐章补齐。

## 风险

- PDF 解析质量不稳定，应排在 TXT/EPUB 之后。
- MP3 生产成本和耗时高，需要明确章节级状态和失败重试。
- 用户上传内容涉及版权和隐私，Gateway 生产任务需要私有书库边界、访问控制和删除能力。
- 大模型生产质量需要抽查和审计，不能只看命令成功。
