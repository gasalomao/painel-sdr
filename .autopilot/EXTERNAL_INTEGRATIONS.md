# External Integrations

Status: `TODO` — integrações serão provadas por imports, chamadas e configuração.

| Integração candidata | Tipo | Live autorizado | Status |
|---|---|---|---|
| Supabase/PostgreSQL | Dados | Não para mutação de produção | TODO |
| Evolution API V2 | WhatsApp | Somente `RUN_LIVE_EVOLUTION_TESTS=1` | BLOCKED |
| Evolution GO | WhatsApp | Somente `RUN_LIVE_EVOLUTION_TESTS=1` | BLOCKED |
| WhatsApp Cloud API | WhatsApp | Sem autorização live | BLOCKED |
| OpenRouter | IA | Somente `RUN_LIVE_AI_TESTS=1` | BLOCKED |
| Gemini | IA | Sem autorização live | BLOCKED |
| Gateway OpenAI-compatible | IA | Sem autorização live | BLOCKED |
| Google Calendar | OAuth/agenda | Sem credencial de staging autorizada | BLOCKED |
| Google Maps/Puppeteer | Scraping | Apenas fixtures/mocks por padrão | TODO |
| Whisper/ffmpeg | Mídia local | Teste local permitido | TODO |

`BLOCKED` live não impede testes offline com fakes.
