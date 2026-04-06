Integração WhatsApp (n8n) — Gestão Contas /insights
===================================================

1) No servidor, defina no .env a mesma chave:
   N8N_WEBHOOK_SECRET=um-segredo-longo-aleatorio

2) No n8n, use um nó "Webhook" (POST) ou "HTTP Request" apontando para:
   https://SEU-DOMINIO/insights/api/webhook/n8n
   ou (se o proxy só expuser /api para o Node):
   https://SEU-DOMINIO/api/webhook/n8n

3) Envie o header:
   x-webhook-secret: <o mesmo valor de N8N_WEBHOOK_SECRET>

   (Alternativa: corpo JSON com campo "secret" com o mesmo valor.)

4) Corpo JSON exemplo para registrar gasto:
   {
     "kind": "expense",
     "amount": 89.9,
     "category": "Mercado",
     "description": "Compras semana",
     "occurred_on": "2026-04-02"
   }

   Exemplo receita:
   {
     "kind": "income",
     "amount": 5000,
     "category": "Salário",
     "description": "Tokio",
     "occurred_on": "2026-04-02"
   }

5) Fluxo sugerido: WhatsApp Trigger (ou Evolution API) → Function para extrair valor/texto →
   HTTP Request POST para a URL acima com header e JSON.

6) Resposta 201: { "ok": true, "transaction": { ... } }
   401: segredo incorreto.

Frontend em outro host: no HTML, antes de api.js, defina:
   <script>window.__INSIGHTS_API_BASE__ = "https://seu-dominio/insights";</script>
