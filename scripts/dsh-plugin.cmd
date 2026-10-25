@echo off
rem Wrapper: invoke the DSH CLI with quoting that survives spaces in the install path.
setlocal
set "DSH_HOME_BIN=C:\Users\taole\AppData\Local\Programs\DeepSeek Harness"
set ELECTRON_RUN_AS_NODE=1
"%DSH_HOME_BIN%\DeepSeek Harness.exe" --expose-internals "%DSH_HOME_BIN%\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
