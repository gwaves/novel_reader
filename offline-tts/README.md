# 离线多角色 TTS

这个目录用于开发 PC 端离线批处理工具：把小说章节转换成“导演脚本”，再基于脚本做多角色 TTS 合成。

第一阶段的目标不是直接合成整章音频，而是先稳定生成可检查的导演脚本：

```text
章节正文 -> 规则预切分 -> 知识图谱候选角色 -> 第三方大模型角色判定 -> 导演脚本 JSON
```

后续 TTS 合成只消费导演脚本，不再直接猜测原文中的角色。

## 文件说明

- `docs/design.md`：总体设计与数据结构。
- `docs/development-plan.md`：分阶段开发计划。
- `docs/mp3-production.md`：章节 MP3 生产、输出目录和移动端同步说明。
- `config.example.json`：本地模型、音色和 TTS 示例配置。
- `scripts/tts-director.mjs`：Node.js CLI，负责导演脚本生成与校验。

## 快速开始

建议把实际配置放在用户数据目录，避免把私有配置提交到仓库：

```bash
cp offline-tts/config.example.json ~/.novel_reader/tts-director.config.json
```

当前可用的大模型配置：

```json
{
  "llm": {
    "baseUrl": "http://192.168.88.24:30000/v1",
    "model_name": "qwen3.6-27b",
    "apiKey": null
  }
}
```

测试模型：

```bash
node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json test-model
```

列出主数据库书籍：

```bash
node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json list-books
```

生成《妖刀记》第 1 章短片段导演脚本：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config offline-tts/config.example.json \
  draft-script \
  --book-id 9679077f-2288-4bc7-9080-854784fc7f94 \
  --chapter 1 \
  --allow-partial \
  --limit 2000 \
  --batch-size 30 \
  --concurrency 10 \
  --out tmp/tts/yaodao/ch001/director-script.json
```

校验导演脚本：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config offline-tts/config.example.json \
  validate-script \
  --script tmp/tts/yaodao/ch001/director-script.json
```

合成音频并输出 MP3：

```bash
MIMO_API_KEY=你的密钥 \
node offline-tts/scripts/tts-director.mjs \
  --config offline-tts/config.example.json \
  synth \
  --script tmp/tts/yaodao/ch001/director-script.json
```

可以通过配置文件 `tts.concurrency` 或命令行参数控制 TTS 并发：

```bash
node offline-tts/scripts/tts-director.mjs synth \
  --script tmp/tts/yaodao/ch001/director-script.json \
  --out-dir tmp/tts/yaodao/ch001/audio-c3 \
  --concurrency 8
```

批量生成多章时，推荐使用流水线模式，避免多个章节同时压住本地 LLM：

```bash
node offline-tts/scripts/tts-director.mjs batch-pipeline \
  --book-id 9679077f-2288-4bc7-9080-854784fc7f94 \
  --chapters 19,21-24 \
  --batch-size 10 \
  --director-concurrency 3 \
  --min-batch-size 6 \
  --tts-concurrency 16 \
  --tts-chapters 2 \
  --resume \
  --out-root tmp/tts/yaodao
```

这个命令会让章节的 LLM 阶段串行执行；当前一章进入 TTS 阶段后，下一章会立刻开始生成导演脚本。TTS 阶段可按章节并发，默认最多同时合成 2 章。

生产建议：

- `--resume` 会跳过已完成的 `chapter.mp3`，并复用已通过校验的 `director-script.json`。
- 正式生产不要传 `--limit`；默认就是整章生产。`--limit` 只用于调试小样，并且必须同时传 `--allow-partial`。
- LLM 批次会自动重试；如果整章脚本生成失败，流水线会降低 batch size 和 LLM 并发后重试。
- 每章会生成 `director-script.audit.json`，统计未知角色、默认音色、疑似错别字 speaker 和别名 speaker。
- 当前实测更稳的 LLM 参数是 `--batch-size 10 --director-concurrency 3`；不要盲目提高到 10 并发。
- 当前推荐的 TTS 参数是 `--tts-concurrency 16 --tts-chapters 2`；脚本默认开启自适应降档，服务波动或排障时可降到 `--tts-concurrency 8 --tts-chapters 2`。

完整的 MP3 生产流程、产物目录结构和移动端配置方式见：

```text
offline-tts/docs/mp3-production.md
```

单独检查导演脚本质量：

```bash
node offline-tts/scripts/tts-director.mjs audit-script \
  --script tmp/tts/yaodao/ch030-full/director-script.json
```

## 边界

- Codex 只负责开发和调试工具，不负责批量大模型推理。
- 批量推理由本地 Node.js 程序按配置调用第三方 OpenAI-compatible 模型。
- API key 为 `null` 或空字符串时，请求不会携带鉴权头。
- MIMO TTS 是后续合成适配器，输入是导演脚本而不是原始小说正文。
