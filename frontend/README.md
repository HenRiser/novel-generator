# React Reader Foundation

This frontend is the first-stage React reader for `novel-generator`. It only consumes the existing read-only FastAPI endpoints.

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
- Project list
- Project detail summary
- Chapter list
- Chapter content reading
- Single chapter TXT link
- Full book TXT link
- Basic loading and error states

Not implemented in this stage:

- Setting expansion
- Outline / character generation
- Chapter generation
- Batch generation
- Save APIs
- Model or API Key settings
- Streaming output
- WebSocket or SSE
- Task status APIs
