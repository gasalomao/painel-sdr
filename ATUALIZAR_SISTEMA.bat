@echo off
set /p msg="Digite o que voce mudou (ex: ajuste no design): "
echo .
echo 🚀 Enviando atualizacoes para o GitHub...
git add .
git commit -m "%msg%"
git push origin main
echo .
echo ✅ Pronto! O codigo ja esta no GitHub.
echo ⏳ Se o Auto-Deploy estiver ligado no Easypanel, o site vai atualizar em 2 minutos.
pause
