# Failure Recovery

## Principles

- Failures are captured at item granularity whenever possible.
- Completed durable outputs are not recomputed unless forced.
- Resume uses durable outputs as source of truth.
- Stage-level failures should preserve batch/item progress.
- External provider failures should retry with bounded exponential backoff.

## Retry Policy

Each provider call defines:

- timeout
- retry count
- retryable errors
- backoff
- jitter

Common retryable HTTP statuses:

- `408`
- `429`
- `500`
- `502`
- `503`
- `504`

## Resume

`resume` starts from an existing `run.json`. By default it skips any stage whose
status is already `completed` and executes stages that are missing, running from
a previous interruption, or failed. This makes a broken production run restartable
without repeating successful package/audio/publish work.

Stage-level resume computes remaining work by comparing:

- expected items from source data
- durable outputs in the main database or artifact directories
- item statuses in `items.sqlite`

Durable outputs win over stale run status.

The parent `run.json` is the orchestration source of truth. Stage artifacts live
in child stage runs referenced from the parent stage summary, for example:

- `stages.package.childRunJson`
- `stages.audio.childRunJson`
- `stages.publish.childRuns[]`
- `stages.verify.childRuns[]`

The parent run also stores command logs under `logs/`, so a failed child process
keeps its stdout and stderr for diagnosis.

## External Boundaries

- Embedding opens SQLite directly and calls the configured provider directly.
- Embedding must not depend on the old `127.0.0.1:5174` local API.
- Publish uses `rsync` because Gateway package and MP3 payloads are large.
- Verify uses Gateway HTTP after publish to check book listing, package identity,
  package chapter ids, audio count, and audio chapter ids.

## Production Service Independence

The pipeline should not require a local HTTP service such as `5174`. Provider clients,
chunking, database writes, and publish logic live inside the production pipeline.
