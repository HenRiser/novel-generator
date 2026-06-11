# React Reader / Generation Foundation

This frontend is the React reader and generation surface for `novel-generator`. It consumes the FastAPI read endpoints, uses streaming single-chapter generation by default, and keeps the synchronous generation endpoint as a fallback path.

## Start the API

From the project root:

```bat
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Default API address:

```text
http://127.0.0.1:8000
```

## Start the React frontend

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
- Show live chapter text while streaming
- Refresh chapters and open the generated chapter after generation
- Basic loading and error states

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

Streamlit currently continues to use the synchronous generation workflow.
