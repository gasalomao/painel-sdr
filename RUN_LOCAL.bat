@echo off
echo ==========================================
echo   Salomao AI - Iniciar Painel SDR Local
echo ==========================================
echo.

if not exist .env.local (
    echo [!] Arquivo .env.local nao encontrado!
    echo [!] Criando .env.local a partir do exemplo...
    copy .env.example .env.local
    echo [!] Por favor, preencha o seu .env.local com suas credenciais.
    pause
    exit
)

echo [1] Instalando dependencias (se necessario)...
call npm install

echo.
echo [2] Iniciando o servidor de desenvolvimento...
echo [!] O painel abrira em: http://localhost:3000
echo.

npm run dev
pause
