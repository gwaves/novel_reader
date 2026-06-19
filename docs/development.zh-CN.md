# 开发文档

## 前置要求

- Node.js（项目使用原生 `node:sqlite`，建议 Node.js 22+）
- npm

## 快速开始

```bash
npm install
npm run dev
```

这会同时启动 Vite 前端和本地 SQLite API 服务器。

- 前端：http://127.0.0.1:5173/
- API 服务：http://127.0.0.1:5174/

## npm 脚本

| 脚本 | 说明 |
|------|------|
| `npm run dev` | 同时启动 Vite 和 API 服务 |
| `npm run api` | 只启动 SQLite API 服务 |
| `npm run vite:dev` | 只启动 Vite 开发服务器 |
| `npm run build` | 类型检查并构建生产版本 |
| `npm run reader` | 预览生产构建（`vite preview`） |
| `npm run reader:build` | 先构建再预览 |
| `npm run lint` | 运行 ESLint |
| `npm run preview` | `reader` 的别名 |

## 环境变量

### 开发服务器（`scripts/dev.mjs`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOVEL_READER_HOST` | `0.0.0.0` | Vite 监听地址 |
| `NOVEL_READER_PORT` | `5173` | Vite 监听端口 |

### API 服务（`scripts/local-db-server.mjs`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOVEL_READER_API_HOST` | `127.0.0.1` | API 服务监听地址 |
| `NOVEL_READER_API_PORT` | `5174` | API 服务监听端口 |
| `NOVEL_READER_DATA_DIR` | `~/.novel_reader` | 应用数据目录 |
| `NOVEL_READER_DB_PATH` | `<dataDir>/novel_reader.sqlite` | SQLite 数据库完整路径 |

### 离线扫描器（`scripts/offline-scanner.mjs`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOVEL_READER_OFFLINE_DB` | `~/.novel_reader/offline.sqlite` | 离线扫描器数据库 |
| `NOVEL_READER_MAIN_DB` | `~/.novel_reader/novel_reader.sqlite` | 主应用数据库 |
| `NOVEL_READER_OFFLINE_CONFIG` | `~/.novel_reader/offline-config.json` | 扫描器配置文件 |
| `OFFLINE_AI_PROVIDER` | — | 覆盖提供商：`ollama` 或 `openai` |
| `OFFLINE_OLLAMA_MODEL` | — | 覆盖 Ollama 模型 |
| `OFFLINE_OLLAMA_CONCURRENCY` | — | 覆盖 Ollama 并发数（1-10） |
| `OFFLINE_OLLAMA_BASE_URL` | — | 覆盖 Ollama Base URL |
| `OFFLINE_OPENAI_MODEL` | — | 覆盖 OpenAI 模型 |
| `OFFLINE_OPENAI_CONCURRENCY` | — | 覆盖 OpenAI 并发数（1-10） |
| `OFFLINE_OPENAI_BASE_URL` | — | 覆盖 OpenAI Base URL |
| `OFFLINE_OPENAI_API_KEY` | — | 覆盖 OpenAI API Key |
| `OFFLINE_REQUEST_TIMEOUT_MS` | `300000` | 覆盖单次请求超时 |

## 项目结构

```text
novel_reader/
├── index.html              # Vite HTML 入口
├── package.json            # npm 脚本与依赖
├── vite.config.ts          # Vite 配置
├── tsconfig*.json          # TypeScript 配置
├── eslint.config.js        # ESLint 配置
├── scripts/                # Node.js 后端与 CLI 工具
│   ├── dev.mjs             # 同时启动 Vite + API
│   ├── local-db-server.mjs # SQLite REST API 服务
│   ├── offline-scanner.mjs # 离线批量扫描器 CLI
│   └── offline-scanner/    # 扫描器模块（config、db、llm、scanner）
├── src/                    # React 前端
│   ├── main.tsx            # 入口（桌面/移动路由）
│   ├── App.tsx             # 桌面端主 UI
│   ├── MobileApp.tsx       # 移动端 UI
│   ├── hooks/              # React hooks
│   └── assets/             # 静态资源
├── public/                 # 公共静态文件
└── docs/                   # 文档
```

