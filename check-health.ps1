# Script de Verificação de Saúde - Vidrão Site Studio
# Uso: .\check-health.ps1

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         🏥 VERIFICAÇÃO DE SAÚDE DO SISTEMA 🏥                 ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$checks = @()
$passed = 0
$failed = 0

function Test-Check {
    param($name, $test, $fix)
    Write-Host "Verificando: $name... " -NoNewline -ForegroundColor White
    if (& $test) {
        Write-Host "✅ OK" -ForegroundColor Green
        $script:passed++
        return $true
    } else {
        Write-Host "❌ FALHOU" -ForegroundColor Red
        if ($fix) {
            Write-Host "  └─> Solução: $fix" -ForegroundColor Yellow
        }
        $script:failed++
        return $false
    }
}

# 1. Verificar diretório
Test-Check "Diretório do projeto" {
    Test-Path "package.json"
} "Navegue até C:\Users\Salomão\Desktop\painel-sdr-main"

# 2. Verificar Node.js
Test-Check "Node.js instalado" {
    try { node --version | Out-Null; $true } catch { $false }
} "Instale Node.js: https://nodejs.org"

# 3. Verificar npm
Test-Check "npm instalado" {
    try { npm --version | Out-Null; $true } catch { $false }
} "Reinstale Node.js"

# 4. Verificar node_modules
Test-Check "Dependências instaladas" {
    Test-Path "node_modules"
} "Execute: npm install"

# 5. Verificar .env.local
$hasEnv = Test-Check ".env.local existe" {
    Test-Path ".env.local"
} "Crie arquivo .env.local com variáveis necessárias"

# 6. Verificar variáveis críticas (se .env existe)
if ($hasEnv) {
    $env = Get-Content ".env.local" -Raw

    Test-Check "NEXT_PUBLIC_SUPABASE_URL" {
        $env -match "NEXT_PUBLIC_SUPABASE_URL="
    } "Adicione NEXT_PUBLIC_SUPABASE_URL ao .env.local"

    Test-Check "SUPABASE_SERVICE_ROLE_KEY" {
        $env -match "SUPABASE_SERVICE_ROLE_KEY="
    } "Adicione SUPABASE_SERVICE_ROLE_KEY ao .env.local"

    Test-Check "OPENROUTER_API_KEY" {
        $env -match "OPENROUTER_API_KEY="
    } "Adicione OPENROUTER_API_KEY ao .env.local"
}

# 7. Verificar porta 3000 livre
Test-Check "Porta 3000 disponível" {
    $connections = netstat -ano | Select-String ":3000"
    $connections.Count -eq 0
} "Porta 3000 em uso. Matar processo ou usar porta diferente"

# 8. Verificar TypeScript
Test-Check "TypeScript compilando" {
    try {
        $result = npx tsc --noEmit --incremental false 2>&1 | Select-String "error TS"
        $result.Count -eq 0
    } catch {
        $false
    }
} "Ver erros com: npx tsc --noEmit"

# 9. Verificar arquivos modificados existem
Test-Check "worker.ts modificado" {
    $content = Get-Content "src\lib\sites\worker.ts" -Raw
    $content -match "website_run_activities"
} "Arquivo não foi modificado corretamente"

Test-Check "agent.ts modificado" {
    $content = Get-Content "src\lib\sites\agent.ts" -Raw
    $content -match "Checkpoint incremental"
} "Arquivo não foi modificado corretamente"

Test-Check "page.tsx modificado" {
    $content = Get-Content "src\app\sites\[projectId]\page.tsx" -Raw
    $content -match "EventSource"
} "Arquivo não foi modificado corretamente"

# 10. Verificar documentação
Test-Check "Documentação completa" {
    (Test-Path "COMO_INICIAR.md") -and
    (Test-Path "TESTE_REALTIME.md") -and
    (Test-Path "README_IMPLEMENTACAO.md")
} "Documentação faltando"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Resumo
$total = $passed + $failed
$percentage = [math]::Round(($passed / $total) * 100, 0)

if ($failed -eq 0) {
    Write-Host "🎉 SISTEMA 100% SAUDÁVEL!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Tudo pronto para uso!" -ForegroundColor White
    Write-Host ""
    Write-Host "Próximos passos:" -ForegroundColor Yellow
    Write-Host "  1. Execute: .\start.ps1" -ForegroundColor Cyan
    Write-Host "  2. Ou manual: npm run sites:worker (Terminal 1)" -ForegroundColor Cyan
    Write-Host "                npm run dev (Terminal 2)" -ForegroundColor Cyan
    Write-Host ""
} elseif ($percentage -ge 80) {
    Write-Host "⚠️  SISTEMA PARCIALMENTE SAUDÁVEL ($percentage%)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Verificações: $passed passou | $failed falhou" -ForegroundColor White
    Write-Host ""
    Write-Host "Corrija os itens marcados ❌ acima antes de continuar." -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "❌ SISTEMA NÃO ESTÁ PRONTO ($percentage%)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Verificações: $passed passou | $failed falhou" -ForegroundColor White
    Write-Host ""
    Write-Host "Corrija TODOS os itens marcados ❌ acima." -ForegroundColor Red
    Write-Host ""
}

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Informações adicionais
Write-Host "📚 Documentação disponível:" -ForegroundColor Cyan
Write-Host "  • README_IMPLEMENTACAO.md - Comece aqui" -ForegroundColor White
Write-Host "  • COMO_INICIAR.md - Como rodar" -ForegroundColor White
Write-Host "  • TESTE_REALTIME.md - Como testar" -ForegroundColor White
Write-Host ""

exit $failed
