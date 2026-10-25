@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo You need Node.js 22 or later / Necesitas Node.js 22 o superior: https://nodejs.org & pause & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo .env created: fill in TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, save, close Notepad and run iniciar.bat again. / Se ha creado .env: rellena TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET, guarda, cierra el Bloc de notas y vuelve a ejecutar iniciar.bat. & notepad .env & pause & exit /b 0)
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
