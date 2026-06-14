# React Reader / Generation Foundation

This frontend is the React reader and generation surface for `novel-generator`. The React UI now uses `Braipen` as the display brand, while the internal project name, folders, API contracts, and documentation identity remain `novel-generator`. It consumes the FastAPI read endpoints, uses streaming single-chapter generation by default, keeps the synchronous generation endpoint as a fallback path, can optionally preview and attach a Narrative Context Pack selected from the user's Narrative Graph, and can manually create post-generation Story Delta / Knowledge Draft analysis. The current visual direction is a quiet long-form reading and writing workspace: warm paper surfaces, low-saturation status colors, manuscript-style preview, and restrained transitions.

## Workspace navigation

React opens to the Braipen home page by default. The header structure is:

```text
Braipen        创作 | 阅读 | 资料库 | 项目配置 | 系统设置        API Online
```

- Clicking the logo mark or `Braipen` returns to the home page.
- `创作` is for project creation, onboarding, outline/character generation, single-chapter streaming generation, synchronous fallback generation, and generation status.
- `阅读` is for chapter navigation, long-form reading, current-chapter TXT export, and full-book TXT export.
- `资料库` provides the Narrative Graph foundation: manual nodes, edges, tag registry, and an Entity Inspector.
- `项目配置` separates read-only Genesis settings from editable Generation Settings for `model`, `max_tokens`, and `temperature`.
- `系统设置` shows API status, the API base URL, generation status, and startup command references.

The library page has moved beyond the initial foundation: it supports safe edit/delete flows, properties templates, local rule-based approximate browsing, and an enhanced Entity Inspector.

The creation page now includes Context Pack Builder foundation support. It previews a structured Narrative Context Pack selected from the Narrative Graph by local rules, lets the user control `min_importance`, node and edge limits, unresolved foreshadowing, and neighbor inclusion, and keeps context-assisted generation disabled by default. It does not inject the full graph by default.

The creation page also includes Story Delta + Next Chapter Proposal foundation support. This uses plan B: after chapter prose has already been saved, the user can manually trigger a second analysis pass. Story Delta describes what happened in the current chapter, Next Chapter Proposal describes suggested planning for the next chapter, and Knowledge Draft stores pending-review candidate changes. These drafts are not automatically written to character cards or `narrative_graph.json`.

This stage does not add React Router, Three.js, React Three Fiber, GSAP, React Flow, 2D/3D graph visualization, vector search, embeddings, external search APIs, AI automatic graph extraction, AI automatic graph updates, complete API Key management, or a replacement for the Streamlit legacy frontend.

## Frontend entry points

There are two local frontend surfaces:

- `start.bat` starts the Streamlit legacy frontend at `http://localhost:8501`.
- `start-react.bat` starts FastAPI plus the React frontend at `http://127.0.0.1:5173`.

React requires the FastAPI backend. Streamlit does not require starting FastAPI separately.

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

## Start Streamlit legacy frontend

From the project root:

```bat
.\.venv\Scripts\python.exe -m streamlit run app.py
```

or:

```bat
.\start.bat
```

Open:

```text
http://localhost:8501
```

`start.bat` is reserved for the Streamlit legacy frontend. It is separate from `start-react.bat`.

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
- Automatic character-card or Narrative Graph merge from Story Delta
- Complete Review & Merge workflow for Knowledge Drafts
- AI automatic graph extraction or AI automatic tagging
- Full project management
- Project deletion / rename / archive
- Setting expansion
- Batch generation
- Batch generation API
- Batch streaming generation
- Full project save APIs beyond safe Generation Settings updates
- Full model or API Key settings
- Streamlit streaming UI
- Cancellation API
- Draft recovery for partial streaming output
- WebSocket or SSE

The "New novel project" button in React now supports the basic creation loop. It creates a workspace project, writes the initial `book.json`, `project_config.json`, and seed setting data, refreshes the project list, and selects the new project. Creating the project does not call the model, does not generate outline/character files, and does not generate chapters. After creation, use the React guidance panel to generate / update outline and character files, then generate the first chapter.

Streamlit remains available for the legacy full workflow:

```bat
.\start.bat
```

Use React for basic project creation, reading projects, outline/character generation, Context Pack preview, optional context-assisted single-chapter generation, Story Delta draft analysis, streaming preview, and TXT export:

```bat
.\start-react.bat
```

Context Pack preview in React calls `POST /api/projects/{project_ref}/context-pack/preview`. The preview reads the current Narrative Graph, returns a structured pack plus prompt text, and does not call the model or write graph/chapter files.

Story Delta analysis in React calls `POST /api/projects/{project_ref}/chapters/{chapter_number}/story-delta/analyze`. It is manually triggered after a chapter exists. Dry-run mode does not call DeepSeek. Non-dry-run mode performs a second model call dedicated to analysis. Successful analysis writes pending-review draft files under `workspace/books/{book_id}/memory/` and does not modify the official chapter file, character cards, outline, or `narrative_graph.json`.

Single-chapter generation in React calls `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate/stream` and reads newline-delimited JSON events with `fetch()` and `ReadableStream`. The existing synchronous `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate` endpoint remains available as the "synchronous fallback" button. When the user enables context-assisted generation, React sends the previewed Narrative Context Pack text as optional generation context; when disabled or absent, the request path stays unchanged.

Streaming preview behavior:

- The main chapter generation button uses streaming output by default.
- Text shown before the `done` event is a live preview, not a saved chapter.
- The chapter is marked saved only after the API finishes chapter save, summary save, and index update.
- If streaming fails or the request is interrupted, the preview remains visible and is marked as unsaved.
- Failed partial preview text is not written to the official chapter file.
- If generated content appears cut off, increase `max_tokens` or regenerate that chapter.

Streamlit currently continues to use the synchronous generation workflow.
