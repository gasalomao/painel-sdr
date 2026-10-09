#!/bin/bash

# Script de verificação pré-deploy para Easy Panel
# Execute antes de fazer push para garantir que tudo está correto

set -e

echo "🔍 Verificação Pré-Deploy - Painel SDR"
echo "======================================"
echo ""

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Contador de erros
ERRORS=0
WARNINGS=0

# 1. Verificar Node.js
echo "📦 Verificando Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓${NC} Node.js instalado: $NODE_VERSION"

    # Verificar versão mínima (22.x)
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
    if [ "$MAJOR_VERSION" -lt 22 ]; then
        echo -e "${YELLOW}⚠${NC} Aviso: Node.js $NODE_VERSION detectado. Recomendado: 22.x ou superior"
        ((WARNINGS++))
    fi
else
    echo -e "${RED}✗${NC} Node.js não encontrado"
    ((ERRORS++))
fi
echo ""

# 2. Verificar package.json
echo "📋 Verificando package.json..."
if [ -f "package.json" ]; then
    echo -e "${GREEN}✓${NC} package.json encontrado"

    # Verificar scripts necessários
    if grep -q '"build":' package.json; then
        echo -e "${GREEN}✓${NC} Script 'build' presente"
    else
        echo -e "${RED}✗${NC} Script 'build' não encontrado"
        ((ERRORS++))
    fi

    if grep -q '"start":' package.json; then
        echo -e "${GREEN}✓${NC} Script 'start' presente"
    else
        echo -e "${RED}✗${NC} Script 'start' não encontrado"
        ((ERRORS++))
    fi
else
    echo -e "${RED}✗${NC} package.json não encontrado"
    ((ERRORS++))
fi
echo ""

# 3. Verificar .env.example
echo "🔐 Verificando variáveis de ambiente..."
if [ -f ".env.example" ]; then
    echo -e "${GREEN}✓${NC} .env.example encontrado"
else
    echo -e "${YELLOW}⚠${NC} .env.example não encontrado"
    ((WARNINGS++))
fi

if [ -f ".env" ] || [ -f ".env.local" ]; then
    echo -e "${YELLOW}⚠${NC} Arquivo .env ou .env.local detectado - certifique-se de que está no .gitignore"
    ((WARNINGS++))
fi
echo ""

# 4. Verificar .gitignore
echo "🚫 Verificando .gitignore..."
if [ -f ".gitignore" ]; then
    echo -e "${GREEN}✓${NC} .gitignore encontrado"

    # Verificar se .env está ignorado
    if grep -q "^\.env" .gitignore; then
        echo -e "${GREEN}✓${NC} .env está no .gitignore"
    else
        echo -e "${RED}✗${NC} .env NÃO está no .gitignore - RISCO DE SEGURANÇA!"
        ((ERRORS++))
    fi

    # Verificar se node_modules está ignorado
    if grep -q "^node_modules" .gitignore; then
        echo -e "${GREEN}✓${NC} node_modules está no .gitignore"
    else
        echo -e "${RED}✗${NC} node_modules NÃO está no .gitignore"
        ((ERRORS++))
    fi
else
    echo -e "${RED}✗${NC} .gitignore não encontrado"
    ((ERRORS++))
fi
echo ""

