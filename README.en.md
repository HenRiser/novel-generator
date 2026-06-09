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

Start the app:

```bat
streamlit run app.py
```

Then open:

```text
http://localhost:8501
```

Windows users can also run `setup.bat` and `start.bat`.

Start the first-stage read-only API backend in a separate terminal:

```bat
.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

The API is available at:

```text
http://127.0.0.1:8000
```

This first-stage API exposes only health, project listing/detail, chapter reading, and TXT export endpoints. It does not implement generation endpoints, streaming output, WebSocket, task queues, user accounts, or save APIs.

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
