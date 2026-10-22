@echo off
chcp 65001 >nul
title AIプレイ操作盤
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node launch.mjs
if errorlevel 1 pause
exit /b

:nonode
echo Node.js が見つかりません。
echo 開いたページから LTS 版を入れてから、もう一度このファイルをダブルクリックしてください。
start "" https://nodejs.org/ja
pause
