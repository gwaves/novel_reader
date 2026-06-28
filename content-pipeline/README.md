# 内容生产流水线

内容生产流水线负责把已有书籍或上传文件转成移动端和 Gateway 可消费的完整内容资产。

第一版先做编排层：复用现有离线扫描器、离线 TTS 和 Gateway 发布脚本，用统一 manifest 记录每本书的生产状态。后续再把 TXT、EPUB、PDF 原始文件导入和 Gateway 异步任务接进来。

## 目标链路

```text
TXT / EPUB / PDF / 主数据库书籍
  -> 章节切分与正文规范化
  -> 概要
  -> embedding
  -> 知识图谱
  -> TTS 导演脚本
  -> MP3 + timeline
  -> Gateway package/audio 发布
  -> 移动端同步与播放
```

## 快速开始

列出现有命令：

```bash
npm run content:pipeline -- help
```

运行本地 smoke 验证。该命令只使用 `tmp/content-pipeline-smoke-auto` 下的临时 TXT/EPUB/PDF 和 SQLite 文件，不调用模型、不发布 Gateway：

```bash
npm run content:pipeline:smoke
```

启动独立 Web 生产控制台：

```bash
npm --prefix content-pipeline install
npm run content:pipeline:service
```

默认监听 `http://127.0.0.1:6290`。控制台通过本地服务启动生产 job、捕获 stdout/stderr、读取 `production-manifest.json`，并显示每个阶段的状态。可选环境变量：

- `CONTENT_PIPELINE_HOST` / `CONTENT_PIPELINE_PORT`：监听地址，默认 `127.0.0.1:6290`。
- `CONTENT_PIPELINE_SERVICE_DATA_DIR`：job 与日志目录，默认 `tmp/content-pipeline-service`。
- `CONTENT_PIPELINE_WORK_ROOT`：manifest 默认工作根目录，默认 `tmp/content-pipeline`。
- `CONTENT_PIPELINE_MAIN_DB`：书籍查询使用的主数据库；默认依次读取 `NOVEL_READER_MAIN_DB`、`NOVEL_READER_DB_PATH` 或 `~/.novel_reader/novel_reader.sqlite`。
- `CONTENT_PIPELINE_SERVICE_TOKEN`：设置后 API 需要 `Authorization: Bearer <token>`；本机开发可不设置。

不知道 `bookId` 时，先在控制台左侧“主数据库书籍”里搜索书名或直接点“查询书籍”，选中书籍后会自动填入 `Book ID` 和标题。

使用配置文件提供默认 Gateway、脚本路径和输出目录：

```bash
npm run content:pipeline -- run \
  --config content-pipeline/config.example.json \
  --manifest tmp/content-pipeline/<bookId>/production-manifest.json \
  --steps import,scan,export
```

为主数据库中已有书籍创建生产 manifest：

```bash
npm run content:pipeline -- init --book-id <bookId> --title <bookTitle>
```

从 TXT/EPUB/MOBI/AZW/AZW3 文件导入到主数据库，并创建或更新生产 manifest。MOBI/AZW/AZW3 需要本机安装 Calibre，并确保 `ebook-convert` 在 `PATH` 中：

```bash
npm run content:pipeline -- ingest --file ~/Books/example.txt
```

查看状态：

```bash
npm run content:pipeline -- status --manifest tmp/content-pipeline/<bookId>/production-manifest.json
```

执行已有书籍的扫描、导回、发布编排：

```bash
npm run content:pipeline -- run \
  --manifest tmp/content-pipeline/<bookId>/production-manifest.json \
  --steps import,scan,export,publish-package
```

为已完成概要的章节生成 summary/chunk embedding：

```bash
npm run content:pipeline -- run \
  --manifest tmp/content-pipeline/<bookId>/production-manifest.json \
  --steps embedding \
  --limit 1
```

生成 MP3 并发布音频：

```bash
npm run content:pipeline -- run \
  --manifest tmp/content-pipeline/<bookId>/production-manifest.json \
  --steps audio,publish-audio \
  --chapters 1-10 \
  --tts-config offline-tts/config.example.json \
  --gateway-audio-dir gateway/data/audio
```

发布到远端 Gateway 机器时，`publish-audio` 可以把本地整理好的 `books/<bookId>/` 继续同步到远端音频挂载目录：

```bash
npm run content:pipeline -- run \
  --manifest tmp/content-pipeline/<bookId>/production-manifest.json \
  --steps publish-package,publish-audio \
  --audio-source-root tmp/content-pipeline/<bookId>/audio \
  --gateway-url https://192.168.88.100:8888 \
  --gateway-token <GATEWAY_DEV_ACCESS_TOKEN> \
  --gateway-audio-dir ~/.novel_reader_gateway/audio \
  --gateway-remote-host 192.168.88.100 \
  --gateway-remote-audio-dir '~/novel-reader-gateway/audio'
```

## 当前边界

- `ingest --file` 已支持 TXT/EPUB/MOBI/AZW/AZW3 导入到主数据库，并按文件 sha256 稳定生成默认 `bookId`，重复提交同一文件会复用同一书籍记录。
- MOBI/AZW/AZW3 通过 Calibre `ebook-convert` 转成临时 EPUB 后复用 EPUB 导入路径；未安装 Calibre 时会给出明确错误。
- `init` 仍可记录 `--source-file` 但不会解析文件；真实文件导入请使用 `ingest`。
- PDF 解析尚未接入；Phase 2 先支持 TXT/EPUB，文本型 PDF 后续补充。
- `scan` 复用 `scripts/offline-scanner.mjs`，目前覆盖 summary 和 kg。
- `run --steps scan` 默认执行 `all`，可用 `--scan-type summary` 或 `--scan-type kg` 做低成本局部验证。
- 真实 `scan` 前默认执行 `scripts/offline-scanner.mjs sync`，从 PC 主数据库同步当前大模型配置；调试旧离线配置时可传 `--skip-config-sync`。
- `embedding` 复用 PC 本地 API `/api/rag/embeddings/*`，从主数据库 `app_state.embeddingConfig` 读取模型配置；运行前会检查本地 API 是否可达，manifest 只记录 provider、model、baseUrl、维度和覆盖率，不记录 API key。
- `audio` 复用 `offline-tts/scripts/tts-director.mjs batch-pipeline`。
- `publish-package` 和 `publish-audio` 复用 `gateway/scripts/` 下已有脚本。
- Gateway token 不写入 manifest；真实发布时优先通过 `GATEWAY_DEV_ACCESS_TOKEN` 或命令行传入。
