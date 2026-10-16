# Braipen frontend

React 19, TypeScript, Vite, Ant Design 6, Zustand and React Router. This is the official frontend for `novel-generator`; Streamlit is retired.

See the root [Chinese README](../README.md) or [English README](../README.en.md) for product features, model configuration, local storage, writing-style cards and hosting boundaries.

## Development

From the repository root, start the existing Python environment:

```powershell
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

From `frontend/`:

```powershell
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173`. Development defaults to the local backend at port 8000. Production defaults to same-origin API requests; `VITE_API_BASE_URL` can explicitly override the destination. Do not embed credentials in `VITE_*` build variables.

The Node engine requirement of the pinned Vite is `^20.19.0 || >=22.12.0`. Use the existing npm lockfile.

## Data and workflow

- `localStore.ts`: IndexedDB transactions, optimistic project revisions, style-library entries and `braipen-backup` v4 import/export.
- `localWorkflow.ts`: streaming chapters, confirmation, summaries, batches, continuation and recovery. A tab must stay open for active local workflows.
- `writingStyle.ts`: bounded style-card validation, standalone import/export, deterministic example retrieval and structured reference remapping.
- `writingStyleClient.ts`: explicit source-limited extraction with current-service capability checks.
- `computeClient.ts`: actual request-scoped JSON/NDJSON transport; `localApi.ts` handles browser-owned business data.
- `providerConnections.ts` and `keyVault.ts`: connection snapshots, leases and session keys or explicit plaintext local remembering. Keys never enter project or backup data.

Projects keep their selected style-card snapshot; shared library edits require manual project updates. Single-run overrides do not update project defaults. Batches freeze their style pool, and continuations and rescued drafts retain actual style usage.

The server processes only the request's selected material and credentials. Local storage is origin-scoped; changing hostnames, protocols or ports does not transfer projects.

## Checks

```powershell
node --test scripts/test-writing-style.mjs scripts/test-writing-style-workflow.mjs scripts/test-key-backup.mjs scripts/test-local-folder-sync.mjs
npm run build
```

For browser integration using real IndexedDB and mock model responses:

```powershell
node scripts/writing-style-browser-server.mjs
```

Open `http://127.0.0.1:5177/__writing-style-test` and run integration checks or create visual fixtures. All API paths terminate in the local mock; it never forwards model requests. Its origin and synthetic data are separate from production. Stop it when finished.

## Build and compatibility

`npm run build` performs TypeScript checks and creates `dist/`. Serve it alongside a compatible FastAPI version; style extraction requires `writing_style.version=1` and `extract_style_card`. Local editing/import stays available with an older backend, while style-dependent calls fail explicitly.

Backups are v4 with readers for v1–v3; card files are `braipen-style-card` v1. Directory synchronization requires browser directory access and Web Locks; unsupported browsers use JSON download/restore. Never submit `dist/`, `node_modules`, real keys, `.env` files or local report artifacts to Git.
