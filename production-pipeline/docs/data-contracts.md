# Data Contracts

## Main Database

The production pipeline reads source data from the main SQLite database and writes
durable production results back to it.

Required source tables:

- `books`
- `chapters`

Durable output tables:

- summary tables used by the existing reader
- knowledge graph tables used by the existing reader
- `summary_embeddings`
- `chapter_chunk_embeddings`

Run status is not stored in the main database.

## Job Config

A job config is the declarative input for production.

```json
{
  "bookId": "mqxe7ya6-yiulrd3l",
  "title": "大唐双龙传",
  "source": {
    "type": "main-db",
    "mainDbPath": "~/.novel_reader/novel_reader.sqlite"
  },
  "stages": ["summary", "kg", "embedding", "audio", "package", "publish"],
  "embedding": {
    "provider": "openai-compatible",
    "baseUrl": "https://example.test/v1",
    "model": "embedding-model",
    "dimension": 4096,
    "concurrency": 16,
    "retries": 5
  },
  "audio": {
    "chapters": "all",
    "concurrency": 16
  },
  "gateway": {
    "host": "192.168.88.100",
    "user": "gwaves",
    "root": "/home/gwaves/novel-reader-gateway",
    "url": "https://192.168.88.100:8888"
  }
}
```

## Run Summary

`run.json` stores:

- run id
- job config snapshot
- stage status summary
- counts
- artifact paths
- verification results
- timestamps

## Item Status

`items.sqlite` stores item-level progress. It can be queried efficiently and can be
deleted together with the run directory.

Minimum columns:

- `stage`
- `item_id`
- `item_type`
- `status`
- `attempts`
- `started_at`
- `finished_at`
- `error`
- `metadata_json`

