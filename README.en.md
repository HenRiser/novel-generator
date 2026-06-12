# novel-generator

[中文](README.md) | [English](README.en.md)

A lightweight local-first AI novel writing tool built with Streamlit and the OpenAI-compatible DeepSeek API. The project is designed for personal writing workflows and long-term local iteration: no database, no user system, and no SaaS assumptions.

## Features

- Enter a novel title, genre, writing style, characters, worldview, core conflict, and extra requirements.
- Generate or update the novel outline as a setting asset.
- Generate or update character cards as setting assets.
- Write a specified chapter, continue with the next chapter, or generate a small chapter range.
- Avoid silent overwrites by saving duplicate chapter numbers as versioned files such as `chapter_001_v2.md`.
- Generate short chapter summaries and maintain `chapter_index.md`.
- Read previous chapters, summaries, outline, and character cards as context.
- Expand raw story ideas into structured settings.
- Preview prompts before calling the API.
- Save and load `project_config.json`.
- Configure API Key, Base URL, default model, and custom model names from the UI.

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

Start the Streamlit legacy frontend:

```bat
cd /d D:\vibecoding\novel-generator
.venv\Scripts\python.exe -m streamlit run app.py
```

Then open:

```text
http://localhost:8501
```

Windows users can also run `setup.bat` and `start.bat`. `start.bat` is reserved for the Streamlit legacy frontend.

## React Frontend

The React frontend is separate from Streamlit. It requires the FastAPI backend. Its current visual direction is a reading-first writing workspace: warm paper surfaces, low-saturation status colors, comfortable long-form text width, and a manuscript-like streaming preview rather than an AI demo or dashboard-heavy interface.

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

If `frontend\node_modules` is missing, the React terminal window runs `npm install` before starting Vite. `start-react.bat` does not start Streamlit, and `start.bat` does not start React.

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

The API exposes health, workspace project creation, project listing/detail, chapter reading, TXT export, generation status, outline/character generation, synchronous single-chapter generation, and streaming single-chapter generation. It does not implement WebSocket, task queues, user accounts, database-backed jobs, cancellation, draft recovery, or full project-management APIs.

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

The frontend reads `VITE_API_BASE_URL` when provided and otherwise uses `http://127.0.0.1:8000`. React uses single-chapter streaming generation by default and keeps synchronous chapter generation as a fallback / debug path. Streaming text is a live preview until the API sends the final `done` event; failed or interrupted previews are not written to the official chapter file.

Current React support:

- basic workspace project creation
- project reading and chapter navigation
- outline and character generation after creation
- single-chapter streaming generation
- live manuscript preview
- generation status display
- current-chapter TXT export and full-book TXT export

The React "New novel project" button creates a `workspace/books/{book_id}/` project, saves the initial configuration and writing seed, refreshes the project list, and selects the new project. Creating a project does not call the model automatically. After creation, React guides the user to generate or update outline and character files, then generate the first chapter.

Streamlit legacy frontend remains available for the older full workflow:

```bat
start.bat
```

Use the React frontend for basic project creation, reading, generation, streaming preview, and export:

```bat
start-react.bat
```

Current React limits:

- no project deletion / rename / archive
- no full Streamlit settings migration
- no batch streaming generation
- no cancellation API
- no draft recovery for failed partial output
- no model or API Key settings migration
- no Streamlit streaming UI

For frontend-specific notes, see `frontend/README.md`.

## API / Model Configuration

The default model is `deepseek-v4-flash`. The built-in model choices are:

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `custom`

First-time users can use the Quick Start wizard. Daily changes can be made from the sidebar through **API / Model Settings**, which includes:

- API Key input
- Base URL
- default model selection
- custom model name
- connection test entry
- save button

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
|-- app.py
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

The main writing area uses a focused **Chapter Creation** workflow:

- **Continue next chapter**: scans the current project and generates the largest chapter number + 1.
- **Specified chapter**: uses the chapter number entered by the user.
- **Batch chapters**: generates a start-to-end chapter range.
- **Prompt preview**: previews chapter-writing messages only.

Outline and character cards are treated as setting assets and live near the novel setting controls.

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
