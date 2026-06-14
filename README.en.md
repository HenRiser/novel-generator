# novel-generator

[中文](README.md) | [English](README.en.md)

A lightweight local-first AI novel writing tool built around the official Braipen frontend: React + FastAPI with the OpenAI-compatible DeepSeek API. The project is designed for personal writing workflows and long-term local iteration: no database, no user system, and no SaaS assumptions. The old Streamlit UI is retired and no longer maintained.

## Features

- Enter a novel title, genre, writing style, characters, worldview, core conflict, and extra requirements.
- Generate or update the novel outline as a setting asset.
- Generate or update character cards as setting assets.
- Write a specified chapter with streaming output by default, with synchronous generation kept as a fallback path.
- Avoid silent overwrites by saving duplicate chapter numbers as versioned files such as `chapter_001_v2.md`.
- Generate short chapter summaries and maintain `chapter_index.md`.
- Read previous chapters, summaries, outline, and character cards as context.
- Expand raw story ideas into structured settings.
- Preview prompts before calling the API.
- Save and load `project_config.json`.
- Configure per-project generation settings from React, with system-level API Key management kept as a future React + FastAPI task.

## Quick Start

Recommended Python version: 3.10 or newer.

```bat
cd /d D:\vibecoding\novel-generator
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env`:

```env
DEEPSEEK_API_KEY=your_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEFAULT_MODEL=deepseek-v4-flash
```

Start the official Braipen frontend:

```bat
cd /d D:\vibecoding\novel-generator
start-react.bat
```

Then open:

```text
http://127.0.0.1:5173
```

Windows users can still run `setup.bat` for environment setup. `start-react.bat` is the recommended startup command. `start.bat` is now a deprecated compatibility shim that prints a retirement notice and redirects to `start-react.bat`.

## Official React Frontend

React + FastAPI is the only official frontend architecture. The React UI uses `Braipen` as the display brand, while the internal project name, folders, API contracts, and documentation identity remain `novel-generator`. Its current visual direction is a reading-first writing workspace: warm paper surfaces, low-saturation status colors, comfortable long-form text width, and a manuscript-like streaming preview rather than an AI demo or dashboard-heavy interface.

One-command startup on Windows:

```bat
cd /d D:\vibecoding\novel-generator
start-react.bat
```

The script starts:

```text
FastAPI: http://127.0.0.1:8000
React:   http://127.0.0.1:5173
```

If `frontend\node_modules` is missing, the React terminal window runs `npm install` before starting Vite. `start-react.bat` starts FastAPI + React only and does not start Streamlit.

Manual startup uses two terminals.

Terminal 1, start FastAPI:

```bat
cd /d D:\vibecoding\novel-generator
.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

The API is available at:

```text
http://127.0.0.1:8000
```

The API exposes health, workspace project creation, project listing/detail, project generation settings updates, Narrative Graph CRUD endpoints, Context Pack preview, Story Delta analysis, Knowledge Draft listing/detail plus single-change review accept/reject, chapter reading, TXT export, generation status, outline/character generation, synchronous single-chapter generation, and streaming single-chapter generation. It does not implement WebSocket, task queues, user accounts, database-backed jobs, cancellation, batch draft merge, or full project-management APIs.

Terminal 2, start React:

```bat
cd /d D:\vibecoding\novel-generator\frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

The React frontend is available at:

```text
http://127.0.0.1:5173
```

The frontend reads `VITE_API_BASE_URL` when provided and otherwise uses `http://127.0.0.1:8000`. React uses single-chapter streaming generation by default and keeps synchronous chapter generation as a fallback / debug path. Streaming text is a live preview until the API sends the final `done` event; failed or interrupted previews are not written to the official chapter file. The creation page can preview a Narrative Context Pack selected from the current Narrative Graph and can optionally attach that previewed context to chapter generation; the option is disabled by default. After a chapter exists, the creation page can manually run a second Story Delta analysis pass and save pending-review Knowledge Draft candidates. The library page can review those candidates one at a time; accepting supported `create_node` / `create_edge` changes writes to `narrative_graph.json`, while rejecting a change does not write the graph.

React opens to the Braipen home page by default. Clicking the logo mark or `Braipen` returns to the home page. The header workspace structure is:

