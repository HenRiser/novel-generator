# React Reader / Generation Foundation

This frontend is the only official Braipen frontend for `novel-generator`. The React UI uses `Braipen` as the display brand, while the internal project name, folders, API contracts, and documentation identity remain `novel-generator`. It consumes the FastAPI endpoints, uses streaming single-chapter generation by default, keeps the synchronous generation endpoint as a fallback path, can optionally preview and attach a Narrative Context Pack selected from the user's Narrative Graph, can manually create post-generation Story Delta / Knowledge Draft analysis, can review supported Knowledge Draft candidates in the library page, and now shows a lightweight Chapter Status panel with non-blocking Workflow Guard warnings before generation. The current visual direction is a quiet long-form reading and writing workspace: warm paper surfaces, low-saturation status colors, manuscript-style preview, and restrained transitions.

## Workspace navigation

React opens to the Braipen home page by default. The header structure is:

```text
Braipen        创作 | 阅读 | 资料库 | 项目配置 | 系统设置        API Online
```

- Clicking the logo mark or `Braipen` returns to the home page.
- `创作` is for project creation, onboarding, outline/character generation, single-chapter streaming generation, synchronous fallback generation, and generation status.
- `阅读` is for chapter navigation, long-form reading, current-chapter TXT export, and full-book TXT export.
- `资料库` provides the Narrative Graph foundation: manual nodes, edges, tag registry, an Entity Inspector, and Knowledge Draft review.
- `项目配置` separates read-only Genesis settings from editable Generation Settings for `model`, `max_tokens`, and `temperature`.
- `系统设置` shows API status, the API base URL, generation status, and startup command references.

The library page has moved beyond the initial foundation: it supports safe edit/delete flows, properties templates, local rule-based approximate browsing, an enhanced Entity Inspector, and single-change Knowledge Draft Review & Merge.

The creation page now includes Context Pack Builder foundation support. It previews a structured Narrative Context Pack selected from the Narrative Graph by local rules, lets the user control `min_importance`, node and edge limits, unresolved foreshadowing, and neighbor inclusion, and keeps context-assisted generation disabled by default. It does not inject the full graph by default.

The creation page also includes Story Delta + Next Chapter Proposal foundation support. This uses plan B: after chapter prose has already been saved, the user can manually trigger a second analysis pass. Story Delta describes what happened in the current chapter, Next Chapter Proposal describes suggested planning for the next chapter, and Knowledge Draft stores pending-review candidate changes. The library page can accept or reject these changes one at a time. Only `create_node` and `create_edge` are accepted into the formal `narrative_graph.json`; unsupported operations are shown but cannot be accepted. Rejected changes do not write the graph. Story Delta candidate changes are aligned with the Review & Merge schema: new `create_node` payloads use `type`, legacy `node_type` is accepted as a fallback, first-order world fact / foreshadowing / plot direction / character-card candidates are normalized into `create_node` where possible, and `create_edge` can use `source_change_id` / `target_change_id` for same-draft node references. The Chapter Status panel summarizes prose, Story Delta, Knowledge Draft review counts, AI Run provenance, related events, and Context Pack freshness; freshness is shown as `unknown` when no reliable persisted freshness metadata exists.

This stage does not add React Router, Three.js, React Three Fiber, GSAP, React Flow, 2D/3D graph visualization, vector search, embeddings, external search APIs, AI automatic graph extraction, AI automatic graph updates, or complete API Key management.

## Frontend entry points

There is one official local frontend surface:

- `start-react.bat` starts FastAPI plus the React frontend at `http://127.0.0.1:5173`.
- `start.bat` is a deprecated compatibility shim that prints a retirement notice and redirects to `start-react.bat`.

React requires the FastAPI backend. Streamlit is retired and is no longer maintained or tested as a frontend.

## Start React with the script

From the project root:

```bat
.\start-react.bat
```

The script starts:

