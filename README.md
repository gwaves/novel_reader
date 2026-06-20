# 小说阅读助手

[English](README.en.md) | [中文](README.md)

本地优先的中文长篇小说阅读器，支持 AI 生成章节概要，以及用于追踪人物、门派、道具、功法、地点、灵兽、事件等的小说知识图谱。所有数据默认保存在本地 SQLite 数据库中，无需联网即可阅读，AI 功能按需调用本地或外部模型。

## 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [详细功能使用说明](#详细功能使用说明)
  - [1. 导入小说](#1-导入小说)
  - [2. 阅读器](#2-阅读器)
  - [3. AI 模型配置](#3-ai-模型配置)
  - [4. 概要生成](#4-概要生成)
  - [5. 知识图谱](#5-知识图谱)
  - [6. RAG 智能搜索](#6-rag-智能搜索)
  - [7. 数据库备份与恢复](#7-数据库备份与恢复)
  - [8. 离线扫描器 CLI](#8-离线扫描器-cli)
- [开发与部署](#开发与部署)
- [项目结构](#项目结构)
- [注意事项](#注意事项)

## 功能概览

- **本地阅读**：导入 `.txt` 或 `.epub` 小说文件；txt 自动识别 UTF-8 / GB18030 编码并按标题拆章，epub 按 OPF spine 导入 XHTML 章节，章节列表按每 100 章分页。
- **阅读体验**：方向键或顶部/底部按钮翻页，可调字体大小，阅读进度自动保存，切换章节后自动回到章节顶部。
- **AI 概要**：为单章、当前页或全书缺失章节生成概要，帮助快速回顾剧情。
- **RAG 智能搜索**：基于章节概要 embedding 与知识图谱实体召回，跨章节搜索剧情并生成回答。
- **知识图谱**：从章节中抽取实体与关系，支持扫描、重扫预览、raw extraction 重放、实体/关系维护、LLM 全局共指合并、证据搜索、图谱可视化、JSON/GraphML 导出，以及低置信度复审队列。
- **多模型配置**：同时配置本地 Ollama 与多个兼容 OpenAI 的外部模型，并为生成模型和 embedding 模型分别校验。
- **离线扫描器**：在浏览器外批量处理概要或知识图谱任务，支持中断续扫并导回主数据库。
- **数据本地存储与备份**：导入的章节、阅读进度、概要、设置、知识图谱、embedding 全部持久化到本地 SQLite，并支持浏览器内导出/恢复完整数据库。

## 快速开始

```bash
npm install
npm run dev
```

这会同时启动 Vite 前端和本地 SQLite API 服务：

- 前端：http://127.0.0.1:5173/
- API 服务：http://127.0.0.1:5174/

打开浏览器访问前端地址即可开始使用。

数据库默认保存在：

```text
~/.novel_reader/novel_reader.sqlite
```

## 详细功能使用说明

### 1. 导入小说

1. 打开前端页面，点击导入按钮，选择本地 `.txt` 或 `.epub` 小说文件。
2. txt 会自动检测文件编码（UTF-8 或 GB18030）；epub 会读取 `META-INF/container.xml`、OPF manifest/spine 和 XHTML 正文。
3. 导入后，小说会被拆分为章节，章节列表按每 100 章分页显示。当前 epub 先导入纯文本章节，不保留原书图片和排版样式。
4. 点击任意章节即可开始阅读。

### 2. 阅读器

- **翻页**：使用键盘左右方向键，或点击章节顶部/正文底部的上一章/下一章按钮。
- **字体大小**：在阅读器设置中调整字体大小。
- **阅读进度**：当前阅读位置会自动保存，下次打开同一本书会自动恢复。
- **章节跳转**：在侧边章节列表中点击目标章节，或在 AI/概要面板中点击证据章节链接直接跳转。
- **概要查看**：桌面端在 AI 面板查看当前章或当前页概要，移动端可在概要页查看。

### 3. AI 模型配置

进入设置页面配置 AI 模型：

- **本地 Ollama**：填写 Ollama 地址（如 `http://127.0.0.1:11434`）和模型名（如 `qwen2.5:14b`）。
- **外部 OpenAI 兼容模型**：填写 Base URL、API Key、模型名、Temperature，可选择是否开启思考模式。
- **多组配置**：可保存多组外部模型配置，每组独立设置，方便在不同任务间切换。
- **Embedding 模型**：可为 RAG 搜索单独配置 Ollama 或 OpenAI-compatible embedding 模型；保存配置时会通过本地后端校验 embedding 可用性和向量维度，避免浏览器 CORS 限制。
- **Temperature**：控制生成随机性，值越低结果越稳定，推荐概要/抽取任务使用较低温度。
- **思考模式**：部分模型支持先思考再输出，适合复杂抽取任务。

配置完成后，在 AI 面板选择要使用的模型即可。

### 4. 概要生成

- **单章概要**：在当前章节阅读界面，点击 AI 面板中的生成按钮，为当前章生成概要。
- **当前页概要**：为当前章节列表页（100 章范围）生成一页概要，便于快速把握大段剧情。
- **批量生成全书缺失概要**：
  - 在 AI 面板或移动端概要页点击“批量生成全书缺失概要”。
  - 系统会过滤全书中还没有概要的章节，使用当前并发设置批量调用 AI 生成。
  - 缺失章节超过 50 章时会弹出确认对话框，避免误触产生大量模型调用。
  - 单个章节失败不会中断整批任务，最后会报告成功/失败数量。
- 已生成的概要会保存在本地数据库，无需重复调用模型。

### 5. 知识图谱

知识图谱帮助你在阅读长篇小说的过程中自动整理人物、门派、道具、功法、地点、灵兽、事件等实体，以及它们之间的关系。

#### 5.1 扫描章节

进入“知识图谱”页面：

- **扫描当前章节**：仅抽取当前阅读章节的内容。
- **扫描范围**：指定起始和结束章节号，批量抽取一段章节。
- **扫描全书**：为整本书创建扫描任务，并发处理所有章节。
- **断点续传**：扫描过程中刷新页面或关闭浏览器后，应用启动时会自动恢复 pending 的扫描任务。
- **停止扫描**：扫描过程中会显示“停止扫描”按钮，点击后worker 会在处理完当前章节后退出，任务状态记为 `cancelled`。
- **跳过已扫描**：重新扫描时会自动跳过已完成的章节，不会重复调用模型。
- **覆盖重扫**：勾选“覆盖已完成章节”后可重新调用模型替换对应章节的图谱证据。
- **重放已保存 JSON**：不调用模型，直接用已保存的章节 extraction 重建局部图谱。
- **变化预览**：可先预览重扫会新增、更新、删除的实体/关系变化，确认后再写入图谱。

扫描流程：

```text
章节文本 -> LLM 抽取 -> 保存章节级原始 JSON -> 归一化 -> 写入实体/关系
```

#### 5.2 实体管理

- **实体列表**：查看当前书籍抽取到的所有实体，支持按类型筛选（人物、门派、道具、功法、地点、灵兽、事件、其他），支持按名称或别名搜索。
- **实体详情**：点击实体进入详情页，可查看：
  - 实体名称、类型、别名、描述
  - 出现次数、关系次数
  - 首次/末次出现章节
  - 相关关系列表
  - 证据章节列表（可点击跳转到阅读器）
- **编辑实体**：修改实体的名称、类型、别名、描述。
- **合并实体**：
  - 在实体详情或实体列表中选择多个实体，合并到一个主实体。
  - 合并后，别名、出现记录、关系都会迁移到主实体。
  - 支持批量合并：在实体列表多选后一次性合并。
- **拆分实体**：
  - 在实体详情点击“拆分”，可从源实体拆出一个新实体，或拆到已有实体。
  - 支持选择要迁出的别名、出现章节、关系。
  - 拆分后会重新计算源实体和新实体的首次/末次出现章节。
- **删除实体**：删除不需要的实体及其相关数据。

#### 5.3 关系管理

- **关系列表**：查看所有抽取到的关系，支持按关系类型筛选。
- **关系详情**：查看关系的源实体、目标实体、类型、描述、证据章节列表。
- **编辑关系**：修改关系类型和描述。
- **切换源/目标实体**：
  - 在关系编辑弹窗中，可以把关系的 source 或 target 改成另一个实体。
  - 如果新端点 + 关系类型已存在，会把当前关系的证据迁移到已有关系并删除旧关系。
  - 禁止自环端点，禁止跨书实体作为端点。
- **删除关系**：删除错误的关系。

#### 5.4 图谱视图、搜索与导出

- **实体一跳关系图**：在实体详情中打开“关系图”，用 React Flow 查看该实体的一跳邻居和关系。
- **全局图谱视图**：在知识图谱页打开“图谱视图”，按实体类型和关系类型查看过滤后的全书关系网络，默认避免一次性渲染过大的全书图。
- **图谱证据搜索**：按关键词搜索实体提及、关系证据和章节标题，结果可跳转阅读器或详情页。
- **导出图谱**：支持导出当前书籍的知识图谱为 JSON 或 GraphML，便于备份、分析或导入其他图工具。

#### 5.5 全局共指合并

- **候选组件**：系统会基于角色名称、别名和出现范围找出疑似同一人物的实体组件。
- **LLM 判定**：可用当前生成模型批量判断同一组件内哪些实体应合并，适合清理“韩立/韩兄/厉飞雨”等角色别名或误拆实体。
- **安全合并**：合并时会迁移出现证据、别名和关系；如果关系发生冲突，会合并证据并清理旧关系。
- **任务进度**：共指处理作为独立 `coreference` 图谱任务记录进度，避免和章节扫描任务混在一起。

#### 5.6 复审队列

系统会自动标记低置信度或可疑的实体和关系，方便人工审核：

- **自动标记规则**：
  - 实体：置信度 < 0.6、类型为 other、名称过短、别名可疑、缺少描述。
  - 关系：置信度 < 0.6、类型为 related_to、缺少描述、自环。
- **复审面板**：在知识图谱页面点击“待复审”按钮打开复审队列。
  - 可按实体/关系筛选。
  - 支持批量选择，标记为已审、忽略、批量删除或编辑。
- **状态重置**：编辑、合并、拆分或重扫相关实体/关系后，系统会自动重置 `review_status`，以便重新进入复审判断。

### 6. RAG 智能搜索

RAG 搜索用于回答跨章节问题。它结合章节概要 embedding 的向量召回和知识图谱实体匹配，适合查找“某个人物什么时候出现”“某件道具后来去了哪里”“某段剧情前因后果”等问题。

使用流程：

1. 在模型配置中设置 embedding 提供商和 embedding 模型。
2. 进入“搜索”页面，查看当前书籍 embedding 覆盖率。
3. 如还有缺失章节，点击“生成 embedding”，系统会为已有概要的章节批量生成向量。
4. 输入问题并搜索，系统会返回相关章节、匹配实体、相似度/匹配类型和可选原文片段。
5. 有搜索结果后可点击“生成答案”，用当前聊天/生成模型基于检索结果生成回答。

注意：

- RAG 依赖章节概要；建议先批量生成全书缺失概要。
- embedding 覆盖率低于阈值时，搜索接口会提示先生成 embedding。
- 搜索结果会用知识图谱实体进行增强，因此图谱质量越好，跨章节检索越准确。

### 7. 数据库备份与恢复

首页提供完整 SQLite 数据库备份和恢复：

- **备份数据库**：导出当前 `novel_reader.sqlite`，包含书架、章节、概要、知识图谱、embedding 和设置。
- **恢复数据库**：上传一个 SQLite 备份文件。系统会先备份当前数据库，再把上传文件保存为待恢复文件。
- **重启生效**：恢复操作需要重启本地数据库服务，避免运行中的 SQLite 连接被直接替换。

### 8. 离线扫描器 CLI

`scripts/offline-scanner.mjs` 是一个在浏览器外批量处理概要或知识图谱抽取的 Node.js CLI 工具，适合整书扫描、长时间挂机或服务器环境。

#### 典型工作流

```bash
# 1. 查看主数据库中的书籍
node scripts/offline-scanner.mjs list

# 2. 导入指定书籍到离线数据库
node scripts/offline-scanner.mjs import <bookId>

# 3. 扫描概要、知识图谱或两者
node scripts/offline-scanner.mjs scan all <bookId>

# 4. 如被中断，可恢复任务
node scripts/offline-scanner.mjs resume all <bookId>

# 5. 查看进度
node scripts/offline-scanner.mjs status <bookId>

# 6. 将结果导回主数据库
node scripts/offline-scanner.mjs export <bookId>
```

#### 命令列表

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

#### 环境变量

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

#### 排错

- 扫描器已内置对瞬态网络错误的重试，最多 3 次，指数退避。
- 如果某些章节出现 `fetch failed`：
  - 增加单次请求超时：
    ```bash
    OFFLINE_REQUEST_TIMEOUT_MS=600000 node scripts/offline-scanner.mjs resume kg <bookId>
    ```
  - 如果本地 Ollama 负载过高，可降低并发：
    ```bash
    OFFLINE_OLLAMA_CONCURRENCY=3 node scripts/offline-scanner.mjs resume kg <bookId>
    ```

## 开发与部署

更多开发资料：

- [开发文档](docs/development.zh-CN.md)
- [Backend API Reference](docs/backend-api.md)
- [知识图谱路线图](docs/knowledge-graph-roadmap.md)
- [当前开发进展](docs/current_progress.md)

### npm 脚本

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

### 环境变量

#### 开发服务器（`scripts/dev.mjs`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOVEL_READER_HOST` | `0.0.0.0` | Vite 监听地址 |
| `NOVEL_READER_PORT` | `5173` | Vite 监听端口 |

#### API 服务（`scripts/local-db-server.mjs`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOVEL_READER_API_HOST` | `127.0.0.1` | API 服务监听地址 |
| `NOVEL_READER_API_PORT` | `5174` | API 服务监听端口 |
| `NOVEL_READER_DATA_DIR` | `~/.novel_reader` | 应用数据目录 |
| `NOVEL_READER_DB_PATH` | `<dataDir>/novel_reader.sqlite` | SQLite 数据库完整路径 |

### 修改端口或数据目录

```bash
# 修改开发服务器端口
NOVEL_READER_PORT=5174 npm run dev

# 修改数据目录或 API 端口
NOVEL_READER_DATA_DIR=/path/to/data NOVEL_READER_API_PORT=6174 npm run dev
```

### 独立阅读实例

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

### 构建

```bash
npm run lint
npm run build
```

`useReaderState.ts` 和 `App.tsx` 中目前存在少量预先存在的 ESLint warning/error。TypeScript 编译和 Vite 构建应都能通过。

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
│   ├── MobileApp.css       # 移动端样式
│   ├── hooks/              # React hooks
│   └── assets/             # 静态资源
├── public/                 # 公共静态文件
└── docs/                   # 文档
```

## 注意事项

- 这是一个个人本地 Web 应用。API Key 以明文形式存储在本地 SQLite 数据库中，因此在没有增加后端代理、身份认证和密钥管理之前，请勿将其作为公开多用户服务部署。
- 离线扫描器与 Web 端通过主数据库的 `app_state` 表共享同一份模型配置。
- 知识图谱的抽取质量取决于所选模型和提示词，建议对低置信度结果进行人工复审和纠错。
