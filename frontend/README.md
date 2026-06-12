# React Reader / Generation Foundation

This frontend is the React reader and generation surface for `novel-generator`. It consumes the FastAPI read endpoints, uses streaming single-chapter generation by default, and keeps the synchronous generation endpoint as a fallback path.

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

- API health status
- API generation status
- Project list
- Project detail summary
- Chapter list
- Chapter content reading
- Single chapter TXT link
- Full book TXT link
- Generate / update outline and character files
- Generate a specified chapter with streaming output by default
- Keep synchronous specified-chapter generation as a fallback
- Show live chapter text while streaming, including preview status and character count
- Refresh chapters and open the generated chapter after generation
- Basic loading, generation status, saved-file, and error states

Not implemented in this stage:

- Setting expansion
- Batch generation
- Batch generation API
- Batch streaming generation
- Save APIs
- Model or API Key settings
- Streamlit streaming UI
- Cancellation API
- Draft recovery for partial streaming output
- WebSocket or SSE

Single-chapter generation in React calls `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate/stream` and reads newline-delimited JSON events with `fetch()` and `ReadableStream`. The existing synchronous `POST /api/projects/{project_ref}/chapters/{chapter_number}/generate` endpoint remains available as the "synchronous fallback" button.

Streaming preview behavior:

- The main chapter generation button uses streaming output by default.
- Text shown before the `done` event is a live preview, not a saved chapter.
- The chapter is marked saved only after the API finishes chapter save, summary save, and index update.
- If streaming fails or the request is interrupted, the preview remains visible and is marked as unsaved.
- Failed partial preview text is not written to the official chapter file.
- If generated content appears cut off, increase `max_tokens` or regenerate that chapter.

Streamlit currently continues to use the synchronous generation workflow.
