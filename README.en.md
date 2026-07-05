# Novel Reader Assistant

[English](README.en.md) | [中文](README.md)

Novel Reader Assistant is an **AI-native novel reader** for long-form fiction. It turns a local book into a connected reading experience: chapter summaries, a story knowledge graph, RAG answers grounded in the text, multi-role AI audiobook production, and a Gateway Android app for offline reading and listening.

![Novel Reader Assistant visual](src/assets/hero.png)

## Core Value

- **AI-native reading**: read chapters, recover progress, inspect summaries, and jump from AI evidence back to the text.
- **Knowledge graph**: track characters, factions, items, skills, locations, events, relations, aliases, evidence, and review queues.
- **RAG for fiction**: retrieve chapter summaries, body chunks, and graph evidence to answer cross-chapter plot questions.
- **Multi-role audiobooks**: use `production-pipeline` to generate director scripts, synthesize multi-role MP3 chapters, and publish timeline manifests for text highlighting.
- **Mobile offline mode**: Gateway Android caches book packages, summaries, graph data, RAG search, MP3 audio, playback manifests, and reading progress.
- **Production loop**: `import -> summary -> kg -> embedding -> audio -> package -> publish -> verify` keeps generated content traceable and Gateway-visible.

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

## Documentation

- [Chinese README](README.md)
- [Product Spec](docs/product-spec.md)
- [Development Guide](docs/development.md)
- [Gateway Android App Guide](gateway-android-app/README.md)
- [Gateway Deployment Guide](gateway/docs/deployment.md)
- [Production Pipeline](production-pipeline/README.md)
- [Current Progress](docs/current_progress.md)

## Build

```bash
npm run build
```

## Notes

The PC reader remains a local-first development surface: API keys and book data are stored in the local SQLite database. Do not expose the local dev API publicly. For mobile and shared access, publish curated packages and audio through Gateway with separate admin/mobile tokens.
