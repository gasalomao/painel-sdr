# Script de Inicialização Automática - Vidrão Site Studio
# Uso: .\start.ps1

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         🚀 VIDRÃO SITE STUDIO - INICIALIZAÇÃO 🚀              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Verificar se está no diretório correto
if (-not (Test-Path "package.json")) {
    Write-Host "❌ ERRO: Execute este script na raiz do projeto!" -ForegroundColor Red
    Write-Host "   Navegue até: C:\Users\Salomão\Desktop\painel-sdr-main" -ForegroundColor Yellow
    exit 1
}

# Verificar .env.local
if (-not (Test-Path ".env.local")) {
    Write-Host "⚠️  AVISO: Arquivo .env.local não encontrado!" -ForegroundColor Yellow
    Write-Host "   Crie o arquivo com as variáveis de ambiente necessárias." -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "Continuar mesmo assim? (s/N)"
    if ($continue -ne "s") {
        exit 1
    }
}

# Verificar node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Instalando dependências..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Falha ao instalar dependências!" -ForegroundColor Red
        exit 1
    }
}

Write-Host "✅ Pré-requisitos verificados!" -ForegroundColor Green
Write-Host ""

# Escolher modo
Write-Host "Escolha o modo de inicialização:" -ForegroundColor Yellow
Write-Host "  1) Completo (Worker + Dev Server) - Recomendado" -ForegroundColor White
Write-Host "  2) Apenas Worker" -ForegroundColor White
Write-Host "  3) Apenas Dev Server" -ForegroundColor White
Write-Host "  4) Testes (Watch mode)" -ForegroundColor White
Write-Host ""
$mode = Read-Host "Opção (1-4)"

switch ($mode) {
    "1" {
        Write-Host ""
        Write-Host "🚀 Iniciando sistema completo..." -ForegroundColor Green
        Write-Host ""
        Write-Host "INSTRUÇÕES:" -ForegroundColor Yellow
        Write-Host "  • Terminal 1 (Worker) abrirá automaticamente" -ForegroundColor White
        Write-Host "  • Terminal 2 (Dev Server) abrirá automaticamente" -ForegroundColor White
        Write-Host "  • Aguarde ~30 segundos até ambos iniciarem" -ForegroundColor White
        Write-Host "  • Depois abra: http://localhost:3000/sites" -ForegroundColor Cyan
        Write-Host "  • DevTools (F12) → Console para ver logs SSE" -ForegroundColor White
        Write-Host ""
        Write-Host "📝 Ver: TESTE_REALTIME.md para procedimentos de teste" -ForegroundColor Yellow
        Write-Host ""

        # Abrir Worker em novo terminal
        Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host ''; Write-Host '╔═══════════════════════════════════╗' -ForegroundColor Cyan; Write-Host '║     WORKER - Processador IA       ║' -ForegroundColor Cyan; Write-Host '╚═══════════════════════════════════╝' -ForegroundColor Cyan; Write-Host ''; npm run sites:worker"

        Start-Sleep -Seconds 2

        # Abrir Dev Server em novo terminal
        Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host ''; Write-Host '╔═══════════════════════════════════╗' -ForegroundColor Cyan; Write-Host '║     DEV SERVER - Next.js          ║' -ForegroundColor Cyan; Write-Host '╚═══════════════════════════════════╝' -ForegroundColor Cyan; Write-Host ''; npm run dev"

        Write-Host "✅ Terminais abertos!" -ForegroundColor Green
        Write-Host ""
        Write-Host "⏳ Aguardando ~15 segundos para inicialização..." -ForegroundColor Yellow
        Start-Sleep -Seconds 15

        # Abrir browser
        Write-Host "🌐 Abrindo browser..." -ForegroundColor Green
        Start-Process "http://localhost:3000/sites"

        Write-Host ""
        Write-Host "✨ Sistema iniciado com sucesso!" -ForegroundColor Green
        Write-Host ""
        Write-Host "📋 Próximos passos:" -ForegroundColor Yellow
        Write-Host "  1. Criar novo projeto de site" -ForegroundColor White
        Write-Host "  2. Abrir DevTools (F12) → Console" -ForegroundColor White
        Write-Host "  3. Enviar prompt: 'Crie um site simples'" -ForegroundColor White
        Write-Host "  4. Ver logs SSE no console" -ForegroundColor White
        Write-Host ""
    }

    "2" {
        Write-Host ""
        Write-Host "⚙️  Iniciando apenas Worker..." -ForegroundColor Yellow
        npm run sites:worker
    }

    "3" {
        Write-Host ""
        Write-Host "🌐 Iniciando apenas Dev Server..." -ForegroundColor Yellow
        npm run dev
    }

    "4" {
        Write-Host ""
        Write-Host "🧪 Iniciando testes em modo watch..." -ForegroundColor Yellow
        npm test -- --watch
    }

    default {
        Write-Host ""
        Write-Host "❌ Opção inválida!" -ForegroundColor Red
        exit 1
    }
}
