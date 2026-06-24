# Gateway 开发计划

## 背景

当前独立移动端主要通过局域网访问 PC 端本地后端，用户需要配置内网 IP、确保手机和电脑在同一网络，并单独处理 LLM、embedding、TTS/MP3 等后端能力。这个模式适合开发和自用，但对普通用户不够友好，也难以支撑离开局域网后的默认体验。

Gateway 的目标是新增一个专门的云端服务：移动端默认连接公有域名，通过鉴权访问书籍数据、阅读进度、AI 检索、embedding 转发和 MP3 播放资源。服务端统一持有供应商密钥、转发模型请求、控制额度，并为移动端提供稳定 API。

## 产品目标

- 移动端安装后默认连接官方或自部署 Gateway 域名，不再要求用户手动填写 PC 内网 IP。
- 移动端不直接配置 LLM、embedding、TTS 或对象存储密钥。
- Gateway 为移动端提供统一鉴权、书库同步、阅读数据、搜索问答和音频资源入口。
- MP3 后端生成的章节音频和 timeline 可通过 Gateway 获取，移动端只负责播放、缓存和进度同步。
- 保留高级用户自定义 Gateway 地址或继续使用局域网同步的能力。

## 非目标

- 第一阶段不直接把现有 `scripts/local-db-server.mjs` 暴露到公网。
- 第一阶段不立即实现完整多租户计费系统。
- 第一阶段不要求移动端完全在线；移动端仍应保留已同步数据的离线阅读和音频缓存。
- 第一阶段不迁移 PC 端全部功能到云端，PC 端仍可作为数据生产、导入和本地管理工具。

## 建议架构

```text
Mobile App
  -> Gateway HTTPS API
      -> Auth / Token / Device Binding
      -> Book Data API
      -> Reading Progress API
      -> AI Search Gateway
      -> Embedding Gateway
      -> MP3 Metadata API
      -> Object Storage / CDN Signed URLs
      -> Optional Private Backend Connector
```

## 模块边界

- `gateway/`：云端网关服务代码、配置、部署脚本、API 文档和测试。
- `mobile-app/`：移动端默认 Gateway 域名、登录/访问码、自定义服务地址、缓存与播放体验。
- 新的 Gateway Android 客户端应单独新建应用目录/工程，现有 `mobile-app/` 保持不变，作为已可用移动端和回退路径。
- `scripts/local-db-server.mjs`：继续作为本地 PC 端 API，不作为公网服务直接复用。
- `offline-tts/`：继续负责导演脚本、TTS 合成和 MP3 生产；后续可把产物登记到 Gateway。

## 能力分层

### 1. 基础服务层

- HTTPS 反向代理和公有域名。
- `/health`、`/version`、`/capabilities`。
- 统一错误格式、请求 ID、结构化日志。
- 配置加载和密钥管理。

### 2. 鉴权与访问控制

- 访问 token 或邀请码登录。
- 设备绑定和 token 轮换。
- 用户、设备、接口级限流。
- AI、embedding、MP3 下载额度统计。
- 管理端撤销 token 的能力。

### 3. 移动数据 API

- 书库列表。
- 单书章节、概要、知识图谱、embedding 覆盖率和更新时间。
- 阅读进度读写。
- 增量同步接口。
- 离线包下载接口。

### 4. AI 与 Embedding 转发

- 移动端提交搜索或问答请求。
- Gateway 选择后端模型服务并注入密钥。
- 统一超时、重试、成本统计和安全日志。
- embedding 生成或查询请求由 Gateway 转发，避免移动端暴露供应商密钥。

### 5. MP3 音频服务

- 章节音频清单。
- timeline 和片段高亮元数据。
- 音频文件状态、大小、时长、更新时间。
- 对象存储或 CDN 的短期签名 URL。
- 移动端缓存校验和过期刷新。

## API 草案

