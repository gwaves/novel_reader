# 离线多角色 TTS 设计

## 目标

构建一个本地批处理流水线，把已导入的小说章节转换为多角色有声书音频。

核心中间产物是“导演脚本”。它负责标注每个朗读片段的类型、说话人、音色、风格、置信度和依据。TTS 合成阶段只消费导演脚本，不再直接从小说原文里猜角色。

## 非目标

- 不做线上服务。
- 不使用 Codex 进行批量大模型推理。
- 在导演脚本可检查、可校验之前，不直接合成整章音频。
- 不允许把引号内对白和引号外旁白混成同一个 TTS 片段。

## 运行环境

主流程使用 Node.js。

原因：

- 项目已有 Node.js 脚本和 `node:sqlite` 使用基础。
- OpenAI-compatible 大模型和 MIMO TTS 都可以直接用 Node 原生 `fetch` 调用。
- 导演脚本是 JSON，Node.js 处理和校验成本低。
- 后续音频拼接可以由 Node.js 调用 `ffmpeg`。

Python 暂时不作为主流程依赖。后续如果需要复杂音频分析或本地 ML 模型，再作为辅助子命令加入。

## 流水线

```text
Novel Reader SQLite
  -> 章节读取
  -> 规则预切分
  -> 知识图谱候选角色读取
  -> 第三方大模型生成角色判定 JSON
  -> 程序回填原文并组装导演脚本
  -> JSON 校验
  -> 人工抽查 / 低置信度复核
  -> TTS 合成
  -> 音频拼接与 MP3 编码
```

## 配置

配置使用本地 JSON 文件。当前模型配置如下：

```json
{
  "llm": {
    "baseUrl": "http://192.168.88.24:30000/v1",
    "model_name": "qwen3.6-27b",
    "apiKey": null
  }
}
```

字段说明：

- `baseUrl` / `base_url`：OpenAI-compatible 服务地址。
- `model` / `model_name` / `modelName`：模型名。
- `apiKey`：可选；为 `null`、空字符串或 `"null"` 时不带鉴权头。
- `apiKeyEnv`：可选；从环境变量读取 API key。
- `temperature`：建议 `0.1` 到 `0.3`。
- `timeoutMs`：本地或局域网模型推理可能较慢，默认 180 秒。
- `maxTokens`：限制模型输出长度，默认 8192。
- `responseFormatJson`：仅在服务确定支持 `response_format` 时开启。

`director.performanceStyle` 用于统一整章 TTS 的节奏和表演方向，例如：

```text
按照中文有声小说的朗读语速和节奏，整体语速略快，吐字清晰，节奏紧凑但不抢字；旁白保留必要停顿，对白保留角色表演感。
```

合成时会把该公共提示放在每个片段的角色风格前面，保证整章节奏一致。

`director.segmentBatchSize` 控制导演脚本生成时每次提交给模型的预切分片段数。整章单次请求容易超时或产生过长 JSON，默认按 30 段分批生成判定，再由程序合并回完整导演脚本。

`director.concurrency` 或 `draft-script --concurrency` 控制导演脚本生成阶段的 LLM 批次并发。程序会并发请求多个批次，但按原始批次顺序合并判定结果，避免片段乱序。

## 批量流水线策略

批量生成多章时，不建议让多个章节同时进入 LLM 阶段。实测多个 agent 同时以高并发调用本地 LLM，容易导致模型服务卡死或触发超时；但 TTS 阶段使用的是另一类服务，可以和下一章的 LLM 阶段重叠。

`batch-pipeline` 命令采用两阶段流水线：

1. LLM 阶段按章节串行执行，单章内部仍可用 `--director-concurrency` 控制批次并发。
2. 每章导演脚本生成并校验后，立即启动该章 TTS。
3. TTS 阶段按章节并发，`--tts-chapters` 控制同时合成的章节数，`--tts-concurrency` 控制每章片段并发。
4. 主流程继续处理下一章 LLM，从而实现“上一章 TTS + 下一章 LLM”的重叠。

这比多个 agent 全量并发更稳定，也比完全串行更高效。

## 导演脚本结构

