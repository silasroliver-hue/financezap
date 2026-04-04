# Como importar os workflows no n8n

## 1. Importar os arquivos

No n8n, vá em **Workflows → Import from File** e importe:

- `workflow1-whatsapp-registrar-transacao.json`
- `workflow2-enviar-link-ativacao.json`

---

## 2. Configurar as Variáveis (Settings → Variables)

Crie estas variáveis em **Settings → Variables** no n8n:

| Variável | Valor | Exemplo |
|---|---|---|
| `FINANCEZAP_API_URL` | URL do servidor Node.js | `https://app.financezap.com.br` |
| `WEBHOOK_SECRET` | Mesmo valor do `.env` (`N8N_WEBHOOK_SECRET`) | `meu-segredo-longo` |
| `EVOLUTION_API_URL` | URL da sua Evolution API | `http://localhost:8080` |
| `EVOLUTION_INSTANCE` | Nome da instância no Evolution | `financezap` |
| `EVOLUTION_API_KEY` | API Key da Evolution API | `sua-api-key` |

---

## 3. Atualizar o .env do servidor

Abra `.env` e preencha:

```env
N8N_WEBHOOK_SECRET=meu-segredo-longo
N8N_SEND_WHATSAPP_URL=https://SEU_N8N/webhook/financezap-send-whatsapp
APP_URL=https://app.financezap.com.br
```

---

## 4. Configurar a Evolution API para enviar ao Workflow 1

Na sua Evolution API, configure o webhook da instância para apontar para:

```
POST https://SEU_N8N/webhook/financezap-whatsapp
```

Eventos a ativar: **messages.upsert**

---

## Fluxo Workflow 1 — Registrar transação via WhatsApp

```
Usuário manda mensagem no WhatsApp
  → Evolution API dispara webhook para o n8n
  → n8n parseia a mensagem (tipo, valor, categoria)
  → n8n chama POST /api/webhook/whatsapp no servidor
  → n8n envia confirmação via WhatsApp para o usuário
```

**Exemplos de mensagens aceitas:**
- `saída 50 restaurante`
- `gasto 25.50 transporte`
- `entrada 3000 salário`
- `recebi 1500 freela`
- `paguei 120 conta de luz`

---

## Fluxo Workflow 2 — Enviar link de ativação

```
Admin confirma pagamento no /admin
  → Servidor chama N8N_SEND_WHATSAPP_URL
  → n8n valida o secret
  → n8n envia a mensagem com o link de ativação via Evolution API
  → Usuário recebe no WhatsApp e clica no link
```