# 5. Verificar migrations
echo "🗄️ Verificando migrations..."
if [ -d "migrations" ]; then
    MIGRATION_COUNT=$(ls migrations/*.sql 2>/dev/null | wc -l)
    if [ "$MIGRATION_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓${NC} $MIGRATION_COUNT migrations encontradas"

        # Listar as migrations
        echo "  Migrations disponíveis:"
        ls migrations/*.sql | sort | sed 's/^/    /'
    else
        echo -e "${YELLOW}⚠${NC} Nenhuma migration encontrada em migrations/"
        ((WARNINGS++))
    fi
else
    echo -e "${YELLOW}⚠${NC} Pasta migrations/ não encontrada"
    ((WARNINGS++))
fi
echo ""

# 6. Verificar estrutura de pastas
echo "📁 Verificando estrutura de pastas..."
REQUIRED_DIRS=("src" "src/app" "src/components" "src/lib")
for dir in "${REQUIRED_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        echo -e "${GREEN}✓${NC} $dir/ existe"
    else
        echo -e "${RED}✗${NC} $dir/ não encontrado"
        ((ERRORS++))
    fi
done
echo ""

# 7. Verificar dependências críticas
echo "📦 Verificando dependências críticas..."
if [ -f "package.json" ]; then
    CRITICAL_DEPS=("next" "react" "@supabase/supabase-js" "typescript")
    for dep in "${CRITICAL_DEPS[@]}"; do
        if grep -q "\"$dep\":" package.json; then
            echo -e "${GREEN}✓${NC} $dep presente"
        else
            echo -e "${RED}✗${NC} $dep NÃO encontrado"
            ((ERRORS++))
        fi
    done
fi
echo ""

# 8. Verificar git
echo "🔀 Verificando git..."
if [ -d ".git" ]; then
    echo -e "${GREEN}✓${NC} Repositório git inicializado"

    # Verificar remote
    if git remote -v | grep -q "origin"; then
        REMOTE_URL=$(git remote get-url origin)
        echo -e "${GREEN}✓${NC} Remote configurado: $REMOTE_URL"
    else
        echo -e "${YELLOW}⚠${NC} Nenhum remote configurado"
        ((WARNINGS++))
    fi

    # Verificar branch
    CURRENT_BRANCH=$(git branch --show-current)
    echo -e "${GREEN}✓${NC} Branch atual: $CURRENT_BRANCH"

    # Verificar mudanças não commitadas
    if [ -n "$(git status --porcelain)" ]; then
        CHANGED_FILES=$(git status --porcelain | wc -l)
        echo -e "${YELLOW}⚠${NC} $CHANGED_FILES arquivos com mudanças não commitadas"
        ((WARNINGS++))
    else
        echo -e "${GREEN}✓${NC} Nenhuma mudança pendente"
    fi
else
    echo -e "${RED}✗${NC} Não é um repositório git"
    ((ERRORS++))
fi
echo ""

# 9. Verificar Next.js config
echo "⚙️ Verificando Next.js config..."
if [ -f "next.config.mjs" ] || [ -f "next.config.js" ]; then
    echo -e "${GREEN}✓${NC} Next.js config encontrado"
else
    echo -e "${YELLOW}⚠${NC} Next.js config não encontrado"
    ((WARNINGS++))
fi
echo ""

# 10. Verificar TypeScript config
echo "📘 Verificando TypeScript config..."
if [ -f "tsconfig.json" ]; then
    echo -e "${GREEN}✓${NC} tsconfig.json encontrado"
else
    echo -e "${YELLOW}⚠${NC} tsconfig.json não encontrado"
    ((WARNINGS++))
fi
echo ""

# Resumo final
echo "======================================"
echo "📊 RESUMO DA VERIFICAÇÃO"
echo "======================================"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ TUDO OK!${NC} Projeto pronto para deploy."
    echo ""
    echo "Próximos passos:"
    echo "1. git add ."
    echo "2. git commit -m 'feat: preparar para deploy'"
    echo "3. git push origin main"
    echo "4. Configurar variáveis de ambiente no Easy Panel"
    echo "5. Executar migrations no Supabase"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️ AVISOS ENCONTRADOS${NC}"
    echo "Erros: $ERRORS"
    echo "Avisos: $WARNINGS"
    echo ""
    echo "O projeto pode funcionar, mas revise os avisos acima."
    exit 0
else
    echo -e "${RED}❌ ERROS ENCONTRADOS${NC}"
    echo "Erros: $ERRORS"
    echo "Avisos: $WARNINGS"
    echo ""
    echo "Corrija os erros antes de fazer deploy."
    exit 1
fi
