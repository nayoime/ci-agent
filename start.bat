@echo off
chcp 65001 >nul
rem 非管理员时自动请求提权（弹一次 UAC），之后所有子命令都继承管理员权限
net session >nul 2>&1
if errorlevel 1 (
	if "%~1"=="" (
		powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
	) else (
		powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
	)
	exit /b
)
rem Ciallo Agent web UI: http://127.0.0.1:8787 (token printed below)
cd /d "%~dp0"
node src\server.js %*
pause