```text
GET  /health
GET  /version
GET  /capabilities

POST /auth/token
POST /auth/refresh
POST /auth/revoke

GET  /mobile/books
GET  /mobile/books/:bookId
GET  /mobile/books/:bookId/package
GET  /mobile/books/:bookId/changes?since=...
GET  /mobile/books/:bookId/audio
POST /mobile/progress

POST /ai/search
POST /ai/chat
POST /ai/embeddings
```

## 数据与安全要求

- 所有公网 API 默认需要鉴权，健康检查除外。
- token 不应直接等同于上游供应商 API Key。
- 服务端日志不得记录完整正文、模型密钥、签名 URL 或用户 token。
- AI 转发接口必须有额度和并发限制。
- MP3 文件不使用永久公开 URL，默认返回短期签名地址。
- Gateway 对移动端返回的错误应可读，但不能泄露内部服务地址和密钥配置。

## 阶段计划

### Phase 0：目录与计划

- 创建 `gateway/` 工作目录。
- 记录 Gateway 产品目标、模块边界、API 草案和安全要求。
- 在当前进度文档中登记该方向。

### Phase 1：最小服务骨架

- 选择 Gateway 技术栈和运行方式。
- 增加独立 npm workspace 或子项目脚本。
- 实现健康检查、版本接口、配置加载和统一错误格式。
- 增加基础测试和本地启动说明。

当前选择：

- Fastify + TypeScript 作为 Gateway API 框架。
- Zod 负责环境变量配置解析。
- Fastify/Pino 负责结构化请求日志。
- `@fastify/helmet`、`@fastify/rate-limit` 和可选 CORS 作为基础公网服务防护。
- Vitest 负责最小接口测试。

### Phase 2：鉴权与移动端默认域名

- 实现访问 token 或邀请码登录。
- 移动端增加默认 Gateway base URL。
- 移动端设置页保留自定义服务地址。
- 完成移动端到 Gateway 的健康检查和登录状态显示。

### Phase 3：书库与阅读数据

- 实现书库列表、单书数据包、阅读进度读写。
- 定义 Gateway 移动数据 schema。
- 支持从 PC 端或离线包导入书籍数据到 Gateway。
- 移动端通过 Gateway 拉取并缓存书籍。

### Phase 4：AI 与 Embedding Gateway

- 实现 `/ai/search`、`/ai/chat`、`/ai/embeddings` 的受控转发。
- 支持上游 OpenAI-compatible 服务配置。
- 增加限流、超时、重试和成本统计。
- 移动端移除普通用户必须配置 LLM/embedding 的路径。

### Phase 5：MP3 资源接入

- 实现章节音频清单和 timeline 元数据接口。
- 接入对象存储或静态文件存储。
- 返回短期签名 URL 或受控下载 URL。
- 移动端通过 Gateway 下载、缓存并播放章节 MP3。

### Phase 6：部署与运维

- 补充 Dockerfile、环境变量模板和部署文档。
- 配置域名、HTTPS、反向代理和日志。
- 增加备份、迁移、监控和告警方案。

## 近期任务

1. 确定 Gateway 技术栈：优先考虑 Node.js + TypeScript，复用项目现有生态。
2. 设计最小配置文件：监听端口、公开 base URL、token 密钥、上游 AI/embedding base URL、对象存储配置。
3. 搭建 `/health`、`/version`、`/capabilities` 三个只读接口。
4. 明确移动端默认连接策略：官方域名优先，自定义域名作为高级设置。
5. 定义第一版鉴权策略：开发期静态 token，生产期可迁移到邀请码或账号体系。

## 验收标准

- 可以在本地独立启动 Gateway 服务，不依赖 Vite 前端。
- `GET /health` 能返回服务状态。
- 移动端可配置或默认访问 Gateway base URL。
- 未鉴权请求不能访问书籍、AI、embedding 或 MP3 数据。
- AI 与 MP3 能力在未配置上游服务时返回明确的能力缺失信息，而不是运行时崩溃。