```text
FastAPI: http://127.0.0.1:8000
React:   http://127.0.0.1:5173
```

If `frontend\node_modules` is missing, the React terminal window runs `npm install` before `npm run dev`.

## Start React manually

### Start the API

From the project root:

```bat
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Default API address:

```text
http://127.0.0.1:8000
```

### Start the React frontend

From `frontend/`:

```bat
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://127.0.0.1:5173
```

You can override the API address with:

```text
VITE_API_BASE_URL=http://127.0.0.1:8000
```

## Current scope

Implemented:

- Braipen home page as the default React entry
- Header workspace navigation for creation, reading, library, project settings, and system settings
- Warm paper reading/workbench visual theme
- API health status
- API generation status
- Project list
- Basic workspace project creation
- Project detail summary
- Narrative Graph usability foundation in the library page
- Manual create/edit/delete for Narrative Graph nodes and edges
- Tag registry create/edit/delete with safe deletion checks
- Safe node deletion that refuses to silently drop connected edges
- Properties JSON templates for common node types
- Local rule-based approximate browsing across labels, aliases, tags, summaries, notes, properties, and neighbor context
- Enhanced Entity Inspector for selected nodes and edges
- Clear boundaries between controlled `tags`, free-form `aliases`, and free-form `notes`
- `importance` on a 1-10 scale and `layer` values of `core`, `major`, `detail`, or `background`
- Context Pack Builder foundation in the creation page
- Narrative Context Pack preview from the current Narrative Graph
- Local rule-based selection by chapter goal, importance, tags, unresolved foreshadowing, and one-hop graph neighbors
- User controls for `min_importance`, `max_nodes`, `max_edges`, unresolved foreshadowing inclusion, and neighbor inclusion
- Optional context-assisted chapter generation, disabled by default
- Structured preview with selected nodes, selected edges, stats, warnings, and expandable prompt text
- Story Delta + Next Chapter Proposal foundation in the creation page
- Manual post-generation analysis after chapter prose is saved
- Knowledge Draft candidate changes with `pending_review` status and `requires_review=true`
- Knowledge Draft Review & Merge foundation in the library page
- Single candidate-change accept / reject
- Accepted `create_node` / `create_edge` changes write to the formal `narrative_graph.json`
- Unsupported operations are displayed but cannot be accepted
- Event Log foundation for chapter generation, Story Delta, Knowledge Draft review, and Narrative Graph CRUD events
- Safety Snapshot foundation before Knowledge Draft accept and Narrative Graph update/delete operations
- Read-only audit APIs: `GET /api/projects/{project_ref}/events` and `GET /api/projects/{project_ref}/snapshots`
- AI Run Provenance foundation for `chapter_generation` and `story_delta_analysis`
- Read-only AI run APIs: `GET /api/projects/{project_ref}/ai-runs` and `GET /api/projects/{project_ref}/ai-runs/{run_id}`
- Prompt profile records with `template_version`, `prompt_hash`, limited `prompt_preview`, model/config, context refs, and result refs
- Chapter Status panel in the creation page
- Chapter Status APIs: `GET /api/projects/{project_ref}/chapters/{chapter_number}/status` and `GET /api/projects/{project_ref}/chapter-status`
- Workflow Guard soft-warning API: `POST /api/projects/{project_ref}/workflow-guard/check`
- Non-blocking generation warnings for existing target prose, previous chapter missing Story Delta, previous pending Knowledge Drafts, missing Story Delta AI Run provenance, and unknown Context Pack freshness
- Dry-run analysis mode for local testing without calling DeepSeek
- Project settings with read-only Genesis fields
- Editable per-project Generation Settings for `model`, `max_tokens`, and `temperature`
- Chapter list
- Chapter content reading
- Single chapter TXT link
- Full book TXT link
- Generate / update outline and character files
- Generate a specified chapter with streaming output by default
- Keep synchronous specified-chapter generation as a fallback
- Show live chapter text while streaming, including preview status and character count
- Refresh chapters and open the generated chapter after generation
- Export current chapter TXT and full book TXT
- A "New novel project" form that creates a `workspace/books/{book_id}/` project
- Post-creation guidance for outline/character generation and first-chapter generation
- Basic loading, generation status, saved-file, and error states

Not implemented in this stage:

- React Router / URL deep links
- Three.js / React Three Fiber 3D hero animation
- GSAP timeline animation
- 2D/3D graph visualization
- React Flow graph editor
- Vector search or embeddings
- External search APIs
- AI semantic search
- Default full-graph injection into chapter generation prompts
- Vector or AI-based Context Pack selection
- Automatic Narrative Graph updates from generated chapters
- Foreshadowing conflict detection
- Single-pass chapter prose plus metadata trailer output
- Automatic character-card merge from Story Delta
- `update_node` / `update_edge`, character-card writes, batch accept/reject, duplicate resolution, conflict detection, or AI auto-review for Knowledge Drafts
- Prompt Editor or user-defined prompt UI
- Saved complete prompt text in AI run records
- Rollback / restore UI, snapshot diff view, automatic snapshot cleanup, or full Git-style branch system
- Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, or Advanced Review & Merge
- Hard workflow locks or forced generation sequencing
- Precise Context Pack freshness calculation without persisted freshness metadata
- AI automatic graph extraction or AI automatic tagging
- Full project management
- Project deletion / rename / archive
- Setting expansion
- Batch generation
- Batch generation API
- Batch streaming generation
- Full project save APIs beyond safe Generation Settings updates
- Full model or API Key settings
- maintained Streamlit frontend
- Cancellation API
- Draft recovery for partial streaming output
- WebSocket or SSE

The "New novel project" button in React now supports the basic creation loop. It creates a workspace project, writes the initial `book.json`, `project_config.json`, and seed setting data, refreshes the project list, and selects the new project. Creating the project does not call the model, does not generate outline/character files, and does not generate chapters. After creation, use the React guidance panel to generate / update outline and character files, then generate the first chapter.

Use React for project creation, reading projects, outline/character generation, Context Pack preview, optional context-assisted single-chapter generation, Story Delta draft analysis, streaming preview, and TXT export:

```bat
.\start-react.bat
```

Context Pack preview in React calls `POST /api/projects/{project_ref}/context-pack/preview`. The preview reads the current Narrative Graph, returns a structured pack plus prompt text, and does not call the model or write graph/chapter files. The UI now shows a creator-focused preview that groups selected context into characters, events/scenes, foreshadowing, world rules, plot directions, narrative relationships, and high-priority reminders for the next chapter. Raw Prompt / Debug remains available; the selection algorithm and generated prompt content are unchanged.

Story Delta analysis in React calls `POST /api/projects/{project_ref}/chapters/{chapter_number}/story-delta/analyze`. It is manually triggered after a chapter exists. Dry-run mode does not call DeepSeek. Non-dry-run mode performs a second model call dedicated to analysis. Successful analysis writes pending-review draft files under `workspace/books/{book_id}/memory/` and does not modify the official chapter file, character cards, outline, or `narrative_graph.json`.

Knowledge Draft review in React uses `GET /api/projects/{project_ref}/knowledge-drafts`, `GET /api/projects/{project_ref}/knowledge-drafts/{draft_id}`, `POST /api/projects/{project_ref}/knowledge-drafts/{draft_id}/changes/{change_id}/accept`, and `POST /api/projects/{project_ref}/knowledge-drafts/{draft_id}/changes/{change_id}/reject`. Accepting is intentionally limited to `create_node` and `create_edge`; rejecting is available for unsupported operations too. This is a review foundation, not AI auto-review, batch merge, character-card merge, duplicate resolution, or conflict detection.

Story Delta candidate changes now prefer directly reviewable operations. New `create_node` payloads use `type`, not `node_type`; legacy `node_type` payloads remain acceptable for old drafts. First-order world fact, foreshadowing, plot direction, and character-card candidates are normalized into `create_node` when possible. `create_edge` candidates can point to existing graph nodes or same-draft node candidates through `source_change_id` and `target_change_id`. Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, and Advanced Review & Merge remain unimplemented.

The Library page now has Graph Narrative View v0 and Review Semantic Cards v0. Narrative View groups graph records into creator-facing sections such as characters, events/scenes, foreshadowing, world rules, plot directions, relationship notes, relationships, and other records. It also supports local search and filters by keyword, story asset type, importance, status, and layer; relationship results keep source and target labels as the primary reading surface. Review cards show `create_node` and `create_edge` candidates as story assets and narrative relationships first. Operation names, ids, targets, and payload JSON remain available in collapsed Debug details and Raw / Technical View.

Audit review APIs expose `GET /api/projects/{project_ref}/events` and `GET /api/projects/{project_ref}/snapshots`. They are read-only. Event Log and Safety Snapshot are foundations only: they record audit events and create pre-write JSON backups for selected high-risk operations, but they do not provide rollback, restore UI, diff view, automatic cleanup, Timeline Review, Health Dashboard, Future Outline Revision, Consistency Policy, or Advanced Review & Merge.

AI Run Provenance APIs expose `GET /api/projects/{project_ref}/ai-runs` and `GET /api/projects/{project_ref}/ai-runs/{run_id}`. The first version records only chapter generation and Story Delta analysis runs. It stores model/config values, prompt profile ids, template versions, prompt hashes, limited prompt previews, context refs, and output refs. It does not save complete prompt text, API keys, `.env` content, local absolute paths, Prompt Editor data, Timeline data, Health Dashboard data, Future Outline Revision data, Consistency Policy results, or Advanced Review & Merge state.

Chapter Status APIs expose `GET /api/projects/{project_ref}/chapters/{chapter_number}/status`, `GET /api/projects/{project_ref}/chapter-status`, and `POST /api/projects/{project_ref}/workflow-guard/check`. They are read-only for status/guard evaluation: querying them does not write Event Log entries, create snapshots, or modify AI Run records. Workflow Guard is a soft-warning foundation for `generate_chapter`; it does not block generation unless the backend returns a real request/project error.

Single-chapter generation in React calls `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate/stream` and reads newline-delimited JSON events with `fetch()` and `ReadableStream`. The existing synchronous `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate` endpoint remains available as the "synchronous fallback" button. When the user enables context-assisted generation, React sends the previewed Narrative Context Pack text as optional generation context; when disabled or absent, the request path stays unchanged.

Streaming preview behavior:

- The main chapter generation button uses streaming output by default.
- Text shown before the `done` event is a live preview, not a saved chapter.
- The chapter is marked saved only after the API finishes chapter save, summary save, and index update.
- If streaming fails or the request is interrupted, the preview remains visible and is marked as unsaved.
- Failed partial preview text is not written to the official chapter file.
- If generated content appears cut off, increase `max_tokens` or regenerate that chapter.

## Streamlit retirement notes

Streamlit is retired. `app.py` is kept only as a deprecated historical reference, and `start.bat` redirects to the official React + FastAPI startup. Future features and regression tests should target React + FastAPI only.

Residual Streamlit-only capabilities are intentionally not migrated in this stage unless listed below as future React candidates:

- covered by React + FastAPI: project creation, project list/detail, outline/character generation, specified chapter generation, streaming preview, synchronous fallback generation, generation status, reading, TXT export, Narrative Graph, Context Pack, Story Delta, Knowledge Draft Review & Merge, and per-project Generation Settings.
- intentionally not migrated: Streamlit prompt preview, opening local output directories from the UI, full `.env` API Key write UI, setting expansion UI, edited-result save UI, and legacy Streamlit reader controls.
- future React candidates: a dedicated one-click next-chapter button, batch chapter generation, and system-level API Key/model connection testing.
