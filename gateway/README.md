# Novel Reader Gateway

`gateway/` 是 Novel Reader 云端网关服务的独立工作目录。

该服务的目标是让移动客户端默认连接一个稳定的公有域名，而不是依赖用户手动配置局域网 IP、LLM 服务、embedding 服务或 MP3 后端地址。移动端只需要完成鉴权并访问 Gateway API，具体的数据读取、AI 检索、embedding 转发、MP3 资源签名与分发由网关服务统一处理。

当前目录是 Gateway 服务、配置示例、部署脚本、API 文档、管理后台和测试的维护位置。Gateway 不直接复用本地 SQLite dev API；正式内容由 PC 端或 `production-pipeline` 生成 package、音频与 manifest 后发布到 Gateway 数据目录。

## 设计原则

- 移动端默认访问固定 HTTPS 域名，并保留自定义服务地址作为高级选项。
- 移动端不保存 LLM、embedding、TTS 或对象存储密钥。
- 公网服务必须默认鉴权、限流、审计，不直接暴露现有本地数据库服务。
- 音频文件优先通过对象存储或 CDN 分发，Gateway 负责权限校验和短期签名 URL。
- AI 和 embedding 调用由服务端统一转发，并按用户、设备或访问 token 控制额度。
- Gateway 负责移动端鉴权、书库/package 分发、AI/RAG 转发、MP3/manifest 分发、设备角色、后台管理和下载发布。

## 文档

- [开发计划](docs/development-plan.md)
- [部署说明](docs/deployment.md)

## 本地开发

Gateway 是一个独立 npm 子项目，运行时依赖集中在本目录。

```bash
npm --prefix gateway install
npm run gateway:dev
```

默认监听 `127.0.0.1:6180`。也可以直接在本目录运行：

```bash
npm run dev
npm run build
npm run test
```

管理后台 UI 位于 `gateway/admin-ui/`，构建后由 Gateway 服务挂载到 `/admin/ui`，不会覆盖 `/admin/books` 等 JSON 管理 API：

```bash
npm run gateway:admin-ui:build
npm run gateway:dev
```

后台页面会从同源 `/admin/*` 读取真实数据；浏览器本地可把后台 token 写入 `localStorage`：

```js
localStorage.setItem('novel-reader-gateway-admin-token', '<GATEWAY_ADMIN_ACCESS_TOKEN>')
```

可复制 `.env.example` 中的变量到部署环境。当前已提供：

- `GET /health`
- `GET /version`
- `GET /capabilities`
- `GET /downloads/novel_gateway.apk`（公开下载最新版 Android APK）
- `GET /auth/session`（受保护，用于验证 bearer token）
- `GET /auth/devices`（受保护，查看已登记设备）
- `GET /mobile/books`（受保护，返回 Gateway 书库索引）
- `GET /mobile/books/:bookId`（受保护，返回单书摘要）
- `GET /mobile/books/:bookId/package`（受保护，返回移动端完整数据包）
- `GET /mobile/books/:bookId/package/download`（受保护，下载移动端完整数据包）
- `PUT /admin/books/:bookId/package`（受保护，导入 PC 端导出的移动数据包）
- `GET /admin/books/:bookId/package/download`（受保护，下载后台完整数据包）
- `GET /admin/books`（受保护，返回后台全量书库视图）
- `DELETE /admin/books/:bookId`（受保护，从书库索引删除该书，并递归删除对应 package 与音频目录）
- `PATCH /admin/books/:bookId/visibility`（受保护，更新书籍可见范围）
- `PATCH /admin/books/:bookId/labels`（受保护，更新书籍内容标签）
- `GET /admin/packages`（受保护，返回数据包状态）
- `GET /admin/audio`（受保护，返回音频覆盖状态）
- `POST /admin/books/:bookId/audio/refresh`（受保护，重新读取音频状态）
- `DELETE /admin/books/:bookId/audio`（受保护，递归删除该书本地音频目录，包括 `audio.json`、MP3 和 manifest）
- `GET /admin/devices`（受保护，返回已登记设备）
- `PATCH /admin/devices/:deviceId`（受保护，更新设备名称或角色）
- `GET /admin/metrics`（受保护，返回请求量、错误率、P95 和下载统计）
- `GET /admin/events`（受保护，返回最近下载、错误和告警事件）
- `GET /admin/requests`（受保护，返回最近请求日志）
- `GET /admin/analytics`（受保护，返回持久化请求日志、手机行为日志、Top action、Top 书籍和日志文件统计）
- `GET /admin/ui`（内网管理后台静态入口）
- `POST /ai/chat`（受保护，转发 OpenAI-compatible chat completions）
- `POST /ai/embeddings`（受保护，转发 OpenAI-compatible embeddings）
- `POST /ai/search`（受保护，基于移动数据包执行概要、正文 chunk 与图谱召回）
- `POST /ai/rag-answer`（受保护，基于检索上下文生成带来源的回答）
- `GET /mobile/books/:bookId/audio`（受保护，返回本地 MP3 清单）
- `GET /mobile/books/:bookId/audio/:chapterId/download`（受保护，下载章节 MP3）
- `GET /mobile/books/:bookId/audio/:chapterId/manifest`（受保护，下载章节 timeline manifest）
- 统一错误响应格式
- 基础限流、安全响应头和可选 CORS 配置

