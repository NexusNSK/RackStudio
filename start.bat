@echo off
title RackStudio Server
cd /d "%~dp0"
echo ===================================================
echo   RackStudio - Интерактивный конструктор стоек
echo ===================================================
echo Запуск локального сервера на http://localhost:8080 ...
start http://localhost:8080
python -m http.server 8080
pause
