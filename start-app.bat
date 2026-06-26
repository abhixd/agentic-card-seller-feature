@echo off
title Card Seller OS - dev server
cd /d "%~dp0"
echo ============================================
echo   Starting Card Seller OS dev server...
echo   Leave this window OPEN. Close it to stop.
echo   App will be at http://localhost:3000
echo ============================================
echo.
call npm run web
echo.
echo Server stopped. Press any key to close.
pause >nul
