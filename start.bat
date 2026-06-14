@echo off
setlocal
cd /d "%~dp0"

echo [DEPRECATED] The Streamlit frontend has been retired.
echo [INFO] Braipen now uses React + FastAPI as the only official frontend.
echo [INFO] Redirecting to start-react.bat...
echo.

if not exist "start-react.bat" (
    echo [ERROR] start-react.bat not found.
    pause
    exit /b 1
)

call "%~dp0start-react.bat"

pause
