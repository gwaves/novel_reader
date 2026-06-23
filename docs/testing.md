# Testing Strategy

This project now has a two-layer smoke and regression foundation:

- Unit tests cover deterministic reader logic: chapter splitting, state migration, config sanitization, word counts, and title inference.
- End-to-end tests cover the browser-facing happy path with mocked local services: first launch, TXT import, reader navigation, chapter search, smart-search page, and RAG result rendering.

## Commands

```bash
npm run test:unit
npm run test:e2e
npm run test:smoke
```

`npm run test:smoke` is the first CI candidate. It runs fast logic tests first, then launches a Vite server on `127.0.0.1:4173` for Playwright.

## Core Regression Flows

The current automated suite protects these flows:

1. Open a clean app with no SQLite state available.
2. Import a TXT novel with regular Chinese chapter headings.
3. Confirm the app opens the reader and shows the imported book.
4. Navigate between chapters.
5. Search the chapter list by title keyword.
6. Open smart search with mocked embedding coverage.
7. Submit a RAG query and render mocked results.
8. Normalize older stored state into the current multi-book library shape.
9. Clamp invalid reader/config values to safe ranges.
10. Preserve important TXT splitting behavior, including `正文 第一回` headings.

## Agent Checklist

For a semi-automated agent run, use this order:

1. Run `git status --short --branch` and note whether the tree is clean.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm run test:unit`.
5. Run `npm run test:e2e`.
6. If Playwright reports missing browser binaries, run `npx playwright install chromium` once, then retry `npm run test:e2e`.
7. Summarize failures by flow, not only by command.

## CI Notes

Recommended first CI split:

- `lint-build-unit`: `npm run lint && npm run build && npm run test:unit`
- `smoke-e2e`: `npm run test:e2e`

Keep local database and LLM calls mocked for smoke tests. Add real SQLite/API integration tests separately so CI remains predictable.