第一版仍使用静态 bearer token，但已区分后台和移动端语义：

- `GATEWAY_ADMIN_ACCESS_TOKEN`：用于 `/admin/*` 和后台 AI/RAG 转发接口。
- `GATEWAY_MOBILE_ACCESS_TOKEN`：用于 `/auth/*` 和 `/mobile/*`。
- `GATEWAY_DEV_ACCESS_TOKEN`：兼容旧开发流程；仅在非生产环境作为 fallback。
- `GATEWAY_ENV=production` 时必须显式设置 `GATEWAY_ADMIN_ACCESS_TOKEN` 和 `GATEWAY_MOBILE_ACCESS_TOKEN`，不会回退到 dev token。

受保护接口需要携带：

```text
Authorization: Bearer <token>
```

新的 Android 客户端应额外携带稳定设备信息，Gateway 会记录到 `GATEWAY_DATA_DIR/devices.json`：

```text
X-Device-Id: <stable-device-id>
X-Device-Name: Android Phone
X-Device-Model: <model>
X-Device-Platform: android
X-App-Version: <version>
```

## 运维指标与日志

Gateway 会在内存中保留最近请求指标供 `/admin/metrics`、`/admin/events`、`/admin/requests` 快速展示，同时把请求和手机端日志持久化为 JSON Lines 文件，便于 `jq`、ClickHouse、DuckDB、Spark 等工具离线统计。

默认日志目录为 `GATEWAY_DATA_DIR/logs`，可用以下环境变量调整：

- `GATEWAY_LOG_DIR`：持久化 JSONL 日志根目录，默认 `GATEWAY_DATA_DIR/logs`。
- `GATEWAY_LOG_ROTATE_BYTES`：单个 JSONL 文件最大字节数，默认 `10485760`。
- `GATEWAY_LOG_RETENTION_DAYS`：按日期目录保留天数，默认 `30`。

目录格式：

```text
logs/
├── requests/
│   └── 2026-07-09/
│       ├── requests-2026-07-09-000.jsonl
│       └── requests-2026-07-09-001.jsonl
└── mobile/
    └── 2026-07-09/
        ├── mobile-2026-07-09-000.jsonl
        └── mobile-2026-07-09-001.jsonl
```

每行是一条独立 JSON 事件，顶层包含 `schemaVersion`、`kind`、`receivedAt`。请求日志使用 `kind: "gateway.request"`，手机端日志使用 `kind: "mobile.event"`。手机端行为日志的低基数字段是 `eventName`，书籍和章节分别在 `bookId`、`chapterId`，敏感字段会在客户端和服务端两侧按 `token`、`authorization`、`password`、`secret` 等键名脱敏。

手机端诊断与行为日志统一提交到：

- `POST /mobile/logs`（受保护，写入 JSONL，返回 `receiptId`）

后台统计入口：

- `GET /admin/analytics`：读取最近 7 天 JSONL，返回最近 24 小时行为事件数、诊断/错误数、活跃设备、Top action、Top 书籍、最近事件和日志文件统计。

第一版书库索引从 `GATEWAY_DATA_DIR/books.json` 读取。文件缺失时返回空书库；文件存在时应使用：

```json
{
  "schemaVersion": 1,
  "books": [
    {
      "id": "book-id",
      "title": "书名",
      "author": "作者",
      "chapterCount": 120,
      "wordCount": 600000,
      "summaryCoverage": 0.8,
      "kgCoverage": 0.6,
      "embeddingCoverage": 0.9,
      "audioChapterCount": 12,
      "updatedAt": "2026-06-25T00:00:00.000Z"
    }
  ]
}
```

单书完整移动数据包从 `GATEWAY_DATA_DIR/books/<bookId>/package.json` 读取。当前 Gateway 只校验顶层 `schemaVersion: 1` 和 `book.id` 必须匹配请求路径，其余章节、概要、图谱、embedding 覆盖等字段先原样返回，后续再随移动端同步 schema 收紧。

PC 端或其他工具可以通过 `PUT /admin/books/:bookId/package` 上传同样格式的数据包。Gateway 会保存到 `books/<bookId>/package.json`，并根据包内 `book` 字段自动更新 `books.json` 书库索引。

也可以直接用脚本从本机 API 发布，不需要在 PC 端界面增加上传入口：

```bash
npm run gateway:publish-package -- \
  --book-id <bookId> \
  --source-api http://127.0.0.1:5174 \
  --gateway-url https://reader.example.com \
  --gateway-token <GATEWAY_DEV_ACCESS_TOKEN>
```

