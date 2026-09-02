# Live Test Matrix

| Integração | Flag obrigatória | Credencial/target | Estado |
|---|---|---|---|
| OpenRouter | `RUN_LIVE_AI_TESTS=1` | `OPENROUTER_API_KEY` | BLOCKED |
| Evolution | `RUN_LIVE_EVOLUTION_TESTS=1` | Instância/número exclusivos de teste | BLOCKED |
| Demais testes live | `RUN_LIVE_TESTS=1` | `STAGING_BASE_URL` e tenant de teste | BLOCKED |
| Supabase implantado | Autorização explícita de introspecção | Projeto/staging | BLOCKED |
| Google Calendar | Autorização e OAuth staging | Calendário de teste | BLOCKED |

Motivo: flags e credenciais não foram confirmadas. Testes offline continuam executáveis.
