@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title NJFU智慧猫娘

echo.
echo   NJFU智慧猫娘
echo.

rem ---- 1. 找 Node.js 20+：NEKO_NODE 环境变量 → PATH → 常见安装位置（官方安装包、fnm、nvm-windows、Volta）----
if defined NEKO_NODE set "PATH=%NEKO_NODE%;%PATH%"
call :find_node
if not defined NODE_OK (
  echo [!] 没找到 Node.js 20 或更高版本。猫娘是用 Node.js 写的，要先装它。
  where winget >nul 2>nul
  if not errorlevel 1 (
    set "ANS="
    set /p "ANS=    要现在自动安装 Node.js（长期支持版）吗？[Y/n] "
    if /i not "!ANS!"=="n" (
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      set "PATH=%ProgramFiles%\nodejs;!PATH!"
      call :find_node
    )
  )
)
if not defined NODE_OK (
  echo.
  echo [×] 还是找不到 Node.js。请在打开的网页里下载“长期支持版（LTS）”安装包，
  echo     一路“下一步”装好，再重新双击 start.bat。
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)

rem ---- 2. 其余的准备交给 setup.js：依赖、第一次运行的配置问答、Java、ViaProxy ----
node scripts\setup.js
if errorlevel 1 goto :fail

rem ---- 3. 启动（已经有一个猫娘在运行时，这个会提示后自动退出）----
echo.
node src\index.js
echo.
echo 猫娘已下线。
pause
exit /b 0

:fail
echo.
echo [×] 准备失败，请看上面的提示。
pause
exit /b 1

rem ---- 找 Node.js：找到 20+ 就设置 NODE_OK ----
:find_node
set "NODE_OK="
where node >nul 2>nul
if not errorlevel 1 call :check_node
if defined NODE_OK exit /b 0
for %%D in ("%ProgramFiles%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%NVM_SYMLINK%" "%LOCALAPPDATA%\Volta\bin" "%ProgramFiles%\Volta") do (
  if not defined NODE_OK if not "%%~D"=="" if exist "%%~D\node.exe" (
    set "PATH=%%~D;!PATH!"
    call :check_node
  )
)
if defined NODE_OK exit /b 0
for %%D in ("%FNM_DIR%" "%APPDATA%\fnm" "%LOCALAPPDATA%\fnm") do (
  if not defined NODE_OK if not "%%~D"=="" if exist "%%~D\node-versions" (
    for /d %%V in ("%%~D\node-versions\*") do (
      if not defined NODE_OK if exist "%%~V\installation\node.exe" (
        set "PATH=%%~V\installation;!PATH!"
        call :check_node
      )
    )
  )
)
exit /b 0

:check_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE_OK=1"
exit /b 0
