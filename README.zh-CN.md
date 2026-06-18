# 小说阅读助手

[English](README.md) | [中文](README.zh-CN.md)

本地优先的中文长篇小说阅读器，支持 AI 生成章节概要，以及用于追踪人物、门派、道具、功法、地点等的小说知识图谱。

## 功能

- 导入 `.txt` 小说文件，自动处理 UTF-8 / GB18030 编码。
- 将长篇小说拆分为章节，章节列表按每 100 章分页。
- 在本地 SQLite 数据库中持久化导入的章节、阅读进度、概要及设置，默认路径为 `~/.novel_reader`。
- 生成单章或当前页概要。
- 配置本地 Ollama 模型或兼容 OpenAI 的外部模型。
- 支持多组外部模型配置，每组可独立设置模型名、Base URL、API Key、Temperature 和思考模式。
- 调整阅读器字体大小。
- **知识图谱**：
  - 从每章抽取实体（人物、门派、道具、功法、地点、灵兽、事件）及它们之间的关系。
  - 支持整书批量扫描，任务可断点续传。
  - 在低置信度实体/关系复审队列中审核数据。
  - 合并、编辑、删除实体与关系。
  - 实体/关系列表支持类型筛选与名称/别名搜索。
- **离线扫描器 CLI**（`scripts/offline-scanner.mjs`）：
  - 在浏览器外批量扫描章节概要或知识图谱抽取结果。
  - 支持中断续扫，并将结果导回主数据库。
  - 复用与 Web 端相同的 Ollama/OpenAI 配置。

## 文档

- [Development Guide（英文开发文档）](docs/development.md)
- [开发文档（中文）](docs/development.zh-CN.md)
- [Knowledge Graph Roadmap（知识图谱路线图）](docs/knowledge-graph-roadmap.md)
- [Current Progress（当前进度）](docs/current_progress.md)

## 开发

```bash
npm install
npm run dev
```

这会同时启动 Vite 前端和本地数据库 API。SQLite 数据库默认保存在：

```text
~/.novel_reader/novel_reader.sqlite
```

打开：

```text
http://127.0.0.1:5173/
```

可以修改开发服务器端口：

```bash
NOVEL_READER_PORT=5174 npm run dev
```

也可以修改数据目录或 API 端口：

```bash
NOVEL_READER_DATA_DIR=/path/to/data NOVEL_READER_API_PORT=6174 npm run dev
```

## 独立阅读实例

如果你不想占用开发端口，可以单独启动一个阅读实例：

```bash
NOVEL_READER_PORT=6173 npm run reader:build
```

打开：

```text
http://127.0.0.1:6173/
```

也可以自定义监听地址：

```bash
NOVEL_READER_HOST=0.0.0.0 NOVEL_READER_PORT=6173 npm run reader:build
```

## 构建

```bash
npm run build
```

## 注意事项

这是一个个人本地 Web 应用。API Key 以明文形式存储在本地 SQLite 数据库中，因此在没有增加后端代理、身份认证和密钥管理之前，请勿将其作为公开多用户服务部署。
