@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 局域快传 · LanDrop

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未检测到 Node.js，请先安装：https://nodejs.org/  ^(选 LTS 版本^)
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动局域快传，稍后浏览器会自动打开…
echo   关闭这个窗口即停止服务。
echo.
node server.js --open

echo.
echo   服务已停止。
pause
