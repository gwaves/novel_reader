# Novel Reader Assistant

A local-first web reader for long Chinese web novels.

## Features

- Import `.txt` novels with automatic UTF-8 / GB18030 decoding.
- Split long novels into chapters and paginate the chapter list by 100 chapters.
- Persist imported chapters, reading progress, summaries, and settings in browser IndexedDB.
- Generate single-chapter or current-page summaries.
- Configure local Ollama models and OpenAI-compatible external models.
- Support multiple external model profiles, each with its own model name, base URL, API key, temperature, and thinking mode.
- Adjust reader font size.

## Development

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

You can change the dev server port:

```bash
NOVEL_READER_PORT=5174 npm run dev
```

## Reader Instance

To run a separate local reading instance without occupying the development port:

```bash
NOVEL_READER_PORT=6173 npm run reader:build
```

Open:

```text
http://127.0.0.1:6173/
```

You can also customize the host:

```bash
NOVEL_READER_HOST=0.0.0.0 NOVEL_READER_PORT=6173 npm run reader:build
```

## Build

```bash
npm run build
```

## Notes

This is currently a personal local web app. API keys are stored in the browser's local IndexedDB, so do not use this deployment model for a public multi-user service without adding a backend proxy and secret management.
