/**
 * GET /api/deepseek-chat/userscript.user.js?sub=<code>
 *
 * Serve o userscript Tampermonkey/Violentmonkey que captura o userToken do
 * chat.deepseek.com automaticamente. O nome do arquivo TERMINA em ".user.js"
 * — é por isso que o Tampermonkey detecta a navegação e abre o prompt de
 * instalação sozinho. Sem isso, o usuário teria que importar manual.
 *
 * Public — não precisa de admin. O `sub` (subscription code) já autentica:
 * quem tem o code pode mandar token; quem não tem, é só um .js inerte.
 *
 * Validação: garantimos que o sub existe ANTES de retornar o script. Se
 * alguém pediu com sub inválido, devolvemos 404 com Content-Type texto pra
 * Tampermonkey não tentar instalar lixo.
 */

import { NextRequest, NextResponse } from "next/server";
import { listSubscriptions } from "@/lib/deepseek-chat-manager";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  // Tampermonkey/Violentmonkey detectam pelo padrão da URL + Content-Type.
};

export async function GET(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get("sub") || "";
  if (!sub) {
    return new Response("// Subscription code ausente (?sub=). Gere um em Configurações → DeepSeek.\n", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const exists = listSubscriptions().some((s) => s.code === sub);
  if (!exists) {
    return new Response("// Subscription code inválido ou revogado. Gere um novo em Configurações → DeepSeek.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Painel base — derivado da própria request, pra funcionar tanto em dev
  // (localhost) quanto em produção (easypanel.host) sem hardcode.
  const origin = req.nextUrl.origin;
  const u = new URL(origin);
  // host pro @connect (CORS do GM_xmlhttpRequest). Sem protocolo.
  const host = u.host;
  // Lista de @connect robusta: cobre localhost, 127.0.0.1 e o host real.
  // Necessário porque o Tampermonkey exige o host exato no @connect pra
  // permitir GM_xmlhttpRequest cross-origin — sem isso, o Opera GX/Chrome
  // bloqueiam a request do userscript (do chat.deepseek.com) pro painel.
  const connectLines = [
    host,
    u.hostname, // host sem porta (localhost, ou domínio de produção)
    "localhost",
    "127.0.0.1",
    "*", // segurança adicional: aceita qualquer host (o code autentica mesmo assim)
  ]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .map((h) => `// @connect      ${h}`)
    .join("\n");

  // JSON.stringify pra interpolação segura — code base64url não tem aspas, mas
  // é defensivo.
  const PAINEL = JSON.stringify(origin);
  const SUB = JSON.stringify(sub);

  const script = `// ==UserScript==
// @name         Painel SDR — captura automática DeepSeek
// @namespace    ${origin}
// @version      1.2.0
// @description  Sincroniza o userToken do chat.deepseek.com com o painel SDR. Roda automático em cada visita.
// @author       Painel SDR
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
${connectLines}
// @noframes
// ==/UserScript==

/* eslint-disable */
(function() {
  'use strict';
  console.log('[SDR] Userscript carregado e iniciado em chat.deepseek.com');
  const PAINEL = ${PAINEL};
  const SUB = ${SUB};
  let lastSent = null;
  let lastStatus = null;

  // Cria o overlay visual de status
  let overlay = null;
  function getOverlay() {
    if (typeof document === 'undefined' || !document.body) return null;
    let badge = document.getElementById('sdr-sync-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'sdr-sync-badge';
      badge.style.position = 'fixed';
      badge.style.bottom = '20px';
      badge.style.right = '20px';
      badge.style.zIndex = '9999999';
      badge.style.padding = '10px 16px';
      badge.style.borderRadius = '10px';
      badge.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      badge.style.fontSize = '12px';
      badge.style.fontWeight = '600';
      badge.style.boxShadow = '0 10px 15px -3px rgba(0,0,0,0.3), 0 4px 6px -2px rgba(0,0,0,0.3)';
      badge.style.transition = 'all 0.3s ease';
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.gap = '8px';
      badge.style.backdropFilter = 'blur(8px)';
      document.body.appendChild(badge);
    }
    return badge;
  }

  function updateStatus(type, text) {
    const badge = getOverlay();
    if (!badge) return;
    if (lastStatus === type + ':' + text) return;
    lastStatus = type + ':' + text;
    
    badge.style.opacity = '1';
    badge.style.transform = 'translateY(0)';
    if (type === 'success') {
      badge.style.background = 'rgba(16, 185, 129, 0.9)';
      badge.style.color = '#ffffff';
      badge.style.border = '1px solid rgba(52, 211, 153, 0.4)';
      badge.innerHTML = '🟢 SDR: ' + text;
      setTimeout(() => {
        badge.style.opacity = '0';
        badge.style.transform = 'translateY(10px)';
      }, 5000);
    } else if (type === 'warning') {
      badge.style.background = 'rgba(245, 158, 11, 0.9)';
      badge.style.color = '#ffffff';
      badge.style.border = '1px solid rgba(251, 191, 36, 0.4)';
      badge.innerHTML = '🟡 SDR: ' + text;
    } else if (type === 'error') {
      badge.style.background = 'rgba(239, 68, 68, 0.9)';
      badge.style.color = '#ffffff';
      badge.style.border = '1px solid rgba(248, 113, 113, 0.4)';
      badge.innerHTML = '🔴 SDR: ' + text;
    }
  }

  function clean(t) {
    if (!t || typeof t !== 'string') return null;
    var c = t.trim().replace(/^"|"$/g, '');
    if (c.length > 20) return c;
    return null;
  }

  function findToken() {
    var keys = ['userToken','user_token','__token__','deepseek_token','accessToken'];
    for (var i = 0; i < keys.length; i++) {
      var raw = localStorage.getItem(keys[i]);
      if (!raw) continue;
      if (raw.trim().startsWith('{')) {
        try {
          var j = JSON.parse(raw);
          var c = j.userToken || j.token || j.access_token || j.accessToken || j.value || j.user_token;
          var t = clean(c);
          if (t) return t;
        } catch (_) {}
      }
      var t = clean(raw);
      if (t) return t;
    }
    // Fallback: scaneia todos os keys
    for (var k in localStorage) {
      try {
        var raw = localStorage.getItem(k);
        if (!raw) continue;
        if (raw.trim().startsWith('{')) {
          var j = JSON.parse(raw);
          var c = j.userToken || j.token || j.access_token || j.accessToken || j.value || j.user_token;
          var t = clean(c);
          if (t) return t;
        }
        var t = clean(raw);
        if (t) return t;
      } catch (_) {}
    }
    return null;
  }

  function send(token) {
    if (token === lastSent) return;
    lastSent = token;
    updateStatus('warning', 'Sincronizando com o painel...');
    
    const fn = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
             : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM)
             : null;
    if (!fn) {
      fetch(PAINEL + '/api/deepseek-chat/import-bookmarklet', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ subscription: SUB, token: token }),
      }).then(r => r.json()).then(d => {
        if (d.success) {
          console.log('[Painel SDR] token sincronizado');
          updateStatus('success', 'Conectado ao painel SDR!');
        } else {
          console.warn('[Painel SDR] erro:', d.error);
          updateStatus('error', 'Painel recusou o token: ' + d.error);
        }
      }).catch(e => {
        console.warn('[Painel SDR] erro:', e.message);
        updateStatus('error', 'Bloqueio de rede ou painel local fechado.');
      });
      return;
    }
    fn({
      method: 'POST',
      url: PAINEL + '/api/deepseek-chat/import-bookmarklet',
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ subscription: SUB, token: token }),
      onload: function(r) {
        try {
          const d = JSON.parse(r.responseText);
          if (d.success) {
            console.log('[Painel SDR] token sincronizado');
            updateStatus('success', 'Conectado ao painel SDR!');
          } else {
            console.warn('[Painel SDR] erro:', d.error);
            updateStatus('error', 'Painel recusou o token: ' + d.error);
          }
        } catch (e) {
          console.warn('[Painel SDR] resposta inválida (HTTP ' + (r && r.status) + ')');
          updateStatus('error', 'Resposta inválida do painel (HTTP ' + (r && r.status) + ').');
        }
      },
      onerror: function(e) {
        // Erro de rede = o GM_xmlhttpRequest não chegou no painel. Causas
        // comuns: painel local fechado, @connect errado, ou Mixed Content.
        console.warn('[Painel SDR] erro de rede', e);
        updateStatus('error', 'Falha de rede: o painel local está aberto? (' + PAINEL + ')');
      },
      ontimeout: function() {
        updateStatus('error', 'Tempo esgotado conectando no painel local.');
      }
    });
  }

  function tick() {
    const t = findToken();
    if (t) {
      send(t);
    } else {
      updateStatus('warning', 'Faça login no DeepSeek para conectar.');
    }
  }

  // Atraso de 500ms no load inicial para o DOM do body estar disponível
  setTimeout(() => {
    tick();
    setInterval(tick, 30000); // sync a cada 30 segundos
  }, 500);

  window.addEventListener('storage', function() { setTimeout(tick, 500); });
})();
`;

  return new Response(script, { headers: HEADERS });
}
