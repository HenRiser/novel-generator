@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo Starting novel-generator React frontend...
echo.
echo FastAPI: http://127.0.0.1:8000
echo React:   http://127.0.0.1:5173
echo.
echo start.bat       starts the Streamlit legacy frontend.
echo start-react.bat starts the FastAPI + React frontend.
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python virtual environment not found: .venv\Scripts\python.exe
    echo Please create or restore the virtual environment first.
    pause
    exit /b 1
)

if not exist "frontend\package.json" (
    echo [ERROR] frontend\package.json not found.
    pause
    exit /b 1
)

start "n-g FastAPI API" cmd /k "cd /d ""%ROOT%"" && .\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000"

if not exist "frontend\node_modules" (
    echo frontend\node_modules not found. npm install will run in the React window.
    start "n-g React Frontend" cmd /k "cd /d ""%ROOT%frontend"" && call npm install && call npm run dev -- --host 127.0.0.1 --port 5173"
) else (
    start "n-g React Frontend" cmd /k "cd /d ""%ROOT%frontend"" && call npm run dev -- --host 127.0.0.1 --port 5173"
)

timeout /t 3 >nul
start "" "http://127.0.0.1:5173"

echo React frontend startup commands launched.
echo Keep the FastAPI and React terminal windows open.
