# MMZap Browser Worker (EasyPanel)

Microserviço isolado em Chromium (Playwright) com proxy autenticado local por chip e persistência em disco (`/data`) para executar a extensão oficial do MMZap em turnos curtos e governados pelo painel `/aquecer-chips`.

## 1. Criar serviço no EasyPanel
1. No mesmo projeto do Painel SDR no EasyPanel, crie um novo **App / Service** apontando para este repositório Git.
2. Em **Build / Dockerfile Path**, defina:
   `services/mmzap-browser-worker/Dockerfile`
   E **Build Context**:
   `services/mmzap-browser-worker`
3. Em **Storage / Volumes**, monte um volume persistente em:
   `/data` (guarda perfis de WhatsApp Web `/data/profiles` e a extensão `/data/extensions/mmzap`).
4. Em **Resources**, configure no máximo `2048 MB` de RAM (`2 GB` dentro da folga de `4 GB` da VPS) e `1 vCPU`.
5. **NÃO exponha domínio público** — deixe apenas acessível na rede interna Docker do EasyPanel (ex: `http://painel-sdr_mmzap-browser-worker:3099` ou `http://<nome-do-servico>:3099`).

## 2. Variáveis de Ambiente
No serviço **`mmzap-browser-worker`**:
- `PORT=3099`
- `DATA_DIR=/data`
- `MAX_CONCURRENT_BROWSERS=2` (máximo recomendado para 4 GB livre; teto hard `3`)
- `MAX_RSS_MB=550`
- `MMZAP_WORKER_SECRET=<mesmo-segredo-forte>`

No serviço principal do **Painel SDR (`Next.js`)**:
- `MMZAP_WORKER_URL=http://<nome-do-servico-no-easypanel>:3099`
- `MMZAP_WORKER_SECRET=<mesmo-segredo-forte>`

## 3. Instalação da Extensão MMZap (única vez)
Você pode subir o `.zip` descompactado da extensão direto pela interface de `/aquecer-chips` (ou copiar os arquivos da extensão para `/data/extensions/mmzap` contendo o `manifest.json`). Depois de subir uma vez no volume `/data`, todos os perfis dos chips enxergam a extensão automaticamente.
