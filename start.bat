@echo off
setlocal
cd /d "%~dp0"

echo [INFO] Starting novel-generator...

if not exist ".venv\Scripts\activate.bat" (
    echo [ERROR] Virtual environment not found.
    echo [INFO] Please run setup.bat first.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [WARN] Created .env from .env.example.
        echo [WARN] Please edit .env and fill DEEPSEEK_API_KEY before generating content.
    ) else (
        echo [WARN] .env not found and .env.example not found.
    )
)

call .venv\Scripts\activate.bat

start "" "http://localhost:8501"
streamlit run app.py --server.port 8501

pause
