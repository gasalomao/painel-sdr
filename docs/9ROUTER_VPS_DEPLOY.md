# 9Router + OpenCode na VPS — guia de deploy (EasyPanel)

Objetivo: o **Painel SDR** roda no EasyPanel e gera sites com o OpenCode CLI
(`/impeccable craft`) usando um **9Router próprio dentro da VPS** — com os mesmos
provedores, combos e chaves do 9Router que você já usa na máquina local.

```
┌──────────────────────────── EasyPanel (mesma rede interna) ────────────────────────────┐
│                                                                                        │
│   [ sdr ]  ──HTTP──▶  http://9router:20128/v1  ──▶  [ 9router ]  ──▶  provedores (IA)   │
│   Node/Next 3000                                    node:20128                          │
│   └─ opencode CLI                                        └─ volume 9router-data → /app/data │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

O OpenCode **não** conversa com o 9Router da sua máquina: ele usa o da VPS. A
"clonagem" acontece pelos arquivos de dados exportados (provedores, combos, chaves
e segredos), não por túnel.

---

## 1. O que é exportado

O 9Router guarda tudo em um diretório de dados (Windows: `%APPDATA%\9router`;
Linux/Docker: `~/.9router` ou `$DATA_DIR`):

| Arquivo | Conteúdo | Obrigatório |
|---|---|---|
| `db/data.sqlite` | provedores conectados, combos, API keys, settings | sim |
| `jwt-secret` | assinatura das sessões do dashboard | sim |
| `machine-id` | salt usado para criptografar credenciais OAuth salvas | sim |
| `auth/cli-secret` | segredo interno usado pelo CLI | recomendado |

Telemetria (`usageHistory`, `usageDaily`, `requestDetails`) é descartada no
export — só ocupa espaço e não afeta a configuração.

> `machine-id` também pode ser substituído pela variável `MACHINE_ID_SALT`
> (mesmo valor). Copiar o arquivo é mais simples e já resolve.

---

## 2. Gerar o pacote (na sua máquina)

```powershell
npm run 9router:export
```

Saída padrão: `%USERPROFILE%\Desktop\9router-vps-export\` (e o `.zip` ao lado).

```
9router-vps-export/
├─ data/
│  ├─ db/data.sqlite
│  ├─ jwt-secret
│  ├─ machine-id
│  └─ auth/cli-secret
├─ 9router.env          # variáveis do serviço no EasyPanel
├─ opencode/opencode.json
└─ LEIA-ME.txt          # resumo + SHA-256 do banco
```

Opções úteis:

```powershell
node scripts/export-9router-for-vps.mjs --out "D:\backup\9router" --skip-zip
```

O script valida o banco com `VACUUM INTO` (cópia consistente mesmo com o
9Router aberto) e imprime quantos provedores, combos e chaves foram exportados.
Confira esses números contra o dashboard local antes de seguir.

> ⚠️ O pacote contém segredos. Não suba em repositório público nem em pasta
> compartilhada.

---

## 3. Criar o serviço 9Router no EasyPanel

**+ Service → App**

| Campo | Valor |
|---|---|
| Nome | `9router` |
| Source | Docker Image |
| Image | `decolua/9router:latest` |
| Port | `20128` |

**Environment** (cole o conteúdo de `9router.env`):

```env
DATA_DIR=/app/data
PORT=20128
HOSTNAME=0.0.0.0
NODE_ENV=production
```

**Mounts** — volume persistente:

```
Nome: 9router-data
Mount Path: /app/data
```

Faça o deploy uma vez (o 9Router cria o banco vazio), depois pare o serviço para
importar os dados.

---

## 4. Importar o pacote para dentro do volume

O volume é um volume Docker nomeado — copiar via `docker cp` no host é o caminho
mais direto. Acesse a VPS por SSH e:

```bash
# 1. Descubra o nome real do container (o EasyPanel sufixa com hash)
docker ps --format '{{.Names}}' | grep -i 9router

# 2. Pare só o 9Router
docker stop <nome-do-container-9router>

# 3. Envie o pacote para a VPS (da sua máquina) e descompacte
scp 9router-vps-export.zip root@SEU_IP:/root/
ssh root@SEU_IP
mkdir -p /root/9router-import && cd /root/9router-import
unzip -o /root/9router-vps-export.zip

# 4. Copie os arquivos para dentro do container parado
docker cp 9router-vps/data/. <nome-do-container-9router>:/app/data/

# 5. Suba de novo
docker start <nome-do-container-9router>
```

Depois do start, o log deve mostrar o servidor em `0.0.0.0:20128`:

```bash
docker logs --tail 50 <nome-do-container-9router>
```

> Se o container do EasyPanel for recriado no deploy, o volume `9router-data`
> permanece — os dados não se perdem.

---

## 5. Validar o 9Router da VPS

No dashboard (`https://SEU-9ROUTER.easypanel.host`) confira:

- **Providers**: os mesmos 24 do host local, com status `active`.
- **Combos**: `combo-principal` e `teste`.
- **API Keys**: `sk-9router`, `Teste`, `VPS Key`.

Teste a API por dentro da VPS (sem expor a porta):

```bash
docker exec -it <nome-do-container-sdr> sh -lc \
  'curl -s http://9router:20128/v1/models -H "Authorization: Bearer sk-9router" | head -c 400'
```

