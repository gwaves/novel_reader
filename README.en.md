# Novel Reader Assistant

[English](README.en.md) | [中文](README.md)

Novel Reader Assistant is an **AI-native novel reader** for long-form fiction. It turns a local book into a connected reading experience: chapter summaries, a story knowledge graph, RAG answers grounded in the text, multi-role AI audiobook production, and a Gateway Android app for offline reading and listening. The production pipeline adds a durable queue, resumable jobs, layered recovery, and end-to-end publishing verification.

![Novel Reader Assistant visual](src/assets/hero.png)

## Core Value

- **AI-native reading**: read chapters, recover progress, inspect summaries, and jump from AI evidence back to the text.
- **Knowledge graph**: track characters, factions, items, skills, locations, events, relations, aliases, evidence, and review queues.
- **RAG for fiction**: retrieve chapter summaries, body chunks, and graph evidence to answer cross-chapter plot questions.
- **Multi-role audiobooks**: use `production-pipeline` to generate director scripts, synthesize multi-role MP3 chapters, and publish timeline manifests for text highlighting.
- **Multi-provider TTS**: choose MIMO or Volcano Engine Seed TTS 2.0, with a book-wide voice cast and Chinese-language voice filtering.
- **Mobile offline mode**: Gateway Android caches book packages, summaries, graph data, RAG search, MP3 audio, playback manifests, and reading progress; chapter playback continues automatically while the phone is locked.
- **Production loop**: `import -> summary -> kg -> embedding -> audio -> package -> publish -> verify` keeps generated content traceable and Gateway-visible, with durable retries and resumable checkpoints.

## Recent Improvements

- MIMO and Seed TTS 2.0 can be configured independently, including credentials, narrator voices, and catalogs.
- A book-wide `voice-cast.json` keeps major characters on consistent voices across chapters.
- Chinese audiobook jobs expose only Chinese voices to casting and synthesis, while retaining each provider's complete catalog.
- The persistent production service survives restarts, limits concurrency, retries with exponential backoff, and preserves run/item state and logs.
- Normal failures use built-in retry/resume first; terminal failures can be inspected by the isolated Hermes Rescue workflow, with an optional Codex outer watchdog for stalled recovery.
- The Android WebView may start the next chapter's MP3 from a chapter-load callback while the device is locked, removing the previous manual-resume step.

## *Dream of the Red Chamber* Production DAG

![128-chapter production DAG preview for Dream of the Red Chamber](docs/screenshots/production-dag-honglou.png)

This preview uses the 128-chapter production template for the public-domain classic *Dream of the Red Chamber*. The console checks the seven-stage DAG—summary, knowledge graph, vector index, audiobook, package, publish, and verify—together with concurrency, estimated cost, and external-write risks before launch.

## Real UI Preview

Desktop screenshots use isolated public-domain demo data from *Romance of the Three Kingdoms* and *Journey to the West*. Mobile screenshots are captured from the Gateway Android app with public-domain classics only.

![Demo library home](docs/screenshots/demo-home-library.png)
![Demo reader](docs/screenshots/demo-reader.png)
![Demo smart search](docs/screenshots/demo-search.png)

| Mobile library | Chapter summary | RAG / graph search |
|----------------|-----------------|--------------------|
| <img src="docs/screenshots/mobile/mobile-library.png" alt="Gateway Android library" width="220"> | <img src="docs/screenshots/mobile/mobile-reader-summary.png" alt="Mobile chapter summary" width="220"> | <img src="docs/screenshots/mobile/mobile-search-rag.png" alt="Mobile RAG and graph search" width="220"> |

| Audio menu | Sync and cache |
|------------|----------------|
| <img src="docs/screenshots/mobile/mobile-audio-menu.png" alt="Mobile audio playback menu" width="220"> | <img src="docs/screenshots/mobile/mobile-sync-cache.png" alt="Mobile sync and cache" width="220"> |

## Quick Start

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

The local SQLite database is stored at:

```text
~/.novel_reader/novel_reader.sqlite
```

## Gateway Android

Start a local Gateway service:

```bash
npm run gateway:dev
```

Build the Android debug APK:

```bash
npm --prefix gateway-android-app install
npm run gateway-android:android:build
```

Debug APK output:

```text
gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v<versionName>-debug.apk
```

Publish it to Gateway downloads:

```bash
npm run gateway:publish-android-apk
```

The stable download URL is `/downloads/novel_gateway.apk`.

No additional Android or Gateway setting is required for locked-screen chapter continuation; rebuild and publish the APK after updating the client.

## Production Pipeline

Run a preflight check and a resumable production job:

```bash
npm run production-pipeline -- doctor --job production-pipeline/config/example.job.json
npm run production-pipeline -- run --job production-pipeline/config/example.job.json
npm run production-pipeline -- status --run <runId|runDir|run.json>
```

Start the durable queue and web console at `http://127.0.0.1:6290`:

```bash
npm run production-pipeline:service
```

The service handles ordinary retry/resume recovery. Hermes Rescue can inspect jobs after automatic retries are exhausted, while the optional Codex production monitor watches service health, terminal failure, and repeated no-progress snapshots. See the deployment guides below for the security boundaries and cron setup.

## Documentation

- [Chinese README](README.md)
- [Product Spec](docs/product-spec.md)
- [Development Guide](docs/development.md)
- [Gateway Android App Guide](gateway-android-app/README.md)
- [Gateway Deployment Guide](gateway/docs/deployment.md)
- [Production Pipeline](production-pipeline/README.md)
- [Persistent Production Service Deployment and Codex Watchdog](production-pipeline/docs/service-deployment.md)
- [Multi-role TTS and Book-wide Voice Casting](production-pipeline/docs/tts/README.md)
- [Hermes Rescue Deployment](production-pipeline/docs/hermes-rescue.md)
- [Current Progress](docs/current_progress.md)

## Build

```bash
npm run build
```

## Notes

The PC reader remains a local-first development surface: API keys and book data are stored in the local SQLite database. Do not expose the local dev API publicly. For mobile and shared access, publish curated packages and audio through Gateway with separate admin/mobile tokens.
