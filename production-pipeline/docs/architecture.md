# Production Pipeline v2 Architecture

## Goal

Build an independent production system that can complete content production without
depending on local app services such as `5174`.

The pipeline can depend on:

- the main SQLite database
- files in the workspace
- LLM, embedding, and TTS upstream providers
- SSH/rsync access to Gateway hosts
- Gateway HTTP APIs for post-publish verification

The pipeline must not depend on:

- the PC frontend
- `scripts/local-db-server.mjs`
- a long-running local API process
- Codex automation as the primary recovery mechanism

## Components

```text
CLI
  -> job loader
  -> run store
  -> stage orchestrator
  -> stage implementations
  -> provider clients
  -> publishers
  -> verifiers
```

## Storage

Production state is run-scoped:

- `run.json`: run metadata and stage summaries
- `items.sqlite`: item-level status, attempts, timing, and errors
- `logs/`: stdout-like structured logs
- `artifacts/`: generated files for package, audio, manifests, and reports
- `checkpoints/`: provider-specific resumable checkpoints when needed

The main app database stores only durable product results:

- summaries
- knowledge graph records
- summary embeddings
- chunk embeddings

## Orchestration

The orchestrator runs stages in dependency order. Each stage receives:

- immutable job config
- run context
- stage range/filter options
- stores for main data and run progress
- provider clients

Stages report progress at item and batch boundaries. A resumed run derives remaining
work from both durable outputs and `items.sqlite`, favoring durable output truth.

## Failure Handling

External calls must define:

- timeout
- retryable status codes
- retry count
- backoff policy
- item-level failure capture

A failed stage should not erase completed item results. Resume should continue from
missing or failed items only.

