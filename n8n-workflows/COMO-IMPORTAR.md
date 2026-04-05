# Como importar os workflows n8n — FinanceZap

## Pré-requisitos
- n8n instalado e rodando
- Evolution API configurada com a instância `financezap`
- Variável `GEMINI_API_KEY` configurada no servidor (para o agente de vendas)

---

## Workflow 1 — WhatsApp Completo

**Arquivo:** `FinanceZap — WhatsApp Completo (IA + Venda + Transações) - 1.json`

**O que faz:**
1. Recebe webhook da Evolution API com mensagens do WhatsApp
2. Ignora mensagens do bot, grupos e eventos que não são mensagens
3. Chama o backend (`/api/webhook/whatsapp-chat`) que gerencia toda a lógica:
   - **Usuário cadastrado com acesso:** menu guiado com 6 opções (extrato, receita, despesa, investimento, saldo, dúvidas)
   - **Usuário não cadastrado:** agente de IA de vendas com link para checkout
4. Envia a resposta via Evolution API

**Fluxo do menu (para usuários cadastrados):**
```
Oi / menu → Mostra menu com 6 opções
  1 → Extrato → pergunta quantos dias → retorna extrato formatado
  2 → Receita → lista categorias → pede valor → registra
  3 → Despesa → lista categorias → pede valor → registra
  4 → Investimento → pede banco → pede saldo → atualiza
  5 → Saldo → lista todas as contas e patrimônio total
  6 → Dúvida → responde com IA
```

**Após importar, altere:**
| Campo | Onde | Valor |
|-------|------|-------|
| `x-webhook-secret` | Nodes "Backend Chat" e "Agente IA Vendas" | Mesmo valor de `N8N_WEBHOOK_SECRET` no `.env` |
| URL do backend | Node "Backend Chat" | `https://seu-dominio.com.br` |
| URL Evolution API | Node "Enviar WhatsApp" | `https://evo.seu-dominio.com.br` |
| `apikey` | Node "Enviar WhatsApp" | Sua chave da Evolution API |
| Nome da instância | Node "Enviar WhatsApp" | Nome da sua instância (ex: `financezap`) |

---

## Workflow 2 — Enviar Link de Ativação

**Arquivo:** `FinanceZap — Enviar Link de Ativação via WhatsApp - 2.json`

**O que faz:**
- Recebe uma requisição do servidor quando o admin confirma um pagamento
- Valida o secret de segurança (corrigido para n8n webhook v2)
- Envia a mensagem de ativação via Evolution API para o telefone do cliente

**Após importar, altere:**
| Campo | Onde | Valor |
|-------|------|-------|
| `EXPECTED_SECRET` | Node "Validar Secret" (linha 6) | Mesmo valor de `N8N_WEBHOOK_SECRET` no `.env` |
| URL Evolution API | Node "Enviar WhatsApp" | `https://evo.seu-dominio.com.br` |
| `apikey` | Node "Enviar WhatsApp" | Sua chave da Evolution API |
| Nome da instância | Node "Enviar WhatsApp" | Nome da sua instância |

---

## Variáveis de ambiente necessárias no servidor (.env)

```env
N8N_WEBHOOK_SECRET=defina-um-segredo-longo-aqui
N8N_SEND_WHATSAPP_URL=https://seu-n8n.com/webhook/financezap-send-whatsapp
GEMINI_API_KEY=sua-chave-gemini
RESEND_API_KEY=sua-chave-resend         # para envio de email
EMAIL_FROM=FinanceZap <noreply@financezap.app>
APP_URL=https://financezap.thesilasstudio.com.br
ADMIN_SECRET=sua-senha-admin
```

---

## Passos para importar

1. Acesse seu n8n → **Workflows** → **Import from file**
2. Importe o arquivo JSON do Workflow 1
3. Substitua os valores conforme tabela acima
4. Ative o workflow (toggle no canto superior direito)
5. Repita para o Workflow 2
6. No painel da Evolution API, configure o webhook apontando para a URL do Workflow 1:
   - `https://seu-n8n.com/webhook/financezap-whatsapp`
   - Evento: `MESSAGES_UPSERT`
