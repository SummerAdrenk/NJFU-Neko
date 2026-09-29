@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title NJFU智慧猫娘

rem ---- 找 Node：NEKO_NODE 环境变量 → PATH → fnm 安装目录 ----
if defined NEKO_NODE set "PATH=%NEKO_NODE%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  for %%D in ("%FNM_DIR%" "%APPDATA%\fnm" "%LOCALAPPDATA%\fnm" "D:\Code\fnm" "C:\fnm") do (
    if exist "%%~D\node-versions" (
      for /d %%V in ("%%~D\node-versions\*") do (
        if exist "%%~V\installation\node.exe" set "NODE_DIR=%%~V\installation"
      )
    )
  )
  if defined NODE_DIR set "PATH=!NODE_DIR!;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo [×] 找不到 Node.js。请到 https://nodejs.org/ 安装 20 以上的版本，
  echo     或者把 node.exe 所在的文件夹设置到环境变量 NEKO_NODE。
  pause
  exit /b 1
)

rem ---- 第一次运行：安装依赖、下载 ViaProxy、生成 config.toml ----
if not exist node_modules (
  echo 正在安装依赖……
  call npm install
  if errorlevel 1 goto :fail
)
if not exist runtime\viaproxy\ViaProxy.jar (
  call node scripts\setup.js
  if errorlevel 1 goto :fail
)
if not exist config.toml (
  call node scripts\setup.js
  echo.
  echo 已生成 config.toml：请用记事本打开，按注释改好服务器端口、大脑模式等，然后重新运行 start.bat。
  pause
  exit /b 0
)

node src\index.js
echo.
echo 猫娘已下线。
pause
exit /b 0

:fail
echo [×] 准备失败，请查看上面的提示。
pause
exit /b 1
