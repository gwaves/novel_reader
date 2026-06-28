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

Resume computes remaining work by comparing:

- expected items from source data
- durable outputs in the main database or artifact directories
- item statuses in `items.sqlite`

Durable outputs win over stale run status.

## Production Service Independence

The pipeline should not require a local HTTP service such as `5174`. Provider clients,
chunking, database writes, and publish logic live inside the production pipeline.

