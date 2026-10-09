# Painel SDR

Plataforma multi-tenant completa para gestão de SDR (Sales Development Representative) com integração WhatsApp, IA e automações.

## 🚀 Tecnologias

- **Frontend**: Next.js 16 (App Router) + React 19 + TypeScript 5 + Tailwind 4
- **Backend**: Next.js API Routes + Supabase (PostgreSQL + RLS)
- **Realtime**: Supabase Realtime + Redis + BullMQ
- **WhatsApp**: Evolution API (Node.js + Baileys)
- **IA**: OpenRouter + Google AI + DeepSeek
- **UI**: shadcn/ui + Lucide Icons + Sonner + Recharts

## ✨ Funcionalidades

### Core
- ✅ Multi-tenant completo (empresas isoladas)
- ✅ Autenticação e autorização (Supabase Auth)
- ✅ Dashboard com métricas em tempo real
- ✅ Gestão de usuários e permissões

### WhatsApp
- ✅ Integração Evolution API (multi-instância)
- ✅ Envio e recebimento de mensagens
- ✅ Webhooks para eventos em tempo real
- ✅ Suporte a mídias (imagens, áudeos, documentos)
- ✅ Status de entrega e leitura

### CRM & Vendas
- ✅ Gestão de contatos (leads/clientes)
- ✅ Histórico de conversas
- ✅ Pipeline de vendas (quadros kanban)
- ✅ Atividades e follow-ups
- ✅ Integração Google Calendar

### Automação & IA
- ✅ Respostas automáticas com IA
- ✅ Classificação de mensagens
- ✅ Análise de sentimento
- ✅ Sugestões de resposta
- ✅ Filas de processamento (BullMQ)

### Site Studio (Beta)
- ✅ Geração de sites com IA
- ✅ Editor visual em tempo real
- ✅ Deploy automático
- ✅ Design system Impeccable
- ✅ Modelos gratuitos disponíveis

## 📦 Instalação

### Pré-requisitos

- Node.js 22.x ou superior
- npm ou yarn
- Conta no Supabase
- Conta na Evolution API
- Redis (opcional, mas recomendado)

### 1. Clone o Repositório

```bash
git clone https://github.com/gasalomao/painel-sdr.git
cd painel-sdr
```

### 2. Instale as Dependências

```bash
npm install
```

### 3. Configure as Variáveis de Ambiente

```bash
cp .env.example .env.local
```

Edite `.env.local` com suas credenciais:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key

# Evolution API
EVOLUTION_API_URL=https://sua-evolution-api.com
EVOLUTION_API_KEY=sua-api-key
EVOLUTION_INSTANCE=sdr

# Redis (opcional)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# App
ADMIN_PASSWORD=sua-senha-admin
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Configure o Banco de Dados

Execute as migrations no Supabase SQL Editor:

```bash
# Execute em ordem:
migrations/001_initial_schema.sql
migrations/002_*.sql
...
migrations/017_*.sql
```

### 5. Inicie o Servidor de Desenvolvimento

```bash
npm run dev
```

Acesse: http://localhost:3000

### 6. Inicie os Workers (Opcional)

Se você tem Redis configurado:

```bash
npm run workers
```

## 🏗️ Estrutura do Projeto

```
painel-sdr/
├── src/
│   ├── app/              # Next.js App Router
│   │   ├── api/          # API Routes
│   │   ├── dashboard/    # Dashboard pages
│   │   ├── sites/        # Site Studio
│   │   └── ...
│   ├── components/       # React components
│   │   ├── ui/           # shadcn/ui components
│   │   ├── sites/        # Site Studio components
│   │   └── ...
│   ├── lib/              # Utilities e clientes
│   │   ├── supabase.ts   # Supabase client
│   │   ├── redis.ts      # Redis client
│   │   ├── sites/        # Site Studio engine
│   │   └── ...
│   ├── workers/          # BullMQ workers
│   └── types/            # TypeScript types
├── migrations/           # SQL migrations
├── scripts/              # Scripts utilitários
├── public/               # Assets estáticos
└── ...
```

## 🚀 Deploy

### Easy Panel (Recomendado)

Veja o guia completo em [README-DEPLOY.md](./README-DEPLOY.md)

**Resumo:**

1. Configure o Supabase e execute as migrations
2. Crie um novo app no Easy Panel
3. Conecte ao GitHub
4. Configure as variáveis de ambiente
5. Deploy automático!

### Outras Plataformas

- **Vercel**: Suporta Next.js nativamente
- **Railway**: Simples e rápido
- **Render**: Alternativa ao Heroku
- **DigitalOcean App Platform**: Escalável

## 🧪 Testes

```bash
# Testes unitários
npm test

# Testes com coverage
npm run test:coverage

# Testes específicos
npm test -- src/lib/sites

# Testes Site Studio E2E
npx tsx scripts/test-site-studio-e2e.ts
```

## 📝 Scripts Úteis

```bash
# Desenvolvimento
npm run dev              # Inicia dev server
npm run workers          # Inicia BullMQ workers
npm run sites:worker     # Worker dedicado Site Studio

# Build
npm run build            # Build de produção
npm run start            # Inicia produção

# Qualidade
npm run lint             # ESLint
npm run type-check       # TypeScript check
npm test                 # Vitest

# Utilitários
npm run setup-sql        # Gera SQL consolidado
```

## 🔐 Segurança

- ✅ Row Level Security (RLS) em todas as tabelas
- ✅ Validação de entrada com Zod
- ✅ Sanitização de HTML
- ✅ Rate limiting em APIs
- ✅ Webhooks com validação HMAC
- ✅ Secrets via variáveis de ambiente
- ✅ CORS configurado

## 📚 Documentação

- [Deploy Guide](./README-DEPLOY.md) - Como fazer deploy no Easy Panel
- [Site Studio](./docs/SITE_STUDIO.md) - Documentação completa do módulo
- [Migrations](./migrations/README.md) - Como gerenciar migrations
- [API Reference](./docs/API.md) - Documentação das APIs

## 🤝 Contribuindo

Contribuições são bem-vindas!

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-funcionalidade`)
3. Commit suas mudanças (`git commit -m 'feat: adiciona nova funcionalidade'`)
4. Push para a branch (`git push origin feature/nova-funcionalidade`)
5. Abra um Pull Request

### Convenções de Commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` Nova funcionalidade
- `fix:` Correção de bug
- `docs:` Documentação
- `style:` Formatação
- `refactor:` Refatoração
- `test:` Testes
- `chore:` Manutenção

## 📄 Licença

Este projeto é proprietário e confidencial.

## 🆘 Suporte

- **Issues**: [GitHub Issues](https://github.com/gasalomao/painel-sdr/issues)
- **Documentação**: Veja a pasta `docs/`
- **Email**: suporte@exemplo.com

## 🎯 Roadmap

### Em Desenvolvimento
- [ ] Site Studio: templates prontos
- [ ] Integração com Facebook Messenger
- [ ] Integração com Instagram Direct
- [ ] Dashboard de Analytics avançado

### Planejado
- [ ] App mobile (React Native)
- [ ] Integração com Telegram
- [ ] Chatbot builder visual
- [ ] Marketplace de templates

## 📊 Status

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)]()
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)]()
[![Coverage](https://img.shields.io/badge/coverage-85%25-green)]()
[![License](https://img.shields.io/badge/license-proprietary-blue)]()

---

**Desenvolvido com ❤️ por [Gabriel Salomão](https://github.com/gasalomao)**

**Última atualização**: 2025-01-08