```text
Braipen        创作 | 阅读 | 资料库 | 项目配置 | 系统设置        API Online
```

The creation page is for project creation, onboarding, outline/character generation, Context Pack preview, optional context-assisted streaming chapter generation, manual Story Delta / Next Chapter Proposal analysis, synchronous fallback generation, and generation status. The reading page is for chapter navigation, long-form reading, and TXT export. The library page now provides a Narrative Graph usability foundation plus Knowledge Draft review: manual nodes, edges, controlled tag registry, safe edit/delete flows, properties templates, local rule-based approximate browsing, an enhanced Entity Inspector, and single-change accept/reject for supported draft candidates. The project settings page separates read-only Genesis settings from editable Generation Settings for `model`, `max_tokens`, and `temperature`. The system settings page shows API status, the API base URL, generation status, and startup command references.

Current React support:

- Braipen home page as the default React entry
- workspace navigation across creation, reading, library, project settings, and system settings
- basic workspace project creation
- project reading and chapter navigation
- outline and character generation after creation
- single-chapter streaming generation
- live manuscript preview
- generation status display
- Narrative Graph usability foundation in the library page
- manual create/edit/delete for nodes and edges
- tag registry create/edit/delete with safe deletion checks
- safe node deletion that refuses to silently drop connected edges
- properties JSON templates for common node types
- local rule-based approximate browsing across labels, aliases, tags, summaries, notes, properties, and neighbor context
- enhanced Entity Inspector for selected nodes and edges
- controlled `tags`, free-form `aliases`, and free-form `notes`
- `importance` on a 1-10 scale and `layer` values of `core`, `major`, `detail`, or `background`
- Context Pack Builder foundation in the creation page
- Narrative Context Pack preview from the current Narrative Graph
- local rule-based selection by chapter goal, importance, tags, unresolved foreshadowing, and one-hop graph neighbors
- user controls for `min_importance`, `max_nodes`, `max_edges`, unresolved foreshadowing inclusion, and neighbor inclusion
- optional context-assisted chapter generation, disabled by default
- structured preview with selected nodes, selected edges, stats, warnings, and expandable prompt text
- Story Delta + Next Chapter Proposal foundation in the creation page
- manual post-generation second analysis pass after chapter prose is saved
- pending-review Knowledge Draft candidate changes with `requires_review=true`
- Knowledge Draft Review & Merge foundation in the library page
- single candidate-change accept / reject
- accepted `create_node` / `create_edge` changes write to the formal `narrative_graph.json`
- rejected changes do not write the Narrative Graph
- unsupported operations are displayed but cannot be accepted
- dry-run analysis mode for local testing without calling DeepSeek
- read-only Genesis settings display in the project settings page
- editable per-project Generation Settings for `model`, `max_tokens`, and `temperature`
- current-chapter TXT export and full-book TXT export

The React "New novel project" button creates a `workspace/books/{book_id}/` project, saves the initial configuration and writing seed, refreshes the project list, and selects the new project. Creating a project does not call the model automatically. After creation, React guides the user to generate or update outline and character files, then generate the first chapter.

## Streamlit Retirement

Streamlit is retired as a frontend and is no longer a regression target. `app.py` is kept only as a deprecated historical reference while the project is still consolidating code. New product work, UI work, and test plans should target React + FastAPI only.

`start.bat` no longer starts Streamlit; it prints a deprecation notice and redirects to `start-react.bat`.

Residual Streamlit-only capabilities have been triaged:

- covered by React + FastAPI: project creation, project list/detail, outline and character generation, specified chapter generation, streaming preview, synchronous fallback generation, generation status, chapter reading, TXT export, Narrative Graph, Context Pack, Story Delta, and per-project Generation Settings.
- intentionally not migrated in this stage: Streamlit prompt preview, opening local output directories from the UI, full `.env` API Key write UI, setting expansion UI, edited-result save UI, and legacy Streamlit reader controls.
- later React candidates: one-click next-chapter command as a dedicated button, batch chapter generation, system-level API Key/model connection testing, and broader draft merge tooling.

Current React limits:

