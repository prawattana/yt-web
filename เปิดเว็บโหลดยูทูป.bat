@echo off
chcp 65001 >nul
title YT Downloader
cd /d "%~dp0"
echo เปิดเว็บโหลด YouTube ที่ http://localhost:6200
start "" http://localhost:6200
node server.js
pause
