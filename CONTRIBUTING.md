# Contributing

Thanks for your interest in improving Novel Reader Assistant. This project is still moving quickly, so small focused issues and pull requests are the easiest to review.

## Good First Contributions

- Improve setup notes, screenshots, or troubleshooting docs.
- Report import bugs with a minimal sample file and expected chapter split.
- Add tests or fixtures around EPUB/txt parsing, RAG retrieval, or knowledge graph cleanup.
- Polish mobile sync and Android build documentation for more device types.

## Local Development

```bash
npm install
npm run dev
```

The app starts a Vite frontend and a local SQLite API service. By default, data is stored in:

```text
~/.novel_reader/novel_reader.sqlite
```

Before opening a pull request, run:

```bash
npm run lint
npm run build
```

For Android changes, run the workspace checks that match your change. Gateway Android is the default maintained mobile client:

```bash
npm --prefix gateway-android-app install
npm --prefix gateway-android-app run test
npm --prefix gateway-android-app run build
```


## Pull Request Notes

- Keep PRs focused on one behavior or doc improvement.
- Include screenshots or short recordings for UI changes.
- Mention any model, embedding, or local database migration assumptions.
- Do not commit local database files, API keys, generated APKs, or personal test novels.

## Security And Privacy

This app stores imported books, reading progress, model settings, and API keys locally. If you find a security issue, please avoid posting exploit details in a public issue; open a minimal issue asking for a private contact path instead.
