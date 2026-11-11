# scripts

Standalone tsx scripts: spike-paypal, fetch-worldbank, ai-stability, run-benchmark, db-check.
They load `.env` via Node's `--env-file-if-exists` and read config from `lib/env.script.ts`.
