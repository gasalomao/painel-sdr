# Evolution GO — Pesquisa e Documentação Técnica

> **Data da pesquisa:** 2026-07-14
> **Fonte oficial:** [github.com/evolution-foundation/evolution-go](https://github.com/evolution-foundation/evolution-go)
> **Docs oficiais:** [docs.evolutionfoundation.com.br/en/evolution-go](https://docs.evolutionfoundation.com.br/en/evolution-go)

---

## O que é o Evolution GO

**Evolution GO** é uma API de WhatsApp de **alta performance escrita em Go (Golang)**, parte do ecossistema da Evolution Foundation. Usa a biblioteca [whatsmeow](https://github.com/tulir/whatsmeow) (Go puro) em vez de Baileys (Node.js). É a evolução da Evolution API (Node.js).

## Diferenças: Evolution API vs Evolution GO

| Aspecto | Evolution API (atual) | Evolution GO (novo) |
|---------|----------------------|---------------------|
| **Linguagem** | TypeScript/Node.js | **Go (Golang)** |
| **Biblioteca WhatsApp** | Baileys | **whatsmeow** |
| **Performance** | Padrão | **Alta (minimal footprint)** |
| **Porta padrão** | 8080 | **8080** |
| **Gerenciador UI** | Manager externo | **Manager React embutido (/manager)** |
| **Licenciamento** | Open-source | **License management built-in (registro + ativação)** |
| **Banco** | SQLite/PostgreSQL/MySQL | **PostgreSQL (GORM)** |
| **Fila de eventos** | RabbitMQ (opcional) | **RabbitMQ + NATS + WebSocket** |
| **Storage de mídia** | Local/S3 | **MinIO/S3** |
| **Documentação API** | Swagger | **Swagger/OpenAPI** |
| **Framework HTTP** | Express/Node | **Gin** |

## Tech Stack Confirmada

| Componente | Tecnologia |
|------------|-----------|
| Linguagem | Go 1.24+ |
| HTTP framework | Gin |
| WhatsApp | whatsmeow |
| Banco | PostgreSQL (GORM) |
| Fila | RabbitMQ, NATS (opcionais) |
| Storage | MinIO/S3 (opcional) |
| Docs API | Swagger/OpenAPI |
| Container | Docker |

## Instalação (Docker)

```bash
# Clone
git clone https://github.com/evolution-foundation/evolution-go.git
cd evolution-go

# Build + Run
make docker-build
make docker-run

# Ou manualmente:
docker build -t evolution-go .
docker run -p 8080:8080 --env-file .env evolution-go
```

### Dockerfile (oficial, multi-stage)

```dockerfile
FROM golang:1.25.0-alpine AS build
RUN apk update && apk add --no-cache git build-base libjpeg-turbo-dev libwebp-dev
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -ldflags "-X main.version=dev" -o server ./cmd/evolution-go

FROM alpine:3.19.1 AS final
RUN apk update && apk add --no-cache tzdata ffmpeg libjpeg-turbo libwebp poppler-utils
WORKDIR /app
COPY --from=build /build/server .
COPY --from=build /build/manager/dist ./manager/dist
COPY --from=build /build/VERSION ./VERSION
ENV TZ=America/Sao_Paulo
ENTRYPOINT ["/app/server"]
```

**Dependências do container final:** tzdata, ffmpeg (conversão de mídia), libjpeg-turbo, libwebp, poppler-utils (thumbnails de PDF).

## Configuração (.env)

```env
# Servidor
SERVER_PORT=8080
CLIENT_NAME=evolution

# Segurança (OBRIGATÓRIO)
GLOBAL_API_KEY=sua-api-key-segura-aqui

# Banco de dados (PostgreSQL OBRIGATÓRIO — 2 databases)
POSTGRES_AUTH_DB=postgresql://postgres:password@localhost:5432/evogo_auth?sslmode=disable
POSTGRES_USERS_DB=postgresql://postgres:password@localhost:5432/evogo_users?sslmode=disable
DATABASE_SAVE_MESSAGES=false

# Logging
WADEBUG=INFO
LOGTYPE=console

# Conexão automática ao iniciar
CONNECT_ON_STARTUP=true

# Webhook global (opcional)
WEBHOOK_URL=https://sua-url/webhook
WEBHOOK_FILES=true

# Fila (opcional)
# AMQP_URL=amqp://admin:admin@localhost:5672/default
# AMQP_GLOBAL_ENABLED=false
# NATS_URL=nats://localhost:4222

# Storage de mídia (opcional)
# MINIO_ENABLED=true
# MINIO_ENDPOINT=localhost:9000
# MINIO_ACCESS_KEY=minioadmin
# MINIO_SECRET_KEY=minioadmin

# License (auto-ativação headless por email)
# EVOLUTION_OPERATOR_EMAIL=operator@example.com

# Passkey (WebAuthn) pairing
# PASSKEY_PUBLIC_URL=https://your-api.example.com

OS_NAME=Evolution GO
```

## Autenticação

Todas as rotas (exceto `/server/ok`, `/manager`, `/swagger`) exigem o header:
```
apikey: <GLOBAL_API_KEY>
```

## Endpoints da API (confirmados pelo código fonte — `pkg/routes/routes.go`)

### Instance (gerenciamento de instâncias)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/instance/create` | Criar instância |
| GET | `/instance/all` | Listar instâncias |
| GET | `/instance/info/:instanceId` | Info da instância |
| DELETE | `/instance/delete/:instanceId` | Deletar instância |
| POST | `/instance/proxy/:instanceId` | Configurar proxy |
| POST | `/instance/forcereconnect/:instanceId` | Forçar reconexão |
| GET | `/instance/logs/:instanceId` | Logs da instância |

### Connect (conexão do WhatsApp)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/connect` | Conectar (gera QR) |
| GET | `/status` | Status da conexão |
| GET | `/qr` | Obter QR Code |
| POST | `/pair` | Código de pareamento |
| POST | `/disconnect` | Desconectar |
| POST | `/reconnect` | Reconectar |
| DELETE | `/logout` | Logout |
| GET | `/:instanceId/advanced-settings` | Config avançada |
| PUT | `/:instanceId/advanced-settings` | Atualizar config |

### Send (envio de mensagens)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/send/text` | Enviar texto |
| POST | `/send/link` | Enviar link preview |
| POST | `/send/media` | Enviar mídia (img/vídeo/doc/áudio) |
| POST | `/send/poll` | Enviar enquete |
| POST | `/send/sticker` | Enviar figurinha |
| POST | `/send/location` | Enviar localização |
| POST | `/send/contact` | Enviar contato |
| POST | `/send/button` | Enviar botões |
| POST | `/send/list` | Enviar lista |
| POST | `/send/carousel` | Enviar carousel |

### Message (gerenciamento de mensagens)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/message/info` | Info de mensagem |
| POST | `/message/check` | Verificar número |
| POST | `/message/avatar` | Obter avatar |
| GET | `/message/contacts` | Listar contatos |
| POST | `/message/react` | Reagir a mensagem |
| POST | `/message/presence` | Presença (digitando...) |
| POST | `/message/markread` | Marcar como lida |
| POST | `/message/markplayed` | Marcar como reproduzido |
| POST | `/message/downloadmedia` | Download de mídia |
| POST | `/message/status` | Status (stories) |
| POST | `/message/delete` | Deletar mensagem |
| POST | `/message/edit` | Editar mensagem |
| POST | `/message/pin` | Fixar mensagem |
| POST | `/message/archive` | Arquivar conversa |
| POST | `/message/mute` | Silenciar conversa |

### Chat
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/chat/contacts` | Contatos do chat |
| POST | `/chat/whatsapp` | Verificar WhatsApp |
| POST | `/chat/markread` | Marcar chat como lido |
| POST | `/chat/archive` | Arquivar chat |
| POST | `/chat/delete` | Deletar chat |
| POST | `/chat/sendseen` | Enviar "visto" |

### Group
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/group/create` | Criar grupo |
| POST | `/group/info` | Info do grupo |
| POST | `/group/participants` | Listar participantes |

### Label
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/label/create` | Criar etiqueta |
| GET | `/label/all` | Listar etiquetas |
| DELETE | `/label/:id` | Deletar etiqueta |

### Newsletter
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/newsletter/all` | Listar canais |
| POST | `/newsletter/info` | Info do canal |

### Outros
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/server/ok` | Health check |
| GET | `/manager` | Painel React embutido |
| GET | `/swagger/*` | Documentação Swagger |

## Webhooks

O Evolution GO envia webhooks para eventos do WhatsApp. Configurar via `WEBHOOK_URL` no `.env` ou por instância.

**Eventos suportados (confirmados pelo código):**
- `messages.upsert` — mensagem recebida
- `messages.update` — status de mensagem atualizado
- `connection.update` — status de conexão mudou
- `presence.update` — presença/digitando
- `qrcode.updated` — QR code gerado/atualizado
- `contacts.upsert` — contato sincronizado

**Formato:** POST JSON para a URL configurada. Autenticação via header customizado (configurável).

## Diferenças críticas para migração (Evolution API → Evolution GO)

1. **Endpoints diferentes**: o GO usa rotas mais RESTful (ex: `/send/text` em vez de `/message/sendText`)
2. **Autenticação**: header `apikey` igual, mas o GO tem license management built-in
3. **Banco**: GO requer 2 databases PostgreSQL (`evogo_auth` + `evogo_users`) — não suporta SQLite/MySQL
4. **Manager UI**: GO tem painel React embutido em `/manager` (não precisa de container separado)
5. **Payload shape**: similar mas não idêntico — precisa validar campo a campo na migração
6. **License**: GO exige ativação de licença (email) — a API não funciona sem registrar

## Licença

Apache 2.0 com condições adicionais de marca (manter logo/copyright). Para uso comercial, notificar a Evolution Foundation.
