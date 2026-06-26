# Novel Reader Gateway

`gateway/` 是 Novel Reader 云端网关服务的独立工作目录。

该服务的目标是让移动客户端默认连接一个稳定的公有域名，而不是依赖用户手动配置局域网 IP、LLM 服务、embedding 服务或 MP3 后端地址。移动端只需要完成鉴权并访问 Gateway API，具体的数据读取、AI 检索、embedding 转发、MP3 资源签名与分发由网关服务统一处理。

当前目录先用于沉淀设计、计划和后续实现。Gateway 代码、配置示例、部署脚本、API 文档和测试都应优先放在本目录内，避免与现有本地 SQLite API、`mobile-app/`、`offline-tts/` 混在一起。

## 设计原则

- 移动端默认访问固定 HTTPS 域名，并保留自定义服务地址作为高级选项。
- 移动端不保存 LLM、embedding、TTS 或对象存储密钥。
- 公网服务必须默认鉴权、限流、审计，不直接暴露现有本地数据库服务。
- 音频文件优先通过对象存储或 CDN 分发，Gateway 负责权限校验和短期签名 URL。
- AI 和 embedding 调用由服务端统一转发，并按用户、设备或访问 token 控制额度。
- 第一阶段先建立最小可用 API 壳子，再逐步接入书库、阅读数据、AI 检索和 MP3 播放。

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

可复制 `.env.example` 中的变量到部署环境。Phase 1 已提供：

- `GET /health`
- `GET /version`
- `GET /capabilities`
- `GET /auth/session`（受保护，用于验证 bearer token）
- `GET /auth/devices`（受保护，查看已登记设备）
- `GET /mobile/books`（受保护，返回 Gateway 书库索引）
- `GET /mobile/books/:bookId`（受保护，返回单书摘要）
- `GET /mobile/books/:bookId/package`（受保护，返回移动端完整数据包）
- `PUT /admin/books/:bookId/package`（受保护，导入 PC 端导出的移动数据包）
- `POST /ai/chat`（受保护，转发 OpenAI-compatible chat completions）
- `POST /ai/embeddings`（受保护，转发 OpenAI-compatible embeddings）
- `GET /mobile/books/:bookId/audio`（受保护，返回本地 MP3 清单）
- `GET /mobile/books/:bookId/audio/:chapterId/download`（受保护，下载章节 MP3）
- 统一错误响应格式
- 基础限流、安全响应头和可选 CORS 配置

开发期可通过 `GATEWAY_DEV_ACCESS_TOKEN` 启用静态 bearer token 鉴权。受保护接口需要携带：

```text
Authorization: Bearer <GATEWAY_DEV_ACCESS_TOKEN>
```

新的 Android 客户端应额外携带设备名，Gateway 会记录到 `GATEWAY_DATA_DIR/devices.json`：

```text
X-Device-Name: Android Phone
```

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

AI 转发第一版只支持 OpenAI-compatible 接口。`POST /ai/chat` 转发到 `<GATEWAY_AI_BASE_URL>/chat/completions`，`POST /ai/embeddings` 转发到 `<GATEWAY_EMBEDDING_BASE_URL>/embeddings`。如果请求体未指定 `model`，Gateway 会分别注入 `GATEWAY_AI_MODEL` 或 `GATEWAY_EMBEDDING_MODEL`。

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
如果提供了 `manifestFileName`，移动端可通过 `/mobile/books/:bookId/audio/:chapterId/manifest` 获取 offline-tts 生成的 timeline 元数据，用于播放时正文高亮。

offline-tts 产物可以用脚本发布到 Gateway 音频目录，不需要提交到 Git：

```bash
npm run gateway:publish-audio -- \
  --book-id <bookId> \
  --source-root tmp/tts/yaodao \
  --gateway-audio-dir /srv/novel-reader-gateway/audio
```

脚本会扫描 `<source-root>/chNNN-full/audio/chapter.mp3` 和 `manifest.json`，根据本地移动数据包章节序号匹配真实 `chapterId`，复制到 `GATEWAY_AUDIO_DIR/books/<bookId>/`，并生成 `audio.json`。可以用 `--package-file path/to/package.json` 跳过本地 API，或用 `--dry-run` 只检查映射结果。

未配置 AI、embedding 或对象存储时，`/capabilities` 会明确返回对应能力不可用，而不是在运行时崩溃。
