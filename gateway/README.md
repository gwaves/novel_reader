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
- 统一错误响应格式
- 基础限流、安全响应头和可选 CORS 配置

未配置 AI、embedding 或对象存储时，`/capabilities` 会明确返回对应能力不可用，而不是在运行时崩溃。
