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

- `localStore.ts`: in-memory creative transactions, file-backed workspace v5, preserved revisions and explicit legacy-data migration; browser storage is limited to connection/key preferences.
- `localWorkflow.ts`: streaming chapters, confirmation, summaries, batches, continuation and recovery. A tab must stay open for active local workflows.
- `writingStyle.ts`: bounded style-card validation, standalone import/export, deterministic example retrieval and structured reference remapping.
- `writingStyleClient.ts`: one-chapter, five-stage extraction with current-service capability checks and a single connection lease; each call has a 20,000-token output allowance.
- `computeClient.ts`: actual request-scoped JSON/NDJSON transport; `localApi.ts` handles browser-owned business data.
- `providerConnections.ts` and `keyVault.ts`: connection snapshots, leases and session keys or explicit plaintext local remembering. Keys never enter project or backup data.

Projects keep their selected style-card snapshot; shared library edits require manual project updates. Single-run overrides do not update project defaults. Batches freeze their style pool, and continuations and rescued drafts retain actual style usage.

The server processes only the request's selected material and credentials. Creative data is not written to browser storage. Open the workspace folder again each session; keys and UI preferences remain origin-scoped.

## Checks

```powershell
npm test
node --test scripts/test-writing-style.mjs scripts/test-writing-style-workflow.mjs scripts/test-file-workspace.mjs scripts/test-style-distillation.mjs scripts/test-key-backup.mjs scripts/test-local-folder-sync.mjs
npm run build
```

`npm test` discovers the existing Node unit scripts without running browser fixtures. Browser scripts use an existing Playwright installation (`BRAIPEN_PLAYWRIGHT_PATH`) and can select the existing Python environment with `BRAIPEN_TEST_PYTHON`. `test-outline-entry-browser.mjs` covers asset editing, retained drafts and conflicts; `test-planning-drafts-browser.mjs` covers chapter and scene drafts across navigation and workspace reopening. Models are simulated and real user data is not used.

`test-import-lifecycle-browser.mjs` covers cancellation, workspace switching and import drafts. `test-file-workspace-opfs-browser.mjs` exercises native browser file handles in isolated OPFS, including exclusive locks and retry; operating-system folder permission dialogs remain a separate manual check.

For browser integration using real IndexedDB and mock model responses:

```powershell
node scripts/writing-style-browser-server.mjs
```

Open `http://127.0.0.1:5177/__writing-style-test` and run integration checks. Opening the app in a new document requires reopening its workspace file. All API paths terminate in the local mock; it never forwards model requests. Its origin and synthetic data are separate from production. Stop it when finished.

## Build and compatibility

`npm run build` performs TypeScript checks and creates `dist/`. Serve it alongside a compatible FastAPI version; five-stage extraction requires the advertised distillation capability and `distill_style_step`. Local editing/import stays available with an older backend, while style-dependent calls fail explicitly.

Workspaces are v5 with readers for v1–v4; card files are `braipen-style-card` v1. Directory synchronization requires browser directory access and Web Locks; unsupported browsers use JSON download/restore. Never submit `dist/`, `node_modules`, real keys, `.env` files or local report artifacts to Git.
