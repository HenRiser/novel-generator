@echo off
setlocal
cd /d "%~dp0"

echo [INFO] Setting up novel-generator...

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python and add it to PATH.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\activate.bat" (
    echo [INFO] Creating virtual environment...
    python -m venv .venv
) else (
    echo [INFO] Virtual environment already exists.
)

call .venv\Scripts\activate.bat

if exist "requirements.txt" (
    echo [INFO] Installing dependencies...
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) else (
    echo [ERROR] requirements.txt not found.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [INFO] Created .env from .env.example.
        echo [WARN] Please edit .env and fill DEEPSEEK_API_KEY.
    ) else (
        echo [WARN] .env.example not found. Please create .env manually.
    )
) else (
    echo [INFO] .env already exists. Keeping it unchanged.
)

echo [INFO] Setup complete.
echo [INFO] Run start.bat to start the app.
pause
