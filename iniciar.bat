@echo off
rem Inicia o Radar de Precos e abre o painel no navegador.
cd /d "%~dp0"
if not exist node_modules call npm install
start "" http://localhost:3000
npm start