脚本默认读取 `NOVEL_READER_API_BASE_URL`、`GATEWAY_BASE_URL`、`GATEWAY_DEV_ACCESS_TOKEN` 和 `NOVEL_READER_SYNC_TOKEN`。如果已经有导出的 JSON 文件，也可以用 `--source-file path/to/package.json` 跳过本地 API；`--dry-run` 可只校验不上传。

Android 客户端 APK 可以发布到 Gateway 的公开下载目录。Gateway 默认从 `GATEWAY_DATA_DIR/downloads` 提供 `/downloads/*` 静态下载，也可以用 `GATEWAY_DOWNLOADS_DIR` 指定目录：

```bash
npm run gateway-android:android:build
npm run gateway:publish-android-apk
```

发布后最新版固定地址为 `/downloads/novel_gateway.apk`，同时保留版本文件 `/downloads/novel_gateway-v<versionName>-debug.apk`，并写入 `/downloads/android-app.json` 供后续检查当前版本、构建号和 commit。`versionName` 来自 Gateway Android 构建信息，例如 `0.7.0+build.228.g3fcfd98db346`。

AI chat 转发第一版支持 OpenAI-compatible 接口。`POST /ai/chat` 转发到 `<GATEWAY_AI_BASE_URL>/chat/completions`。Embedding 转发支持 OpenAI-compatible 和 Ollama：默认 `GATEWAY_EMBEDDING_PROVIDER=openai-compatible` 时转发到 `<GATEWAY_EMBEDDING_BASE_URL>/embeddings`；设置 `GATEWAY_EMBEDDING_PROVIDER=ollama` 时转发到 `<GATEWAY_EMBEDDING_BASE_URL>/api/embeddings`，例如 `http://192.168.88.100:11434` + `qwen3-embedding:8b`。如果请求体未指定 `model`，Gateway 会分别注入 `GATEWAY_AI_MODEL` 或 `GATEWAY_EMBEDDING_MODEL`。

本地 MP3 第一版从 `GATEWAY_AUDIO_DIR/books/<bookId>/audio.json` 读取清单，音频文件与 `audio.json` 放在同一目录或其子目录。清单格式：

```json
{
  "schemaVersion": 1,
  "chapters": [
    {
      "chapterId": "chapter-1",
      "title": "第一章",
      "fileName": "chapter-1.mp3",
      "manifestFileName": "chapter-1.manifest.json",
      "timelineVersion": 1,
      "durationMs": 120000,
      "sizeBytes": 1048576,
      "updatedAt": "2026-06-25T00:00:00.000Z"
    }
  ]
}
```

`fileName` 必须是相对路径，不能包含 `..` 或绝对路径。实际下载通过 Gateway 鉴权后的 `/mobile/books/:bookId/audio/:chapterId/download` 完成。
如果提供了 `manifestFileName`，移动端可通过 `/mobile/books/:bookId/audio/:chapterId/manifest` 获取 production-pipeline 生成的 timeline 元数据，用于播放时正文高亮。

production-pipeline 产物可以用脚本发布到 Gateway 音频目录，不需要提交到 Git：

```bash
npm run gateway:publish-audio -- \
  --book-id <bookId> \
  --source-root tmp/tts/<book-key> \
  --gateway-audio-dir /srv/novel-reader-gateway/audio
```

脚本会扫描 `<source-root>/chNNN-full/audio/chapter.mp3` 和 `manifest.json`，根据本地移动数据包章节序号匹配真实 `chapterId`，复制到 `GATEWAY_AUDIO_DIR/books/<bookId>/`，并生成 `audio.json`。可以用 `--package-file path/to/package.json` 跳过本地 API，或用 `--dry-run` 只检查映射结果。

公网部署后可以执行安全 smoke 检查：

```bash
npm run gateway:security-smoke
```

脚本默认检查 `https://novel.gwaves.net:8888`，可通过 `GATEWAY_SECURITY_BASE_URL`、`GATEWAY_SECURITY_IP_URL` 和 `GATEWAY_SECURITY_HOST` 覆盖目标。

如果 Gateway 跑在远端机器上，可以在本地整理完音频目录后直接同步到远端挂载目录。例如家里网关机器 `192.168.88.100` 的 compose 挂载了 `~/novel-reader-gateway/audio:/audio`，以便管理后台可以清理重建单书音频目录：

```bash
npm run gateway:publish-audio -- \
  --book-id <bookId> \
  --source-root tmp/production-pipeline/runs/<bookId>/<runId>/artifacts/audio \
  --gateway-audio-dir ~/.novel_reader_gateway/audio \
  --remote-host 192.168.88.100 \
  --remote-audio-dir '~/novel-reader-gateway/audio'
```

需要指定 SSH 用户或端口时，增加 `--remote-user <user>` 和 `--remote-ssh-port <port>`；脚本会把 `books/<bookId>/` 同步到远端，并默认删除远端该书目录里已经不存在的旧文件。

未配置 AI、embedding 或对象存储时，`/capabilities` 会返回公开可见的能力可用性；认证模式、token 配置状态和限流细节不会从匿名公网接口暴露。