Resposta esperada: JSON com `"object": "list"` e os modelos/combos.

---

## 6. Apontar o Painel SDR para o 9Router da VPS

No serviço **`sdr`** do EasyPanel, aba **Environment**, adicione:

```env
ROUTER_BASE_URL=http://9router:20128/v1
ROUTER_API_KEY=sk-36b9790c1ec0e83a-522w00-34d63001
OPENCODE_MODEL=9router/combo-principal
```

- `ROUTER_BASE_URL` — hostname do serviço na rede interna do EasyPanel. Nunca
  use `127.0.0.1` aqui: dentro do container `sdr`, `127.0.0.1` é o próprio `sdr`.
- `ROUTER_API_KEY` — use a chave **VPS Key** (dedicada), não a `sk-9router`.
- `OPENCODE_MODEL` — provider/modelo usado pelo worker de sites.

O `src/lib/sites/opencode-runner.ts` injeta essas duas variáveis no processo do
OpenCode CLI antes de spawnar; o `opencode.json` do container referencia
`{env:ROUTER_BASE_URL}` e `{env:ROUTER_API_KEY}` (o Dockerfile faz essa troca no
build).

---

## 7. Build da imagem: faça localmente

O diretório `.opencode` (skills + config do OpenCode) tem **~104 MB / 4.700
arquivos** e está no `.gitignore` — ou seja, **não existe no GitHub**. Um build
direto do repositório falharia no `COPY .opencode` do Dockerfile.

Portanto o fluxo correto é buildar na sua máquina e publicar a imagem:

```powershell
docker build -t SEU_USUARIO/painel-sdr:latest .
docker push SEU_USUARIO/painel-sdr:latest
```

No EasyPanel, mude o serviço `sdr` para **Source: Docker Image** apontando para
`SEU_USUARIO/painel-sdr:latest` (ou um registry privado, se preferir).

> Alternativa: remover `.opencode/` do `.gitignore` e commitar os 104 MB — não
> recomendado (repositório pesado, skills versionadas junto com o app).

---

## 8. Validar o OpenCode dentro do container

```bash
# O CLI existe e enxerga o provider
docker exec -it <nome-do-container-sdr> sh -lc \
  'cd /app && opencode models | grep 9router'

# O config resolveu as variáveis de ambiente
docker exec -it <nome-do-container-sdr> sh -lc \
  'cd /app && opencode debug config | grep -A3 baseURL'
```

Esperado: `http://9router:20128/v1` e o modelo `9router/combo-principal`
listado. Depois, rode uma geração de teste pelo painel (Sites IA) e acompanhe:

```bash
docker logs -f <nome-do-container-sdr>
```

---

## 9. Segurança e manutenção

- **Rotacione a chave**: crie uma API key nova no dashboard do 9Router da VPS,
  atualize `ROUTER_API_KEY` no `sdr` e desative a antiga.
- **`machine-id` clonado**: mantém as credenciais OAuth descriptografáveis. Se
  você rotacionar esse arquivo, todos os tokens salvos param de funcionar e os
  provedores precisam ser reconectados.
- **Backup**: o volume `9router-data` guarda tudo. Um dump periódico de
  `data.sqlite` + `machine-id` + `jwt-secret` é suficiente para restaurar.
- **Não exponha** a porta 20128 publicamente sem proxy/auth; o ideal é deixar o
  `9router` só na rede interna e acessar o dashboard por um domínio protegido.

---

## 10. Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| `baseURL` vazio no `opencode debug config` | `{env:ROUTER_BASE_URL}` não definida no processo | confira o Environment do `sdr`; o runner injeta fallback `127.0.0.1`, que não funciona na VPS |
| `ECONNREFUSED 127.0.0.1:20128` | config antiga (literal) dentro do container | rebuild da imagem com o Dockerfile atualizado |
| `401 invalid api key` | chave desativada ou de outro 9Router | use uma key do dashboard da VPS |
| `getaddrinfo ENOTFOUND 9router` | serviços em projetos diferentes no EasyPanel | mova ambos para o mesmo projeto/rede |
| Dashboard vazio após import | arquivos copiados com o container rodando | pare o container, copie de novo, suba |
| Provider `codex`/`antigravity` com erro de auth | refresh token preso a outro IP/dispositivo | reconecte o provider pelo dashboard da VPS |
| Build falha em `COPY .opencode` | build feito a partir do GitHub | build local + push (seção 7) |

---

## 11. Checklist

- [ ] `npm run 9router:export` gerou o pacote com 24 provedores / 2 combos / 3 keys
- [ ] Serviço `9router` no ar em `20128`, volume em `/app/data`
- [ ] `data.sqlite`, `jwt-secret`, `machine-id`, `auth/cli-secret` copiados
- [ ] Dashboard da VPS mostra os provedores e combos
- [ ] `curl http://9router:20128/v1/models` responde 200 de dentro do `sdr`
- [ ] `ROUTER_BASE_URL` e `ROUTER_API_KEY` definidos no `sdr`
- [ ] Imagem construída localmente e publicada no registry
- [ ] `opencode models` lista `9router/combo-principal` no container
- [ ] Geração de site de teste concluída pelo painel