## 数据库

项目使用 Node.js 原生 `node:sqlite` 模块（`DatabaseSync`）。

- 默认数据库路径：`~/.novel_reader/novel_reader.sqlite`
- 日志模式：`WAL`
- 外键约束：已启用

主要数据表：

- `books`、`chapters` — 导入的书籍与章节
- `summaries` — 章节概要与页面概要
- `kg_scan_jobs`、`kg_chapter_extractions` — 知识图谱扫描状态
- `kg_entities`、`kg_entity_mentions` — 抽取的实体
- `kg_relations`、`kg_relation_mentions` — 抽取的关系
- `app_state` — 应用设置与模型配置

## 知识图谱

知识图谱以 SQLite 上的属性图方式实现。

- 扫描流程：`章节文本 -> LLM 抽取 -> 原始 JSON -> 归一化 -> 写入实体/关系`
- 扫描任务可断点续传。应用启动时会自动恢复 pending 任务。
- 低置信度的实体和关系会在 UI 中标记为待复审。
- 已保存的章节 extraction 可通过重放接口重新写入图谱，用于局部重建；覆盖重扫会重新调用模型并替换对应章节证据。

完整路线图见 [knowledge-graph-roadmap.md](knowledge-graph-roadmap.md)。

## 离线扫描器

离线扫描器是一个在浏览器外批量处理章节概要或知识图谱抽取的 CLI 工具。

典型工作流：

```bash
# 1. 从主数据库导入书籍
node scripts/offline-scanner.mjs import <bookId>

# 2. 扫描概要、知识图谱或两者
node scripts/offline-scanner.mjs scan all <bookId>

# 3. 如被中断，可恢复
node scripts/offline-scanner.mjs resume all <bookId>

# 4. 将结果导回主数据库
node scripts/offline-scanner.mjs export <bookId>
```

命令列表：

| 命令 | 参数 | 说明 |
|------|------|------|
| `list` | — | 列出主数据库中的书籍 |
| `import` | `<bookId>` | 导入书籍到离线数据库 |
| `scan` | `<summary\|kg\|all> <bookId>` | 创建并运行扫描任务 |
| `resume` | `<summary\|kg\|all> <bookId>` | 恢复中断的扫描任务 |
| `status` | `[bookId]` | 查看进度 |
| `export` | `<bookId>` | 导出结果到主数据库 |
| `sync` | — | 从主项目同步模型配置 |
| `config` | — | 显示当前模型配置 |
| `stop` | — | 发送优雅停止信号 |
| `help` | — | 显示帮助 |

### 离线扫描器排错

如果某些章节出现 `fetch failed`：

- 扫描器已内置对瞬态网络错误的重试，最多 3 次，指数退避。
- 增加单次请求超时：
  ```bash
  OFFLINE_REQUEST_TIMEOUT_MS=600000 node scripts/offline-scanner.mjs resume kg <bookId>
  ```
- 如果本地 Ollama 负载过高，可降低并发：
  ```bash
  OFFLINE_OLLAMA_CONCURRENCY=3 node scripts/offline-scanner.mjs resume kg <bookId>
  ```

## Lint 与构建

```bash
npm run lint
npm run build
```

`useReaderState.ts` 和 `App.tsx` 中目前存在少量预先存在的 ESLint warning/error。TypeScript 编译和 Vite 构建应都能通过。

## 注意事项

- 这是一个个人本地应用，API Key 以明文形式存储在 SQLite 中。请勿将 API 服务或数据库暴露给不受信任的网络。
- 离线扫描器与 Web 端通过主数据库的 `app_state` 表共享同一份模型配置。