```json
{
  "kind": "novel-reader-tts-director-script",
  "version": 1,
  "source": {
    "bookId": "9679077f-2288-4bc7-9080-854784fc7f94",
    "bookTitle": "妖刀记",
    "chapterId": "1-...",
    "chapterIndex": 1,
    "chapterTitle": "第1卷第1章：寄魂妖刀，四大剑门",
    "sourceLimit": 2000
  },
  "segments": [
    {
      "id": "ch001-s0001",
      "preSegmentId": "pre-0001",
      "type": "narration",
      "speaker": "旁白",
      "characterId": null,
      "voice": "白桦",
      "style": "中文武侠小说男声旁白，低沉、清晰、平静。",
      "text": "东海湖阴城郊，断肠湖南岸。",
      "sourceStart": 0,
      "sourceEnd": 14,
      "confidence": 1,
      "evidence": "规则切分：引号外旁白。"
    }
  ],
  "diagnostics": {
    "generatedAt": "2026-06-23T00:00:00.000Z",
    "validationErrors": [],
    "validationWarnings": []
  }
}
```

片段类型：

- `narration`：旁白，当前默认使用男声 `白桦`。
- `dialogue`：引号内对白。
- `thought`：内心独白或括号内心理活动。
- `stage`：暂不朗读的导演说明，后续保留扩展。

## 角色绑定

角色判定结合以下信息：

- 配置文件中的角色音色绑定。
- 知识图谱 `kg_entities.aliases_json` 中的人物别名。
- 人物在当前章节的出现范围。
- 对白前后的上下文，例如“某某道”“某某叹道”“被唤作某某”。
- 大模型输出的依据和置信度。

大模型不得编造角色。不确定时必须输出 `speaker: "未知角色"`，且置信度不得高于 `0.45`。

## 模型输出策略

为了避免模型改写小说原文，模型不直接生成最终导演脚本。程序先做预切分，并把每个片段的 `preSegmentId`、文本和上下文交给模型。

模型只输出判定结果：

```json
{
  "decisions": [
    {
      "preSegmentId": "pre-0001",
      "type": "dialogue",
      "speaker": "黄缨",
      "characterId": null,
      "voice": "冰糖",
      "style": "慵懒、俏皮，略带挑衅。",
      "confidence": 0.86,
      "evidence": "下文直接写到黄缨回应。"
    }
  ]
}
```

最终 `text`、`sourceStart`、`sourceEnd` 由程序从预切分结果回填，保证原文不被模型改动。

## 校验规则

生成器必须检查：

- `kind` 是否正确。
- `segments` 是否为数组。
- 是否缺少或重复 segment ID。
- `type` 是否非法。
- `text` 是否为空。
- 旁白是否错误绑定为人物。
- 未知角色置信度是否过高。
- 脚本文本是否与预切分原文一致。

## TTS 适配器

第一目标 TTS 适配器是 MIMO。调用方式：

- `messages[0].role = "user"` 放入片段风格和导演说明。
- `messages[1].role = "assistant"` 放入需要合成的原文文本。
- `audio.voice` 来自导演脚本中的 `voice`。

每个片段的合成结果按 segment ID 和文本 hash 缓存，便于失败后断点续跑。

TTS 合成支持并发控制。并发只用于缺失缓存的片段合成，标准化、拼接和 MP3 编码仍按脚本顺序串行执行，避免音频顺序错乱。

## 音色设计策略

MIMO V2.5 TTS 有三类模型：

- `mimo-v2.5-tts`：使用预置音色，适合当前稳定链路。
- `mimo-v2.5-tts-voicedesign`：通过文本描述自动生成音色，不使用预置音色。
- `mimo-v2.5-tts-voiceclone`：通过音频样本复刻音色。

`voicedesign` 值得用于角色音色实验，尤其是当预置女声音龄不够贴合角色时。但它不是“先创建一个稳定 voice id，再复用该 voice id”的流程，而是每次合成时根据文本描述生成声音。因此正式接入前必须验证：

- 同一角色跨多个片段的声线是否稳定。
- 并发调用时同一角色的音色是否会明显漂移。
- 角色描述和片段文本是否会互相影响，导致同一角色在不同情绪下变成不同声底。

推荐后续新增单独模式：

```json
{
  "voiceMode": "preset|design",
  "voiceDesignPrompt": "十七八岁少女声线，甜亮、俏皮、慵懒..."
}
```

第一步只对采蓝、黄缨各抽取 2 到 3 个片段做 A/B 实验，不直接替换整章稳定链路。

## 音频输出

片段合成阶段可以使用 WAV 作为中间格式，因为 WAV 无损且便于 `ffmpeg` 拼接。

最终章节或整书音频默认编码为 MP3，避免磁盘空间浪费：

```text
片段 WAV 缓存 -> 标准化章节 WAV -> 章节 MP3
```

默认 MP3 策略：

- 编码器：`libmp3lame`
- 比特率：`96k`
- 用途：小说朗读、听书类内容

标准化 WAV 默认作为临时文件，除非开启调试保留。