- no React Router / URL deep links
- no Three.js or React Three Fiber 3D hero animation
- no GSAP timeline animation
- no 2D/3D graph visualization
- no React Flow graph editor
- no vector search, embeddings, external search API, or AI semantic search
- no default full-graph injection into chapter generation prompts
- no vector or AI-based Context Pack selection
- no automatic Narrative Graph updates from generated chapters
- no foreshadowing conflict detection
- no single-pass chapter prose plus metadata trailer output
- no automatic character-card merge from Story Delta
- no `update_node` / `update_edge`, character-card writes, batch accept/reject, duplicate resolution, conflict detection, or AI auto-review for Knowledge Drafts
- no AI auto-extraction or AI auto-tagging for graph entities
- no project deletion / rename / archive
- no batch streaming generation
- no cancellation API
- no draft recovery for failed partial output
- no full model or API Key settings migration beyond per-project `model`, `max_tokens`, and `temperature`
- no maintained Streamlit frontend

For frontend-specific notes, see `frontend/README.md`.

## API / Model Configuration

The default model is `deepseek-v4-flash`. The built-in model choices are:

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `custom`

React currently exposes safe per-project Generation Settings for `model`, `max_tokens`, and `temperature`. System-level API Key and model connection testing remain future React + FastAPI settings work.

API Keys are stored only in the local `.env` file or environment variables. They are not written to `project_config.json`.

## Project Structure

```text
novel-generator
|-- api/
|   |-- main.py
|   |-- schemas.py
|   `-- routers/
|-- frontend/
|   |-- package.json
|   |-- index.html
|   `-- src/
|-- app.py  # deprecated Streamlit frontend, retained for historical reference
|-- config.py
|-- config_manager.py
|-- deepseek_client.py
|-- prompt_templates.py
|-- file_manager.py
|-- project_context.py
|-- export_service.py
|-- generation_config.py
|-- ui_options.py
|-- requirements.txt
|-- README.md
|-- README.en.md
|-- .env.example
|-- outputs/
|   `-- .gitkeep
|-- workspace/
|   `-- books/
`-- docs/
    `-- prompt_design.md
```

## Storage Layout

New projects are stored under stable book IDs:

```text
workspace/
`-- books/
    `-- bk_YYYYMMDD_HHMMSS_xxxxxxxx/
        |-- book.json
        |-- project_config.json
        |-- novel_outline.md
        |-- characters.md
        |-- chapter_index.md
        |-- setting_expansion_latest.json
        |-- chapters/
        |   `-- chapter_001.md
        `-- summaries/
            `-- chapter_001_summary.md
```

Legacy `outputs/{title}/` projects remain compatible. The app does not automatically migrate, delete, or rename old projects.

## Chapter Creation Flow

The official React creation page uses a focused single-chapter workflow:

- **Specified chapter**: uses the chapter number entered by the user.
- **Suggested next chapter**: React displays the recommended next chapter number; the user can generate that chapter through the same single-chapter controls.
- **Streaming first**: streaming generation is the default path, with synchronous generation kept as a fallback/debug path.
- **Context Pack optional**: Narrative Context Pack preview can be attached to generation only when the user enables it.
- **Story Delta manual**: post-generation analysis is manually triggered after a chapter exists.

Batch chapter generation is intentionally not migrated in this consolidation stage.

## Writing Mode And Story Scale

Writing mode describes narrative rhythm or style, such as cinematic long plot, slow-burn setup, or high-density plot progression.

Story scale is inferred from expected chapter count:

- 1-10 chapters: short novel
- 11-40 chapters: medium novel
- 41+ chapters: long novel

Prompts use this inferred story scale instead of hard-coding every project as a long novel.

## Current Development Status

- New projects default to `workspace/books/{book_id}/`.
- Legacy `outputs/{title}/` projects remain readable and writable.
- `book:` and `legacy:` project refs are supported internally.
- Reader view and TXT export continue to use the display title rather than exposing `book_id`.
- The sidebar keeps common controls visible and moves environment/path/debug details into an advanced expander.
- No database, multi-user system, or SaaS workflow is included.

## Safety Notes

- Do not commit `.env`.
- Do not commit real `workspace/` data.
- Do not commit real `outputs/` data.
- Do not commit `reports/`.
- `outputs/.gitkeep` is the only tracked placeholder under `outputs/`.
- API Keys should stay local.

## Roadmap

- Volume planning.
- More granular context budgeting.
- More export formats.
- Better consistency prompts for characters and world rules.
