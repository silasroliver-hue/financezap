require("dotenv").config();
const path = require("path");
const express = require("express");
const nodemailer = require("nodemailer");
const XLSX = require("xlsx");
const { getSupabase } = require("./lib/supabase");
const { dashboardRoute } = require("./lib/dashboard-route");
const { authRequired, authOnly } = require("./lib/auth-middleware");
const {
  accumulatedThroughYMD,
  distinctCategories,
  distinctCategoriesByKind,
  sumAccumulatedThroughDate,
} = require("./lib/transactions-aggregate");
const {
  buildCreditCardInstallmentRows,
  groupInstallmentRows,
  monthKeyFromDate,
  monthKeyFromParts,
  shiftMonthKey,
} = require("./lib/credit-card-installments");

const app = express();
app.set("strict routing", true);
const PORT = Number(process.env.PORT) || (process.env.NODE_ENV === "production" ? 80 : 3000);
const BASE = "/insights";

app.use(express.json({ limit: "256kb" }));

const CORS_ORIGIN = (process.env.FINANCEZAP_CORS_ORIGIN || "").trim();
if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
}

function requireWebhookSecret(req, res, next) {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: "N8N_WEBHOOK_SECRET não configurado" });
  }
  const got =
    req.get("x-webhook-secret") ||
    (req.body && typeof req.body.secret === "string" ? req.body.secret : null);
  if (got !== secret) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const api = express.Router();

function normalizeKindQuery(v) {
  if (v == null || v === "") return null;
  const s = Array.isArray(v) ? String(v[0]) : String(v);
  const k = s.trim().toLowerCase();
  if (k === "income" || k === "expense") return k;
  return null;
}

const CATEGORIES_LEGACY_FALLBACK = ["Outros"];

function parseYearMonth(query) {
  const y = parseInt(String(query.year || new Date().getFullYear()), 10);
  const m = parseInt(String(query.month || new Date().getMonth() + 1), 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  return { y, m };
}

function isYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}

function monthBounds(y, m) {
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  return { start, end, daysInMonth };
}

function shiftYearMonth(y, m, delta) {
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function monthKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthLabelPt(y, m) {
  const names = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  return `${names[m - 1] || String(m).padStart(2, "0")}/${y}`;
}

function previousDateYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function safeAmount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function normalizeDescriptionForKind(kind, category, description) {
  const raw = description != null ? String(description).trim() : "";
  if (raw) return raw.slice(0, 500);
  if (kind === "expense") {
    const cat = String(category || "").trim();
    return (cat || "Despesa").slice(0, 500);
  }
  return null;
}

function parseQuickTransactionFromText(inputText) {
  const text = String(inputText || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const ENTRADA_WORDS = ["entrada", "recebi", "salario", "salário", "renda", "ganho", "ganhei", "pix recebido", "recebido"];
  const SAIDA_WORDS = [
    "saida", "saída", "gasto", "gastei", "paguei", "pagamento", "despesa", "comprei", "transferi",
    "pix enviado", "enviei", "enviado", "pix saiu", "mandei"
  ];

  let kind = null;
  for (const w of ENTRADA_WORDS) {
    if (lower.includes(w)) {
      kind = "income";
      break;
    }
  }
  if (!kind) {
    for (const w of SAIDA_WORDS) {
      if (lower.includes(w)) {
        kind = "expense";
        break;
      }
    }
  }
  if (!kind) return null;

  const amountMatch = text.match(/(\d+[.,]?\d*)/);
  const amount = amountMatch ? parseFloat(String(amountMatch[1]).replace(",", ".")) : null;
  if (!amount || !Number.isFinite(amount) || amount <= 0) return null;

  const after = amountMatch ? text.slice(text.indexOf(amountMatch[1]) + amountMatch[1].length).trim() : "";
  const categoryGuess = after
    .replace(/^(reais?|rs|r\$|de|do|da|no|na|em|para|pra|pro|por|pix)\s+/i, "")
    .replace(/^(o|a|os|as|um|uma)\s+/i, "")
    .trim();
  const category =
    categoryGuess.length > 1
      ? categoryGuess.charAt(0).toUpperCase() + categoryGuess.slice(1)
      : (kind === "income" ? "Receita" : "Despesa");

  return { kind, amount, category };
}

function nextDayYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function resolveReportPeriod(query) {
  const from = typeof query.from === "string" ? query.from.trim() : "";
  const to = typeof query.to === "string" ? query.to.trim() : "";
  if (isYmd(from) && isYmd(to) && from <= to) {
    const ref = new Date(`${to}T12:00:00Z`);
    return { from, to, refYear: ref.getUTCFullYear(), refMonth: ref.getUTCMonth() + 1 };
  }
  const ym = parseYearMonth(query);
  if (!ym) return null;
  const mb = monthBounds(ym.y, ym.m);
  return {
    from: mb.start,
    to: `${monthKey(ym.y, ym.m)}-${String(mb.daysInMonth).padStart(2, "0")}`,
    refYear: ym.y,
    refMonth: ym.m,
  };
}

async function buildMonthlyReport(sb, userId, period) {
  const from = period.from;
  const to = period.to;
  const refYear = period.refYear;
  const refMonth = period.refMonth;
  const monthKeyRef = monthKey(refYear, refMonth);
  const rangeEndExclusive = nextDayYmd(to);
  const rangeStartPrevDay = previousDateYmd(from);

  const [
    txMonthRes,
    totalsBefore,
    totalsEnd,
    billsTplRes,
    billsPayRes,
    cardsRes,
    tx12Res,
  ] = await Promise.all([
    sb
      .from("transactions")
      .select("id,kind,amount,category,description,occurred_on,payment_method,source,created_at")
      .eq("user_id", userId)
      .gte("occurred_on", from)
      .lt("occurred_on", rangeEndExclusive)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false }),
    sumAccumulatedThroughDate(sb, rangeStartPrevDay, userId),
    sumAccumulatedThroughDate(sb, to, userId),
    sb
      .from("recurring_bills")
      .select("id,name,default_amount,due_day,notify_one_day_before")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    sb
      .from("bill_payments")
      .select("bill_id,paid,amount_paid,paid_at,year,month")
      .eq("user_id", userId),
    sb
      .from("credit_cards")
      .select("id,name,color,due_day")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    (async () => {
      const start12 = shiftYearMonth(refYear, refMonth, -11);
      const endNext = shiftYearMonth(refYear, refMonth, 1);
      return sb
        .from("transactions")
        .select("kind,amount,occurred_on")
        .eq("user_id", userId)
        .gte("occurred_on", `${monthKey(start12.y, start12.m)}-01`)
        .lt("occurred_on", `${monthKey(endNext.y, endNext.m)}-01`);
    })(),
  ]);

  if (txMonthRes.error) throw txMonthRes.error;
  if (billsTplRes.error) throw billsTplRes.error;
  if (billsPayRes.error) throw billsPayRes.error;
  if (cardsRes.error) throw cardsRes.error;
  if (tx12Res.error) throw tx12Res.error;

  const txMonth = txMonthRes.data || [];
  const billsTemplates = billsTplRes.data || [];
  const billsPaymentsAll = billsPayRes.data || [];
  const cards = cardsRes.data || [];
  const tx12 = tx12Res.data || [];
  const fromMonthKey = String(from).slice(0, 7);
  const toMonthKey = String(to).slice(0, 7);
  const billsPayments = billsPaymentsAll.filter((row) => {
    const key = `${row.year}-${String(row.month).padStart(2, "0")}`;
    return key >= fromMonthKey && key <= toMonthKey;
  });

  let income = 0;
  let expense = 0;
  const byCategory = new Map();
  for (const row of txMonth) {
    const amount = safeAmount(row.amount);
    if (row.kind === "income") income += amount;
    else expense += amount;
    if (row.kind === "expense") {
      const cat = String(row.category || "Geral");
      byCategory.set(cat, (byCategory.get(cat) || 0) + amount);
    }
  }

  const expenseByCategory = [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const payMap = new Map();
  for (const p of billsPayments) {
    const key = String(p.bill_id || "");
    if (!payMap.has(key)) payMap.set(key, p);
  }
  const bills = billsTemplates.map((bill) => {
    const pay = payMap.get(String(bill.id));
    return {
      bill_id: bill.id,
      name: bill.name,
      due_day: bill.due_day,
      notify_one_day_before: !!bill.notify_one_day_before,
      amount_reference: safeAmount(bill.default_amount),
      paid: !!pay?.paid,
      amount_paid: pay ? safeAmount(pay.amount_paid) : 0,
      paid_at: pay?.paid_at || null,
    };
  });

  const nextKey = shiftYearMonth(refYear, refMonth, 1);
  const monthProjection = [];
  const txCardsByMonth = new Map();
  if (cards.length) {
    const loaded = await loadUserCreditCardsWithRows(sb, userId, monthKeyRef, 12);
    const overview = buildCreditCardOverview(loaded.cards, loaded.rows, monthKeyRef, 12);
    for (const monthRow of overview.months || []) {
      monthProjection.push({
        month_key: monthRow.monthKey,
        month_label: monthLabelPt(
          parseInt(String(monthRow.monthKey).slice(0, 4), 10),
          parseInt(String(monthRow.monthKey).slice(5, 7), 10)
        ),
        total: safeAmount(monthRow.total),
      });
      for (const c of monthRow.cards || []) {
        const key = `${monthRow.monthKey}:${c.card_id}`;
        txCardsByMonth.set(key, safeAmount(c.total));
      }
    }
  }

  const creditCards = cards.map((c) => {
    const cur = txCardsByMonth.get(`${monthKeyRef}:${c.id}`) || 0;
    const nxt = txCardsByMonth.get(`${monthKey(nextKey.y, nextKey.m)}:${c.id}`) || 0;
    return {
      card_id: c.id,
      card_name: c.name,
      due_day: c.due_day,
      current_month_total: cur,
      next_month_total: nxt,
    };
  });

  const comparative = [];
  const monthAgg = new Map();
  for (const row of tx12) {
    const key = String(row.occurred_on || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!monthAgg.has(key)) monthAgg.set(key, { income: 0, expense: 0 });
    const bucket = monthAgg.get(key);
    const amount = safeAmount(row.amount);
    if (row.kind === "income") bucket.income += amount;
    else bucket.expense += amount;
  }
  for (let i = 11; i >= 0; i--) {
    const ref = shiftYearMonth(refYear, refMonth, -i);
    const key = monthKey(ref.y, ref.m);
    const bucket = monthAgg.get(key) || { income: 0, expense: 0 };
    comparative.push({
      month_key: key,
      month_label: monthLabelPt(ref.y, ref.m),
      income: bucket.income,
      expense: bucket.expense,
      balance: bucket.income - bucket.expense,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    period: {
      year: refYear,
      month: refMonth,
      month_key: monthKeyRef,
      month_label: monthLabelPt(refYear, refMonth),
      start_date: from,
      end_date: to,
      label: `${from} até ${to}`,
    },
    summary: {
      opening_balance: safeAmount(totalsBefore.balanceTotalAllTime),
      income_month: income,
      expense_month: expense,
      result_month: income - expense,
      closing_balance: safeAmount(totalsEnd.balanceTotalAllTime),
      expense_percent_of_income: income > 0 ? (expense / income) * 100 : 0,
    },
    movements: txMonth.map((row) => ({
      date: row.occurred_on,
      type: row.kind === "income" ? "Receita" : "Despesa",
      category: row.category || "Geral",
      description: row.description || "",
      payment_method: row.payment_method || "",
      source: row.source || "",
      amount: safeAmount(row.amount),
    })),
    credit_cards: {
      cards: creditCards,
      projection: monthProjection,
    },
    bills,
    expense_by_category: expenseByCategory,
    comparative_12m: comparative,
  };
}

function workbookFromMonthlyReport(report) {
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    ["Relatório", "Resumo Mensal"],
    ["Período", report.period.label || report.period.month_label],
    ["Gerado em", report.generated_at],
    ["Saldo inicial", report.summary.opening_balance],
    ["Entradas no mês", report.summary.income_month],
    ["Saídas no mês", report.summary.expense_month],
    ["Resultado do mês", report.summary.result_month],
    ["Saldo final", report.summary.closing_balance],
    ["% gasto da renda", report.summary.expense_percent_of_income / 100],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 24 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo_Mensal");

  const wsMovements = XLSX.utils.json_to_sheet(
    report.movements.map((r) => ({
      Data: r.date,
      Tipo: r.type,
      Categoria: r.category,
      Descricao: r.description,
      Forma_Pagamento: r.payment_method,
      Origem: r.source,
      Valor: r.amount,
    }))
  );
  wsMovements["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 36 }, { wch: 16 }, { wch: 12 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsMovements, "Extrato_Movimentacoes");

  const wsCards = XLSX.utils.json_to_sheet(
    report.credit_cards.cards.map((r) => ({
      Cartao: r.card_name,
      Dia_Vencimento: r.due_day || "",
      Total_Mes_Atual: r.current_month_total,
      Total_Proximo_Mes: r.next_month_total,
    }))
  );
  wsCards["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsCards, "Cartao_Resumo");

  const wsCardsProjection = XLSX.utils.json_to_sheet(
    report.credit_cards.projection.map((r) => ({
      Mes: r.month_label,
      Mes_Key: r.month_key,
      Total: r.total,
    }))
  );
  wsCardsProjection["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsCardsProjection, "Cartao_Projecao");

  const wsBills = XLSX.utils.json_to_sheet(
    report.bills.map((r) => ({
      Conta: r.name,
      Dia_Vencimento: r.due_day || "",
      Valor_Referencia: r.amount_reference,
      Pago: r.paid ? "Sim" : "Não",
      Valor_Pago: r.amount_paid,
      Data_Pagamento: r.paid_at || "",
      Aviso_1_Dia_Antes: r.notify_one_day_before ? "Sim" : "Não",
    }))
  );
  wsBills["!cols"] = [{ wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsBills, "Contas_Do_Mes");

  const wsCategories = XLSX.utils.json_to_sheet(
    report.expense_by_category.map((r) => ({
      Categoria: r.category,
      Valor: r.amount,
    }))
  );
  wsCategories["!cols"] = [{ wch: 24 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsCategories, "Gastos_Categoria");

  const wsComparative = XLSX.utils.json_to_sheet(
    report.comparative_12m.map((r) => ({
      Mes: r.month_label,
      Entradas: r.income,
      Saidas: r.expense,
      Resultado: r.balance,
    }))
  );
  wsComparative["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsComparative, "Comparativo_12M");

  return wb;
}

async function buildCategoryList(sb, kind, userId) {
  // Primeiro tenta categorias do usuário (user_categories)
  let userQ = sb.from("user_categories").select("name, kind").eq("user_id", userId).order("sort_order");
  if (kind === "income") userQ = userQ.in("kind", ["income","both"]);
  else if (kind === "expense") userQ = userQ.in("kind", ["expense","both"]);
  const { data: userCats } = await userQ;
  const fromUser = (userCats || []).map(c => c.name);
  if (fromUser.length > 0) return fromUser;

  // Fallback: somente categorias já usadas em transações do usuário.
  if (kind === "income") {
    const fromDb = await distinctCategoriesByKind(sb, "income", userId);
    return fromDb.length ? fromDb : CATEGORIES_LEGACY_FALLBACK;
  }
  if (kind === "expense") {
    const fromDb = await distinctCategoriesByKind(sb, "expense", userId);
    const list = [...fromDb];
    return list.length ? list : CATEGORIES_LEGACY_FALLBACK;
  }
  const fromDb = await distinctCategories(sb, userId);
  let list = [...fromDb];
  if (!list.length) list = CATEGORIES_LEGACY_FALLBACK;
  return list;
}

// ─── Rotas públicas ────────────────────────────────────────────────────────

// Login por celular: phone + password → busca email → retorna session JWT
api.post(
  "/auth/phone-login",
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    const password = req.body?.password;
    if (!rawPhone || !password) {
      return res.status(400).json({ error: "Celular e senha são obrigatórios" });
    }
    const sb = getSupabase();
    const { data: profile, error: pErr } = await sb
      .from("user_profiles")
      .select("id")
      .eq("whatsapp_phone", rawPhone)
      .single();
    if (pErr || !profile) {
      return res.status(404).json({ error: "Nenhuma conta encontrada para este número" });
    }
    const adminRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${profile.id}`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const adminUser = await adminRes.json();
    if (!adminRes.ok || !adminUser.email) {
      return res.status(404).json({ error: "Conta não encontrada" });
    }
    const loginRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email: adminUser.email, password }),
      }
    );
    const session = await loginRes.json();
    if (!loginRes.ok) {
      return res.status(401).json({ error: "Celular ou senha incorretos" });
    }
    res.json(session);
  })
);

api.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const sb = getSupabase();
    const { error } = await sb.from("transactions").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true });
  })
);

// Expõe config pública para o frontend inicializar o Supabase JS client
api.get("/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// ─── Perfil do usuário (auth apenas, sem checar has_access) ────────────────

api.get(
  "/profile",
  authOnly,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_profiles")
      .select("*")
      .eq("id", req.userId)
      .single();
    if (error) throw error;
    res.json(data || { id: req.userId, has_access: false });
  })
);

api.patch(
  "/profile",
  authOnly,
  asyncHandler(async (req, res) => {
    const allowed = ["full_name", "whatsapp_phone", "email"];
    const patch = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        patch[key] = req.body[key] != null ? String(req.body[key]).trim().slice(0, 200) : null;
      }
    }
    // Salva UTM somente se ainda não tem (primeira vez)
    if (req.body?.utm_slug && !patch.utm_slug) {
      patch.utm_slug = String(req.body.utm_slug).slice(0, 100);
    }
    if (req.body?.utm_source && !patch.utm_source) {
      patch.utm_source = String(req.body.utm_source).slice(0, 100);
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: "Nenhum campo válido enviado" });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_profiles")
      .update(patch)
      .eq("id", req.userId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  })
);

// ─── Admin: liberar acesso manualmente ────────────────────────────────────

api.post(
  "/admin/grant-access",
  asyncHandler(async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.get("x-admin-secret") !== adminSecret) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    const { user_id, payment_ref } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_profiles")
      .update({
        has_access: true,
        paid_at: new Date().toISOString(),
        payment_ref: payment_ref || null,
      })
      .eq("id", user_id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, profile: data });
  })
);

// ─── Rotas protegidas (auth + acesso pago) ─────────────────────────────────

api.get("/dashboard", authRequired, asyncHandler(dashboardRoute));

api.get(
  "/summary",
  authRequired,
  asyncHandler(async (req, res) => {
    const y = parseInt(String(req.query.year || new Date().getFullYear()), 10);
    const m = parseInt(String(req.query.month || new Date().getMonth() + 1), 10);
    if (m < 1 || m > 12) return res.status(400).json({ error: "month inválido" });

    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;

    const sb = getSupabase();
    const { data: rows, error } = await sb
      .from("transactions")
      .select("kind, amount")
      .eq("user_id", req.userId)
      .gte("occurred_on", start)
      .lt("occurred_on", end);
    if (error) throw error;

    let income = 0;
    let expense = 0;
    for (const r of rows || []) {
      const a = Number(r.amount);
      if (r.kind === "income") income += a;
      else expense += a;
    }

    const { data: inv, error: invErr } = await sb
      .from("investments")
      .select("balance")
      .eq("user_id", req.userId);
    if (invErr) throw invErr;
    const investmentsTotal = (inv || []).reduce((s, r) => s + Number(r.balance || 0), 0);

    const { data: bills, error: bErr } = await sb
      .from("bill_payments")
      .select("paid")
      .eq("user_id", req.userId)
      .eq("year", y)
      .eq("month", m);
    if (bErr) throw bErr;
    const list = bills || [];
    const paidCount = list.filter((b) => b.paid).length;
    const billsProgress =
      list.length === 0 ? null : { paid: paidCount, total: list.length };

    res.json({ year: y, month: m, income, expense, balance: income - expense, investmentsTotal, billsProgress });
  })
);

api.get(
  "/reports/monthly",
  authRequired,
  asyncHandler(async (req, res) => {
    const period = resolveReportPeriod(req.query || {});
    if (!period) return res.status(400).json({ error: "Informe from/to válidos (YYYY-MM-DD) ou year/month." });
    const sb = getSupabase();
    const report = await buildMonthlyReport(sb, req.userId, period);
    res.json(report);
  })
);

api.get(
  "/reports/monthly.xlsx",
  authRequired,
  asyncHandler(async (req, res) => {
    const period = resolveReportPeriod(req.query || {});
    if (!period) return res.status(400).json({ error: "Informe from/to válidos (YYYY-MM-DD) ou year/month." });
    const sb = getSupabase();
    const report = await buildMonthlyReport(sb, req.userId, period);
    const wb = workbookFromMonthlyReport(report);
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `relatorio-${report.period.start_date}_${report.period.end_date}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  })
);

api.get(
  "/transactions",
  authRequired,
  asyncHandler(async (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    const kind = req.query.kind;
    const limit = Math.min(parseInt(String(req.query.limit || "200"), 10) || 200, 500);

    const sb = getSupabase();
    let q = sb
      .from("transactions")
      .select("*")
      .eq("user_id", req.userId)
      .order("occurred_on", { ascending: false })
      .limit(limit);
    if (from) q = q.gte("occurred_on", from);
    if (to) q = q.lte("occurred_on", to);
    if (kind === "income" || kind === "expense") q = q.eq("kind", kind);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  })
);

api.get(
  "/categories/income",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    res.json(await buildCategoryList(sb, "income", req.userId));
  })
);
api.get(
  "/categories/expense",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    res.json(await buildCategoryList(sb, "expense", req.userId));
  })
);
api.get(
  "/categories",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const kind = normalizeKindQuery(req.query.kind);
    res.json(await buildCategoryList(sb, kind, req.userId));
  })
);

api.post(
  "/transactions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { kind, category, amount, description, occurred_on, source, payment_method } = req.body || {};
    if (kind !== "income" && kind !== "expense") {
      return res.status(400).json({ error: "kind deve ser income ou expense" });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount inválido" });
    }
    const VALID_PAYMENT_METHODS = ["pix","debito","boleto","dinheiro","transferencia","credito"];
    const normalizedCategory =
      typeof category === "string" && category.trim() ? category.trim() : "Geral";
    const row = {
      user_id: req.userId,
      kind,
      category: normalizedCategory,
      amount: amt,
      description: normalizeDescriptionForKind(kind, normalizedCategory, description),
      occurred_on: occurred_on || new Date().toISOString().slice(0, 10),
      source: source === "whatsapp" || source === "import" || source === "api" ? source : "manual",
      payment_method: VALID_PAYMENT_METHODS.includes(payment_method) ? payment_method : null,
    };
    const sb = getSupabase();
    const { data, error } = await sb.from("transactions").insert(row).select().single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

const TX_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

api.patch(
  "/transactions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || !TX_ID_RE.test(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    const patch = {};
    const { kind, category, amount, description, occurred_on, payment_method } = req.body || {};
    const VALID_PAYMENT_METHODS = ["pix","debito","boleto","dinheiro","transferencia","credito"];

    if (kind != null) {
      if (kind !== "income" && kind !== "expense") {
        return res.status(400).json({ error: "kind deve ser income ou expense" });
      }
      patch.kind = kind;
    }
    if (category != null) {
      patch.category = String(category).trim() || "Geral";
    }
    if (amount != null) {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "amount inválido" });
      }
      patch.amount = amt;
    }
    if (description != null) {
      patch.description = String(description).slice(0, 500) || null;
    }
    if (occurred_on != null) {
      patch.occurred_on = occurred_on || new Date().toISOString().slice(0, 10);
    }
    if (payment_method !== undefined) {
      patch.payment_method = VALID_PAYMENT_METHODS.includes(payment_method) ? payment_method : null;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: "Nenhum campo válido enviado" });
    }

    const sb = getSupabase();
    const { data, error } = await sb
      .from("transactions")
      .update(patch)
      .eq("id", id)
      .eq("user_id", req.userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: "Lançamento não encontrado" });
    }
    res.json(data);
  })
);

api.delete(
  "/transactions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || !TX_ID_RE.test(id)) {
      return res.status(400).json({ error: "id inválido" });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("user_id", req.userId)
      .select("id");
    if (error) throw error;
    if (!data || !data.length) {
      return res.status(404).json({ error: "Lançamento não encontrado" });
    }
    res.status(204).end();
  })
);

api.get(
  "/investments",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("investments")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true })
      .order("broker_name", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/investments",
  authRequired,
  asyncHandler(async (req, res) => {
    const { broker_name, balance, notes, sort_order } = req.body || {};
    if (!broker_name || typeof broker_name !== "string") {
      return res.status(400).json({ error: "broker_name obrigatório" });
    }
    const b = Number(balance);
    if (!Number.isFinite(b) || b < 0) {
      return res.status(400).json({ error: "balance inválido" });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("investments")
      .insert({
        user_id: req.userId,
        broker_name: broker_name.trim().slice(0, 120),
        balance: b,
        notes: notes != null ? String(notes).slice(0, 500) : null,
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.patch(
  "/investments/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { broker_name, balance, notes, sort_order } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (broker_name != null) patch.broker_name = String(broker_name).trim().slice(0, 120);
    if (balance != null) {
      const b = Number(balance);
      if (!Number.isFinite(b) || b < 0) return res.status(400).json({ error: "balance inválido" });
      patch.balance = b;
    }
    if (notes !== undefined) patch.notes = notes != null ? String(notes).slice(0, 500) : null;
    if (sort_order != null && Number.isFinite(Number(sort_order))) patch.sort_order = Number(sort_order);

    const sb = getSupabase();
    const { data, error } = await sb
      .from("investments")
      .update(patch)
      .eq("id", id)
      .eq("user_id", req.userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json(data);
  })
);

api.delete(
  "/investments/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { error } = await sb
      .from("investments")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.userId);
    if (error) throw error;
    res.status(204).end();
  })
);

api.get(
  "/bills",
  authRequired,
  asyncHandler(async (req, res) => {
    const y = parseInt(String(req.query.year || new Date().getFullYear()), 10);
    const m = parseInt(String(req.query.month || new Date().getMonth() + 1), 10);
    const sb = getSupabase();
    const { data: templates, error: e1 } = await sb
      .from("recurring_bills")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (e1) throw e1;

    const { data: payments, error: e2 } = await sb
      .from("bill_payments")
      .select("*")
      .eq("user_id", req.userId)
      .eq("year", y)
      .eq("month", m);
    if (e2) throw e2;

    const payMap = new Map((payments || []).map((p) => [p.bill_id, p]));
    const items = (templates || []).map((t) => {
      const p = payMap.get(t.id);
      return { ...t, payment: p || null, paid: p ? !!p.paid : false };
    });
    res.json({ year: y, month: m, items });
  })
);

api.post(
  "/bills/template",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, default_amount, due_day, notify_one_day_before, sort_order } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name obrigatório" });
    const due = due_day != null && due_day !== "" ? Number(due_day) : null;
    if (due != null && (!Number.isInteger(due) || due < 1 || due > 31)) {
      return res.status(400).json({ error: "due_day inválido (1-31)" });
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("recurring_bills")
      .insert({
        user_id: req.userId,
        name: name.trim().slice(0, 200),
        default_amount: Number(default_amount) || 0,
        due_day: due,
        notify_one_day_before: !!notify_one_day_before,
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.get(
  "/bills/notifications/next-day",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const tz = process.env.APP_TIMEZONE || "America/Sao_Paulo";
    const today = new Date();
    const ymdToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(today);

    const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? new Date(`${req.query.date}T12:00:00Z`)
      : new Date(`${ymdToday}T12:00:00Z`);
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);

    const dueYear = baseDate.getUTCFullYear();
    const dueMonth = baseDate.getUTCMonth() + 1;
    const dueDay = baseDate.getUTCDate();
    const dueDate = `${dueYear}-${String(dueMonth).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;

    const sb = getSupabase();
    const { data: bills, error: bErr } = await sb
      .from("recurring_bills")
      .select("id,user_id,name,default_amount,due_day,notify_one_day_before")
      .eq("notify_one_day_before", true)
      .eq("due_day", dueDay);
    if (bErr) throw bErr;

    const rows = bills || [];
    if (!rows.length) {
      return res.json({ due_date: dueDate, total: 0, items: [] });
    }

    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const { data: profiles, error: pErr } = await sb
      .from("user_profiles")
      .select("id,full_name,whatsapp_phone,has_access")
      .in("id", userIds);
    if (pErr) throw pErr;

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    const items = rows
      .map((bill) => {
        const profile = profileMap.get(bill.user_id);
        if (!profile || !profile.has_access || !profile.whatsapp_phone) return null;
        return {
          user_id: bill.user_id,
          full_name: profile.full_name || null,
          whatsapp_phone: profile.whatsapp_phone,
          bill_id: bill.id,
          bill_name: bill.name,
          bill_type: "conta_do_mes",
          bill_amount: Number(bill.default_amount) || 0,
          due_day: bill.due_day,
          due_date: dueDate,
          notify_one_day_before: true,
        };
      })
      .filter(Boolean);

    res.json({ due_date: dueDate, total: items.length, items });
  })
);

api.patch(
  "/bills/:billId/pay",
  authRequired,
  asyncHandler(async (req, res) => {
    const { billId } = req.params;
    const y = parseInt(String(req.body?.year ?? req.query.year ?? new Date().getFullYear()), 10);
    const m = parseInt(String(req.body?.month ?? req.query.month ?? new Date().getMonth() + 1), 10);
    const paid = req.body?.paid !== false;
    const amount_paid = req.body?.amount_paid != null ? Number(req.body.amount_paid) : null;
    const paid_at = req.body?.paid_at || new Date().toISOString().slice(0, 10);

    const sb = getSupabase();
    const { data: bill, error: be } = await sb
      .from("recurring_bills")
      .select("*")
      .eq("id", billId)
      .eq("user_id", req.userId)
      .single();
    if (be) throw be;
    if (!bill) return res.status(404).json({ error: "Conta não encontrada" });

    const row = {
      user_id: req.userId,
      bill_id: billId,
      year: y,
      month: m,
      paid,
      amount_paid: amount_paid != null && Number.isFinite(amount_paid) ? amount_paid : bill.default_amount,
      paid_at: paid ? paid_at : null,
    };

    const { data, error } = await sb
      .from("bill_payments")
      .upsert(row, { onConflict: "bill_id,year,month" })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  })
);

api.get(
  "/pots",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("budget_pots")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

api.put(
  "/pots",
  authRequired,
  asyncHandler(async (req, res) => {
    const pots = req.body?.pots;
    if (!Array.isArray(pots)) return res.status(400).json({ error: "pots deve ser array" });
    const sb = getSupabase();
    const { data: existing, error: e0 } = await sb
      .from("budget_pots")
      .select("id")
      .eq("user_id", req.userId);
    if (e0) throw e0;
    if (existing?.length) {
      const { error: eDel } = await sb
        .from("budget_pots")
        .delete()
        .in("id", existing.map((r) => r.id));
      if (eDel) throw eDel;
    }
    const rows = pots
      .map((p, i) => ({
        user_id: req.userId,
        name: String(p.name || "").slice(0, 120),
        percent: Math.min(1, Math.max(0, Number(p.percent) || 0)),
        sort_order: i,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.name);
    if (rows.length === 0) return res.json([]);
    const { data, error } = await sb.from("budget_pots").insert(rows).select();
    if (error) throw error;
    res.json(data);
  })
);

// ─── Checkout via WhatsApp (bot cria o pending_payment) ───────────────────

api.post(
  "/checkout/whatsapp",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const { name, phone } = req.body || {};
    const rawPhone = String(phone || "").replace(/\D/g, "");
    if (!rawPhone || rawPhone.length < 10) {
      return res.status(400).json({ error: "phone inválido" });
    }
    const displayName = name && String(name).trim() ? String(name).trim().slice(0, 200) : "Cliente WhatsApp";
    const price = Number(process.env.PRICE || 27.90);

    const sb = getSupabase();

    // Verifica se já existe um pending_payment para esse telefone
    const { data: existing } = await sb
      .from("pending_payments")
      .select("id, status, activation_token")
      .eq("whatsapp_phone", rawPhone)
      .in("status", ["pending", "confirmed"])
      .order("created_at", { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      const p = existing[0];
      if (p.status === "confirmed") {
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        return res.json({
          ok: true,
          already: true,
          status: "confirmed",
          activation_link: `${appUrl}/ativar?token=${p.activation_token}`,
        });
      }
      return res.json({ ok: true, already: true, status: "pending" });
    }

    const { data, error } = await sb
      .from("pending_payments")
      .insert({
        name: displayName,
        whatsapp_phone: rawPhone,
        amount: price,
        notes: "Venda via WhatsApp",
      })
      .select("id, name, whatsapp_phone, amount, created_at")
      .single();
    if (error) throw error;
    res.status(201).json({ ok: true, payment: data, status: "created" });
  })
);

// ─── Checkout: criar pagamento pendente (público) ─────────────────────────

api.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    const { name, whatsapp_phone, email, notes, utm_slug, utm_source } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name obrigatório" });
    }
    const rawPhone = String(whatsapp_phone || "").replace(/\D/g, "");
    if (!rawPhone || rawPhone.length < 10) {
      return res.status(400).json({ error: "whatsapp_phone inválido" });
    }
    const price = Number(process.env.PRICE || 97);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("pending_payments")
      .insert({
        name: name.trim().slice(0, 200),
        whatsapp_phone: rawPhone,
        email: email ? String(email).trim().slice(0, 200) : null,
        amount: price,
        notes: notes ? String(notes).slice(0, 500) : null,
        utm_slug: utm_slug ? String(utm_slug).slice(0, 100) : null,
        utm_source: utm_source ? String(utm_source).slice(0, 100) : null,
      })
      .select("id, name, whatsapp_phone, amount, created_at")
      .single();
    if (error) throw error;
    res.status(201).json({ ok: true, payment: data });
  })
);

// ─── Ativação: validar token e criar conta ─────────────────────────────────

api.get(
  "/activate",
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "token obrigatório" });
    const sb = getSupabase();
    const { data, error } = await sb
      .from("pending_payments")
      .select("id, name, whatsapp_phone, email, status")
      .eq("activation_token", token)
      .single();
    if (error || !data) return res.status(404).json({ error: "Token inválido ou expirado" });
    if (data.status === "pending") return res.status(402).json({ error: "Pagamento ainda não confirmado" });
    if (data.status === "cancelled") return res.status(410).json({ error: "Este link foi cancelado. Entre em contato com o suporte." });
    // Aceita 'confirmed' e 'activated' (retry após falha parcial)
    res.json({ ok: true, name: data.name, whatsapp_phone: data.whatsapp_phone, email: data.email });
  })
);

api.post(
  "/activate",
  asyncHandler(async (req, res) => {
    const { token, email: rawEmail, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: "token e password são obrigatórios" });
    }
    // Se email vazio, gera email interno a partir do telefone (preenchido após buscar payment)
    let email = rawEmail ? String(rawEmail).trim() : "";
    if (String(password).length < 6) {
      return res.status(400).json({ error: "Senha deve ter ao menos 6 caracteres" });
    }
    const sb = getSupabase();
    const { data: pmt, error: pErr } = await sb
      .from("pending_payments")
      .select("*")
      .eq("activation_token", token)
      .single();
    if (pErr || !pmt) return res.status(404).json({ error: "Token inválido" });
    if (pmt.status === "pending") return res.status(402).json({ error: "Pagamento não confirmado" });
    if (pmt.status === "cancelled") return res.status(410).json({ error: "Pagamento cancelado. Entre em contato com o suporte." });
    // Aceita 'confirmed' e 'activated' (retry após falha parcial)

    // Se email vazio, gera email interno a partir do telefone
    if (!email) {
      const phone = String(pmt.whatsapp_phone).replace(/\D/g, "");
      email = `fz_${phone}@users.financezap.app`;
    }

    // Cria usuário no Supabase Auth via admin API
    const authRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: pmt.name },
        }),
      }
    );
    const authData = await authRes.json();

    let userId;
    if (!authRes.ok) {
      const errMsg = String(authData?.msg || authData?.message || "");
      // Se email já existe, recupera o usuário existente e continua
      const emailTaken = /already registered|already been registered|email.*exist/i.test(errMsg);
      if (!emailTaken) {
        return res.status(400).json({ error: errMsg || JSON.stringify(authData) });
      }
      // Busca o userId pelo email via admin API
      const listRes = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=50`,
        {
          headers: {
            "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const listData = await listRes.json();
      const existing = (listData.users || []).find(u => u.email === email);
      if (!existing) return res.status(400).json({ error: "Email já cadastrado. Use outro email ou faça login." });
      userId = existing.id;
    } else {
      userId = authData.id;
    }

    // Cria/atualiza perfil com has_access = true (propaga UTM do pagamento)
    await sb.from("user_profiles").upsert({
      id: userId,
      full_name: pmt.name,
      whatsapp_phone: pmt.whatsapp_phone,
      has_access: true,
      paid_at: new Date().toISOString(),
      payment_ref: pmt.id,
      ...(pmt.utm_slug   && { utm_slug:   pmt.utm_slug }),
      ...(pmt.utm_source && { utm_source: pmt.utm_source }),
    });

    // Marca token como usado (activated = conta criada com sucesso)
    await sb.from("pending_payments").update({ status: "activated" }).eq("id", pmt.id);

    res.json({ ok: true, message: "Conta criada! Faça login para acessar o dashboard." });
  })
);

// ─── Admin: pagamentos pendentes e confirmação ─────────────────────────────

function requireAdmin(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || req.get("x-admin-secret") !== adminSecret) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

api.get(
  "/admin/pending-payments",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const status = req.query.status || "pending";
    const { data, error } = await sb
      .from("pending_payments")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/admin/confirm-payment/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const sb = getSupabase();
    const { data: pmt, error: pErr } = await sb
      .from("pending_payments")
      .select("*")
      .eq("id", id)
      .single();
    if (pErr || !pmt) return res.status(404).json({ error: "Pagamento não encontrado" });
    if (pmt.status !== "pending") return res.status(409).json({ error: "Pagamento já processado" });

    const { data, error } = await sb
      .from("pending_payments")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
    const activationLink = `${appUrl}/ativar?token=${data.activation_token}`;
    const guiaLink = `${appUrl}/guia`;

    // Garante código do país 55 no telefone
    let whatsappPhone = String(data.whatsapp_phone).replace(/\D/g, "");
    if (!whatsappPhone.startsWith("55")) whatsappPhone = "55" + whatsappPhone;

    const whatsappMsg =
      `🎉 Olá, ${data.name}! Seu pagamento foi confirmado!\n\n` +
      `👉 Crie sua conta aqui:\n${activationLink}\n\n` +
      `📖 Guia de uso:\n${guiaLink}\n\n` +
      `Dúvidas? É só chamar aqui! 😊`;

    // Enviar WhatsApp via n8n
    const sendUrl = process.env.N8N_SEND_WHATSAPP_URL;
    if (sendUrl) {
      try {
        await fetch(sendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-secret": process.env.N8N_WEBHOOK_SECRET || "" },
          body: JSON.stringify({ phone: whatsappPhone, message: whatsappMsg }),
        });
      } catch (e) {
        console.warn("Aviso: falha ao enviar WhatsApp:", e.message);
      }
    }

    // Enviar email de ativação
    let emailResult = { ok: false, reason: "no_email" };
    if (data.email) {
      const emailHtml = buildActivationEmail(data.name, activationLink, guiaLink);
      emailResult = await sendEmail({ to: data.email, subject: "🎉 Seu acesso ao FinanceZap está pronto!", html: emailHtml });
      console.log("📧 Email result for", data.email, ":", JSON.stringify(emailResult));
    } else {
      console.warn("⚠️ Sem email no pending_payment id:", req.params.id);
    }

    res.json({ ok: true, payment: data, emailResult });
  })
);

// ─── Admin: reenviar WhatsApp + Email de ativação ─────────────────────────

api.post(
  "/admin/resend-activation/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("pending_payments")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: "Pagamento não encontrado" });
    if (data.status !== "confirmed") return res.status(400).json({ error: "Pagamento não está confirmado" });

    const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
    const activationLink = `${appUrl}/ativar?token=${data.activation_token}`;
    const guiaLink = `${appUrl}/guia`;

    let whatsappPhone = String(data.whatsapp_phone).replace(/\D/g, "");
    if (!whatsappPhone.startsWith("55")) whatsappPhone = "55" + whatsappPhone;

    const results = { whatsapp: false, email: false };

    // Reenviar WhatsApp
    const sendUrl = process.env.N8N_SEND_WHATSAPP_URL;
    if (sendUrl) {
      const whatsappMsg =
        `🎉 Olá, ${data.name}! Reenviando seu link de ativação:\n\n` +
        `👉 Crie sua conta aqui:\n${activationLink}\n\n` +
        `📖 Guia de uso:\n${guiaLink}\n\n` +
        `Dúvidas? É só chamar aqui! 😊`;
      try {
        const r = await fetch(sendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-secret": process.env.N8N_WEBHOOK_SECRET || "" },
          body: JSON.stringify({ phone: whatsappPhone, message: whatsappMsg }),
        });
        results.whatsapp = r.ok;
      } catch (e) {
        console.warn("Resend WhatsApp error:", e.message);
      }
    }

    // Reenviar Email
    if (data.email) {
      const emailHtml = buildActivationEmail(data.name, activationLink, guiaLink);
      const emailResult = await sendEmail({ to: data.email, subject: "🎉 Seu acesso ao FinanceZap está pronto!", html: emailHtml });
      results.email = emailResult.ok;
    }

    res.json({ ok: true, results });
  })
);

api.post(
  "/admin/cancel-payment/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("pending_payments")
      .update({ status: "cancelled" })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json({ ok: true });
  })
);

// ─── Admin: restaurar pagamento cancelado → volta para pendente ────────────

api.post(
  "/admin/restore-payment/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("pending_payments")
      .update({ status: "pending" })
      .eq("id", req.params.id)
      .in("status", ["cancelled", "activated"])
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json({ ok: true, payment: data });
  })
);

// ─── Admin: revogar acesso ─────────────────────────────────────────────────

api.post(
  "/admin/revoke-access/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_profiles")
      .update({ has_access: false })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json({ ok: true, profile: data });
  })
);

// ─── Admin: métricas gerais ────────────────────────────────────────────────

api.get(
  "/admin/metrics",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();

    // Contagens básicas
    const [
      { count: total_users },
      { count: active_users },
      { count: pending_payments_count },
    ] = await Promise.all([
      sb.from("user_profiles").select("*", { count: "exact", head: true }),
      sb.from("user_profiles").select("*", { count: "exact", head: true }).eq("has_access", true),
      sb.from("pending_payments").select("*", { count: "exact", head: true }).eq("status", "pending"),
    ]);

    // Receita total (pagamentos confirmados + ativados = vendas efetivadas)
    const { data: revenueData } = await sb
      .from("pending_payments")
      .select("amount, status")
      .in("status", ["confirmed", "activated"]);
    const total_revenue = (revenueData || []).reduce((s, r) => s + Number(r.amount || 0), 0);

    // Usuários ativos últimos 7 dias (transações recentes)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { data: activeWeekData } = await sb
      .from("transactions")
      .select("user_id")
      .gte("created_at", sevenDaysAgo.toISOString());
    const weekly_active = new Set((activeWeekData || []).map(r => r.user_id)).size;

    // Transações hoje
    const todayStr = new Date().toISOString().slice(0, 10);
    const { count: transactions_today } = await sb
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("occurred_on", todayStr);

    // Cadastros por dia (últimos 30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data: signupsRaw } = await sb
      .from("user_profiles")
      .select("created_at")
      .gte("created_at", thirtyDaysAgo.toISOString())
      .order("created_at", { ascending: true });

    const signupMap = {};
    for (const r of signupsRaw || []) {
      const day = r.created_at.slice(0, 10);
      signupMap[day] = (signupMap[day] || 0) + 1;
    }
    const signups_by_day = buildDayBuckets(30).map(day => ({ day, count: signupMap[day] || 0 }));

    // Transações por dia (últimos 30 dias)
    const { data: txRaw } = await sb
      .from("transactions")
      .select("occurred_on")
      .gte("occurred_on", thirtyDaysAgo.toISOString().slice(0, 10))
      .order("occurred_on", { ascending: true });

    const txMap = {};
    for (const r of txRaw || []) {
      txMap[r.occurred_on] = (txMap[r.occurred_on] || 0) + 1;
    }
    const tx_by_day = buildDayBuckets(30).map(day => ({ day, count: txMap[day] || 0 }));

    // Últimos usuários cadastrados
    const { data: latest_users } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access, created_at")
      .order("created_at", { ascending: false })
      .limit(8);

    // Usuários com mais transações
    const { data: txByUser } = await sb
      .from("transactions")
      .select("user_id");
    const txCounts = {};
    for (const r of txByUser || []) {
      txCounts[r.user_id] = (txCounts[r.user_id] || 0) + 1;
    }
    const topUserIds = Object.entries(txCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, count]) => ({ id, tx_count: count }));

    let top_users = [];
    if (topUserIds.length) {
      const { data: profiles } = await sb
        .from("user_profiles")
        .select("id, full_name")
        .in("id", topUserIds.map(u => u.id));
      top_users = topUserIds.map(u => ({
        ...u,
        full_name: (profiles || []).find(p => p.id === u.id)?.full_name || "—",
      }));
    }

    res.json({
      total_users: total_users || 0,
      active_users: active_users || 0,
      weekly_active,
      pending_payments: pending_payments_count || 0,
      total_revenue,
      transactions_today: transactions_today || 0,
      signups_by_day,
      tx_by_day,
      latest_users: latest_users || [],
      top_users,
    });
  })
);

function buildDayBuckets(days) {
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

// ─── Admin: lista de usuários com stats ────────────────────────────────────

api.get(
  "/admin/users",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();

    const { data: profiles, error } = await sb
      .from("user_profiles")
      .select("id, full_name, whatsapp_phone, email, has_access, paid_at, created_at, utm_slug, utm_source")
      .order("created_at", { ascending: false });
    if (error) throw error;

    // Mapa slug → nome do influenciador
    const { data: utmLinks } = await sb.from("utm_links").select("slug, name");
    const slugToName = {};
    for (const l of utmLinks || []) slugToName[l.slug] = l.name;

    // Contagem de transações por usuário + última atividade
    const { data: txData } = await sb
      .from("transactions")
      .select("user_id, occurred_on");

    const txCountMap = {};
    const txLastMap = {};
    for (const r of txData || []) {
      txCountMap[r.user_id] = (txCountMap[r.user_id] || 0) + 1;
      if (!txLastMap[r.user_id] || r.occurred_on > txLastMap[r.user_id]) {
        txLastMap[r.user_id] = r.occurred_on;
      }
    }

    const activeUsers = (profiles || []).map(p => ({
      ...p,
      tx_count: txCountMap[p.id] || 0,
      last_activity: txLastMap[p.id] || null,
      influencer_name: p.utm_slug ? (slugToName[p.utm_slug] || p.utm_slug) : null,
    }));

    // Inclui pagamentos confirmados cuja conta ainda não foi ativada
    const { data: confirmedPmts } = await sb
      .from("pending_payments")
      .select("id, name, whatsapp_phone, email, created_at, utm_slug, utm_source")
      .eq("status", "confirmed");

    const existingPhones = new Set((profiles || []).map(p => p.whatsapp_phone));
    const unactivated = (confirmedPmts || [])
      .filter(p => !existingPhones.has(p.whatsapp_phone))
      .map(p => ({
        id: p.id,
        full_name: p.name,
        whatsapp_phone: p.whatsapp_phone,
        email: p.email,
        has_access: false,
        pending_activation: true,
        created_at: p.created_at,
        tx_count: 0,
        last_activity: null,
        utm_slug: p.utm_slug,
        utm_source: p.utm_source,
        influencer_name: p.utm_slug ? (slugToName[p.utm_slug] || p.utm_slug) : null,
      }));

    res.json([...activeUsers, ...unactivated]);
  })
);

// ─── Admin: UTM Links ─────────────────────────────────────────────────────

api.get(
  "/admin/utm-links",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("utm_links")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/admin/utm-links",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, slug, utm_source, utm_medium, utm_campaign, utm_content, utm_term, base_url, notes } = req.body;
    if (!name || !slug || !utm_source) {
      return res.status(400).json({ error: "name, slug e utm_source são obrigatórios" });
    }
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const sb = getSupabase();
    const { data, error } = await sb
      .from("utm_links")
      .insert({
        name: name.trim(),
        slug: cleanSlug,
        utm_source: utm_source.trim(),
        utm_medium: (utm_medium || "influencer").trim(),
        utm_campaign: (utm_campaign || "lancamento").trim(),
        utm_content: utm_content?.trim() || null,
        utm_term: utm_term?.trim() || null,
        base_url: (base_url || "https://financezap.thesilasstudio.com.br").trim(),
        notes: notes?.trim() || null,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Slug já existe. Use outro identificador." });
      throw error;
    }
    res.json(data);
  })
);

api.patch(
  "/admin/utm-links/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, slug, utm_source, utm_medium, utm_campaign, utm_content, utm_term, base_url, notes } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (slug !== undefined) updates.slug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (utm_source !== undefined) updates.utm_source = utm_source.trim();
    if (utm_medium !== undefined) updates.utm_medium = utm_medium.trim();
    if (utm_campaign !== undefined) updates.utm_campaign = utm_campaign.trim();
    if (utm_content !== undefined) updates.utm_content = utm_content?.trim() || null;
    if (utm_term !== undefined) updates.utm_term = utm_term?.trim() || null;
    if (base_url !== undefined) updates.base_url = base_url.trim();
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    const sb = getSupabase();
    const { data, error } = await sb
      .from("utm_links")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Slug já existe. Use outro identificador." });
      throw error;
    }
    res.json(data);
  })
);

api.delete(
  "/admin/utm-links/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const sb = getSupabase();
    const { error } = await sb.from("utm_links").delete().eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  })
);

// ─── Redirect UTM: /r/:slug ────────────────────────────────────────────────

app.get("/r/:slug", asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("utm_links")
    .select("*")
    .eq("slug", slug)
    .single();
  if (error || !data) return res.redirect(302, "https://financezap.thesilasstudio.com.br");

  // Incrementa click_count (fire-and-forget)
  sb.from("utm_links").update({ click_count: (data.click_count || 0) + 1 }).eq("id", data.id).then(() => {});

  const params = new URLSearchParams();
  params.set("utm_source", data.utm_source);
  params.set("utm_medium", data.utm_medium);
  params.set("utm_campaign", data.utm_campaign);
  if (data.utm_content) params.set("utm_content", data.utm_content);
  if (data.utm_term) params.set("utm_term", data.utm_term);

  params.set("ref", data.slug);
  const destination = `${data.base_url}?${params.toString()}`;
  res.redirect(302, destination);
}));

// ─── Webhook: verificar usuário por telefone (para n8n) ───────────────────

api.post(
  "/webhook/check-user",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!rawPhone) return res.status(400).json({ error: "phone obrigatório" });

    const sb = getSupabase();

    // Normaliza telefone: tenta com e sem código do país (55)
    const phoneVars = [rawPhone];
    if (rawPhone.startsWith("55") && rawPhone.length > 10) phoneVars.push(rawPhone.slice(2));
    else phoneVars.push("55" + rawPhone);

    const { data: profiles } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .in("whatsapp_phone", phoneVars)
      .limit(1);

    const profile = profiles?.[0] || null;

    if (!profile) {
      return res.json({ exists: false, has_access: false });
    }

    // Busca categorias do usuário para o menu
    const { data: cats } = await sb
      .from("user_categories")
      .select("name, kind")
      .eq("user_id", profile.id)
      .order("sort_order");

    const income_categories = (cats || []).filter(c => c.kind === "income" || c.kind === "both").map(c => c.name);
    const expense_categories = (cats || []).filter(c => c.kind === "expense" || c.kind === "both").map(c => c.name);

    res.json({
      exists: true,
      has_access: profile.has_access,
      user_id: profile.id,
      name: profile.full_name,
      income_categories: income_categories.length ? income_categories : ["Salário", "Freelance", "Aluguel recebido", "Outros"],
      expense_categories: expense_categories.length ? expense_categories : ["Alimentação", "Transporte", "Moradia", "Saúde", "Lazer", "Outros"],
    });
  })
);

// ─── Webhook: chat WhatsApp com máquina de estados ────────────────────────

// ── Menu principal como List Message (Evolution API) ─────────────────────────
const WHATSAPP_MENU_LIST = (name) => ({
  title: "FinanceZap 💰",
  description: `Olá, *${name}*! 👋 Bem-vindo ao seu assistente financeiro.\n\nO que você quer fazer hoje?`,
  footer: "FinanceZap · Controle financeiro pelo WhatsApp",
  buttonText: "📋 Ver opções",
  sections: [
    {
      title: "💸 Lançamentos",
      rows: [
        { rowId: "2", title: "💚 Lançar receita", description: "Salário, freelance e outras entradas" },
        { rowId: "3", title: "❤️ Lançar despesa",  description: "Mercado, conta, transporte..." },
        { rowId: "4", title: "💳 Cartão de crédito", description: "Compras parceladas ou à vista" },
      ],
    },
    {
      title: "📊 Consultas",
      rows: [
        { rowId: "1", title: "📊 Ver extrato", description: "Histórico de transações por período" },
        { rowId: "5", title: "💰 Saldo atual", description: "Resumo do saldo da conta" },
        { rowId: "6", title: "🤔 Tirar dúvida", description: "Pergunte qualquer coisa sobre finanças" },
      ],
    },
  ],
});

// Texto de fallback (caso Evolution não suporte list)
const WHATSAPP_MENU = (name) =>
  `Olá, *${name}*! 👋 O que você quer fazer?\n\n` +
  `1️⃣ Extrato por período\n` +
  `2️⃣ Lançar receita\n` +
  `3️⃣ Lançar despesa\n` +
  `4️⃣ Lançar no cartão de crédito\n` +
  `5️⃣ Saldo atual\n` +
  `6️⃣ Tirar uma dúvida\n\n` +
  `_Digite o número da opção ou descreva o que quer fazer._`;

api.post(
  "/webhook/whatsapp-chat",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    const text = String(req.body?.text || "").trim();
    const pushName = req.body?.pushName || "você";

    if (!rawPhone || !text) {
      return res.status(400).json({ error: "phone e text são obrigatórios" });
    }

    const sb = getSupabase();

    // Normaliza telefone: tenta com e sem código do país (55)
    const phoneVariants = [rawPhone];
    if (rawPhone.startsWith("55") && rawPhone.length > 10) {
      phoneVariants.push(rawPhone.slice(2)); // sem 55
    } else {
      phoneVariants.push("55" + rawPhone); // com 55
    }

    // Busca usuário por qualquer variante do telefone
    const { data: profiles } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access, whatsapp_phone")
      .in("whatsapp_phone", phoneVariants)
      .limit(1);

    const profile = profiles?.[0] || null;

    // Usuário não cadastrado → resposta de vendas
    if (!profile) {
      return res.json({ type: "sales", registered: false });
    }

    // Usuário sem acesso
    if (!profile.has_access) {
      return res.json({
        type: "no_access",
        registered: true,
        reply: `⏳ Olá, *${profile.full_name}*! Seu cadastro existe mas o acesso ainda não foi liberado.\n\nSe você já realizou o pagamento, aguarde a confirmação. Dúvidas? Responda aqui! 😊`,
      });
    }

    // Busca sessão atual
    const { data: session } = await sb
      .from("whatsapp_sessions")
      .select("*")
      .eq("phone", rawPhone)
      .single();

    const state = session?.state || null;
    const ctx = session?.context || {};
    const lower = text.toLowerCase().trim();

    async function saveSession(newState, newCtx = {}) {
      await sb.from("whatsapp_sessions").upsert({
        phone: rawPhone,
        user_id: profile.id,
        state: newState,
        context: newCtx,
        updated_at: new Date().toISOString(),
      }, { onConflict: "phone" });
    }

    async function clearSession() {
      await sb.from("whatsapp_sessions").delete().eq("phone", rawPhone);
    }

    // Helper: formata moeda
    const brl = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
    const parseAmountInput = (value) => parseFloat(String(value || "").replace(",", ".").replace(/[^0-9.]/g, ""));
    const appTodayYMD = () => accumulatedThroughYMD();

    // ── Detecta "cancelar" em qualquer estado
    if (["cancelar", "sair", "voltar", "menu", "cancel"].includes(lower)) {
      await clearSession();
      return res.json({ type: "list", listData: WHATSAPP_MENU_LIST(profile.full_name), reply: WHATSAPP_MENU(profile.full_name) });
    }

    // ── Estado: aguardando dias do extrato
    if (state === "waiting_extrato_days") {
      const days = parseInt(lower.replace(/\D/g, ""), 10);
      if (!days || days < 1 || days > 365) {
        return res.json({ type: "user", reply: "Por favor, informe um número de dias válido (ex: *7*, *30*, *90*)." });
      }
      const asOf = accumulatedThroughYMD();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const { data: txs } = await sb
        .from("transactions")
        .select("kind, amount, category, occurred_on")
        .eq("user_id", profile.id)
        .gte("occurred_on", fromStr)
        .lte("occurred_on", asOf)
        .order("occurred_on", { ascending: false })
        .limit(50);

      await clearSession();

      if (!txs || !txs.length) {
        return res.json({ type: "user", reply: `Nenhuma transação encontrada nos últimos *${days} dias*.` });
      }

      let income = 0, expense = 0;
      const lines = txs.slice(0, 15).map(t => {
        const emoji = t.kind === "income" ? "💚" : "❤️";
        if (t.kind === "income") income += Number(t.amount);
        else expense += Number(t.amount);
        return `${emoji} ${t.occurred_on.slice(5)} ${t.category}: *${brl(t.amount)}*`;
      });

      const balance = income - expense;
      const resumo = txs.length > 15 ? `\n_...e mais ${txs.length - 15} lançamentos_` : "";
      return res.json({
        type: "user",
        reply: `📊 *Extrato dos últimos ${days} dias:*\n\n${lines.join("\n")}${resumo}\n\n💰 Receitas: *${brl(income)}*\n💸 Despesas: *${brl(expense)}*\n📈 Saldo: *${brl(balance)}*`,
      });
    }

    // ── Estado: aguardando categoria de receita
    if (state === "waiting_receita_category") {
      const { data: cats } = await sb
        .from("user_categories")
        .select("name")
        .eq("user_id", profile.id)
        .in("kind", ["income", "both"])
        .order("sort_order");
      const catList = (cats || []).map(c => c.name);
      const num = parseInt(lower, 10);
      let category = lower.charAt(0).toUpperCase() + lower.slice(1);
      if (num > 0 && catList[num - 1]) category = catList[num - 1];
      else if (catList.find(c => c.toLowerCase() === lower)) category = catList.find(c => c.toLowerCase() === lower);

      await saveSession("waiting_receita_amount", { category });
      return res.json({ type: "user", reply: `💚 Categoria: *${category}*\n\nAgora informe o *valor* (ex: 1500 ou 1500,50):` });
    }

    // ── Estado: aguardando valor de receita
    if (state === "waiting_receita_amount") {
      const amount = parseFloat(lower.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!amount || amount <= 0) {
        return res.json({ type: "user", reply: "Valor inválido. Informe o valor da receita (ex: *1500* ou *1500,50*):" });
      }
      const { data: tx } = await sb.from("transactions").insert({
        user_id: profile.id, kind: "income",
        category: ctx.category || "Receita", amount,
        occurred_on: appTodayYMD(), source: "whatsapp",
      }).select().single();
      await clearSession();
      const today = new Date();
      const dateStr = today.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
      return res.json({ type: "user", reply:
        `✅ *Receita registrada com sucesso!* 💚\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Descrição:* ${ctx.category}\n` +
        `💰 *Valor:* ${brl(amount)}\n` +
        `🏷️ *Categoria:* ${ctx.category}\n` +
        `📅 *Data:* ${dateStr}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 Para ver relatórios detalhados, acesse:\n${appUrl}/insights/\n\n` +
        `_Se precisar de algo mais, é só chamar! 🎉_`
      });
    }

    // ── Estado: aguardando categoria de despesa
    if (state === "waiting_despesa_category") {
      const { data: cats } = await sb
        .from("user_categories")
        .select("name")
        .eq("user_id", profile.id)
        .in("kind", ["expense", "both"])
        .order("sort_order");
      const catList = (cats || []).map(c => c.name);
      const num = parseInt(lower, 10);
      let category = lower.charAt(0).toUpperCase() + lower.slice(1);
      if (num > 0 && catList[num - 1]) category = catList[num - 1];
      else if (catList.find(c => c.toLowerCase() === lower)) category = catList.find(c => c.toLowerCase() === lower);

      await saveSession("waiting_despesa_amount", { category });
      return res.json({ type: "user", reply: `❤️ Categoria: *${category}*\n\nAgora informe o *valor* (ex: 250 ou 89,90):` });
    }

    // ── Estado: aguardando valor de despesa
    if (state === "waiting_despesa_amount") {
      const amount = parseAmountInput(lower);
      if (!amount || amount <= 0) {
        return res.json({ type: "user", reply: "Valor inválido. Informe o valor da despesa (ex: *250* ou *89,90*):" });
      }
      await saveSession("waiting_despesa_payment", { ...ctx, amount });
      return res.json({ type: "user", reply: `💸 Valor: *${brl(amount)}*\n\nComo foi pago?\n\n1️⃣ PIX\n2️⃣ Débito\n3️⃣ Boleto\n4️⃣ Dinheiro\n5️⃣ Transferência\n\n_Digite o número ou nome._` });
    }

    // ── Estado: aguardando forma de pagamento de despesa
    if (state === "waiting_despesa_payment") {
      const PM_MAP = { "1":"pix","pix":"pix","2":"debito","débito":"debito","debito":"debito","3":"boleto","boleto":"boleto","4":"dinheiro","dinheiro":"dinheiro","5":"transferencia","transferência":"transferencia","transferencia":"transferencia" };
      const PM_LABEL = { pix:"PIX", debito:"Débito", boleto:"Boleto", dinheiro:"Dinheiro", transferencia:"Transferência" };
      const payment_method = PM_MAP[lower] || null;
      const { data: txExpense } = await sb.from("transactions").insert({
        user_id: profile.id, kind: "expense",
        category: ctx.category || "Despesa", amount: ctx.amount,
        occurred_on: appTodayYMD(), source: "whatsapp",
        description: normalizeDescriptionForKind("expense", ctx.category || "Despesa", null),
        payment_method,
      }).select("id").single();
      await saveSession("waiting_expense_post_action", {
        transaction_id: txExpense?.id || null,
        category: ctx.category || "Despesa",
      });
      const pmLabel = payment_method ? PM_LABEL[payment_method] : "Não informado";
      const todayDespesa = new Date();
      const dateDespesaStr = todayDespesa.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      const appUrlDespesa = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
      return res.json({ type: "user", reply:
        `✅ *Despesa registrada com sucesso!* ❤️\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Descrição:* ${ctx.category}\n` +
        `💸 *Valor:* ${brl(ctx.amount)}\n` +
        `🏷️ *Categoria:* ${ctx.category}\n` +
        `💳 *Pagamento:* ${pmLabel}\n` +
        `📅 *Data:* ${dateDespesaStr}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 Para ver relatórios detalhados, acesse:\n${appUrlDespesa}/insights/\n\n` +
        `Se quiser corrigir agora:\n` +
        `1️⃣ Alterar valor\n` +
        `2️⃣ Alterar local/descrição\n` +
        `3️⃣ Excluir despesa\n` +
        `4️⃣ Manter como está`
      });
    }

    // ── Estado: pós-confirmação da despesa (editar/excluir)
    if (state === "waiting_expense_post_action") {
      if (["1", "alterar valor", "valor", "editar valor"].includes(lower)) {
        await saveSession("waiting_expense_edit_amount", ctx);
        return res.json({ type: "user", reply: "Perfeito. Informe o *novo valor* da despesa (ex: *120* ou *89,90*):" });
      }
      if (["2", "alterar local", "local", "alterar descrição", "descricao", "descrição", "editar local", "editar descrição", "editar descricao"].includes(lower)) {
        await saveSession("waiting_expense_edit_description", ctx);
        return res.json({ type: "user", reply: "Certo. Informe o novo *local/descrição* (ex: *Mercado Central*):" });
      }
      if (["3", "excluir", "apagar", "deletar", "remover"].includes(lower)) {
        if (ctx.transaction_id) {
          await sb.from("transactions").delete().eq("id", ctx.transaction_id).eq("user_id", profile.id).eq("kind", "expense");
        }
        await clearSession();
        return res.json({ type: "user", reply: "🗑️ Despesa excluída com sucesso." });
      }
      if (["4", "ok", "manter", "manter como está", "manter como esta", "nao", "não"].includes(lower)) {
        await clearSession();
        return res.json({ type: "user", reply: "Perfeito! Mantive a despesa como está. ✅" });
      }
      return res.json({ type: "user", reply:
        `Escolha uma opção para essa despesa:\n\n` +
        `1️⃣ Alterar valor\n` +
        `2️⃣ Alterar local/descrição\n` +
        `3️⃣ Excluir despesa\n` +
        `4️⃣ Manter como está`
      });
    }

    if (state === "waiting_expense_edit_amount") {
      const newAmount = parseAmountInput(lower);
      if (!newAmount || newAmount <= 0) {
        return res.json({ type: "user", reply: "Valor inválido. Digite o novo valor (ex: *120* ou *89,90*)." });
      }
      if (ctx.transaction_id) {
        await sb.from("transactions")
          .update({ amount: newAmount })
          .eq("id", ctx.transaction_id)
          .eq("user_id", profile.id)
          .eq("kind", "expense");
      }
      await clearSession();
      return res.json({ type: "user", reply: `✅ Valor atualizado para *${brl(newAmount)}*.` });
    }

    if (state === "waiting_expense_edit_description") {
      const description = String(text || "").trim().slice(0, 500);
      if (!description) {
        return res.json({ type: "user", reply: "Descrição inválida. Digite o novo local/descrição da despesa." });
      }
      if (ctx.transaction_id) {
        await sb.from("transactions")
          .update({ description })
          .eq("id", ctx.transaction_id)
          .eq("user_id", profile.id)
          .eq("kind", "expense");
      }
      await clearSession();
      return res.json({ type: "user", reply: `✅ Local/descrição atualizado para: *${description}*.` });
    }

    // ── Estado: aguardando seleção de cartão
    if (state === "waiting_cartao_card") {
      const { data: userCards } = await sb.from("credit_cards").select("id,name").eq("user_id", profile.id).order("created_at");
      const cardList = userCards || [];
      const num = parseInt(lower, 10);
      let card = num > 0 ? cardList[num - 1] : cardList.find(c => c.name.toLowerCase().includes(lower));
      if (!card) {
        const list = cardList.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        return res.json({ type: "user", reply: `Cartão não encontrado. Escolha:\n\n${list}` });
      }
      await saveSession("waiting_cartao_category", { card_id: card.id, card_name: card.name });
      const { data: cats } = await sb.from("user_categories").select("name").eq("user_id", profile.id).in("kind", ["expense","both"]).order("sort_order").limit(10);
      const catList = (cats || []).map((c, i) => `${i + 1}. ${c.name}`).join("\n") || "1. Alimentação\n2. Lazer\n3. Outros";
      return res.json({ type: "user", reply: `💳 Cartão: *${card.name}*\n\nCategoria da compra:\n\n${catList}\n\n_Ou digite o nome da categoria._` });
    }

    // ── Estado: aguardando categoria do cartão
    if (state === "waiting_cartao_category") {
      const { data: cats } = await sb.from("user_categories").select("name").eq("user_id", profile.id).in("kind", ["expense","both"]).order("sort_order");
      const catList = (cats || []).map(c => c.name);
      const num = parseInt(lower, 10);
      let category = lower.charAt(0).toUpperCase() + lower.slice(1);
      if (num > 0 && catList[num - 1]) category = catList[num - 1];
      else if (catList.find(c => c.toLowerCase() === lower)) category = catList.find(c => c.toLowerCase() === lower);
      await saveSession("waiting_cartao_amount", { ...ctx, category });
      return res.json({ type: "user", reply: `💳 Categoria: *${category}*\n\nInforme o valor total da compra (ex: *150* ou *1200,90*):` });
    }

    // ── Estado: aguardando valor do cartão
    if (state === "waiting_cartao_amount") {
      const amount = parseFloat(lower.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!amount || amount <= 0) {
        return res.json({ type: "user", reply: "Valor inválido. Informe o valor (ex: *150* ou *1200,90*):" });
      }
      await saveSession("waiting_cartao_installments", { ...ctx, amount });
      return res.json({ type: "user", reply: `💳 Valor: *${brl(amount)}*\n\nEm quantas parcelas? (ex: *1* para à vista, *3* para 3x)\n\n_Digite apenas o número._` });
    }

    // ── Estado: aguardando parcelas do cartão
    if (state === "waiting_cartao_installments") {
      const installments = Math.max(1, Math.min(60, parseInt(lower.replace(/\D/g, ""), 10) || 1));
      const ccRows = buildCreditCardInstallmentRows({
        userId: profile.id,
        cardId: ctx.card_id,
        description: ctx.category,
        category: ctx.category,
        totalAmount: ctx.amount,
        installments,
        purchaseDateStr: appTodayYMD(),
      });
      await sb.from("credit_card_transactions").insert(ccRows);
      await clearSession();
      const instLabel = installments > 1 ? `${installments}x de ${brl(ccRows[0].amount)}` : "À vista";
      const appUrlCartao = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
      const todayCartao = new Date();
      const dateCartaoStr = todayCartao.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      return res.json({ type: "user", reply:
        `✅ *Lançamento no cartão realizado!* 💳\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `🃏 *Cartão:* ${ctx.card_name}\n` +
        `📌 *Categoria:* ${ctx.category}\n` +
        `💸 *Valor total:* ${brl(ctx.amount)}\n` +
        `🔢 *Parcelamento:* ${instLabel}\n` +
        `📅 *Data da compra:* ${dateCartaoStr}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 Para ver a fatura completa, acesse:\n${appUrlCartao}/insights/\n\n` +
        `_Se precisar de algo mais, é só chamar! 🎉_`
      });
    }

    // ── Estado: aguardando banco do investimento
    if (state === "waiting_invest_broker") {
      await clearSession();
      return res.json({
        type: "list",
        listData: WHATSAPP_MENU_LIST(profile.full_name),
        reply: "📌 A opção de investimento foi removida nesta versão.\n\nUse o menu para continuar.",
      });
    }

    // ── Estado: aguardando valor do investimento
    if (state === "waiting_invest_amount") {
      await clearSession();
      return res.json({
        type: "list",
        listData: WHATSAPP_MENU_LIST(profile.full_name),
        reply: "📌 A opção de investimento foi removida nesta versão.\n\nUse o menu para continuar.",
      });
    }

    // ── Estado: aguardando pergunta (dúvidas)
    if (state === "waiting_question") {
      await clearSession();
      // Envia para o agente IA com contexto financeiro
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.json({ type: "user", reply: "Desculpe, o assistente de dúvidas está temporariamente indisponível. Tente mais tarde!" });
      }
      const qaPrompt = `Você é o assistente do FinanceZap, sistema de controle financeiro. Responda de forma curta e direta (máximo 3 linhas), estilo WhatsApp. Nunca diga que é uma IA.`;
      const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: qaPrompt }] },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.5 },
        }),
      });
      const gemData = await gemRes.json();
      const reply = gemData.candidates?.[0]?.content?.parts?.[0]?.text || "Não consegui responder agora. Tente novamente!";
      return res.json({ type: "user", reply });
    }

    // ── Sem estado: detecta intenção por palavras-chave
    const isGreeting = /^(oi|olá|ola|ei|hey|bom dia|boa tarde|boa noite|hello|hi|menu|ajuda|help|inicio|início|start)$/i.test(lower);
    const isOption1 = /^(1|extrato|relatorio|relatório|histórico|historico)/.test(lower);
    const isOption2 = /^(2|receita|entrada|recebi|ganhei|salario|salário)/.test(lower);
    const isOption3 = /^(3|despesa|gasto|saida|saída|paguei|gastei|comprei)/.test(lower);
    const isOption4 = /^(4|cartao|cartão|credito|crédito|fatura|visa|master)/.test(lower);
    const isOption5 = /^(5|saldo|saldo atual|contas|conta|balance)/.test(lower);
    const isOption6 = /^(6|duvida|dúvida|ajuda|pergunta|como|o que|como funciona|\?)/.test(lower);

    if (isGreeting) {
      return res.json({ type: "list", listData: WHATSAPP_MENU_LIST(profile.full_name), reply: WHATSAPP_MENU(profile.full_name) });
    }

    // Atalho mais rápido: texto livre de transação registra direto sem perguntar mais nada
    if (!isGreeting) {
      const quick = parseQuickTransactionFromText(text);
      if (quick && quick.amount > 0) {
        const { kind, amount, category } = quick;
        const { data: quickTx } = await sb.from("transactions").insert({
          user_id: profile.id, kind, category, amount,
          occurred_on: appTodayYMD(), source: "whatsapp",
          description: normalizeDescriptionForKind(kind, category, text),
        }).select("id").single();
        const emoji = kind === "income" ? "💚" : "❤️";
        const tipo = kind === "income" ? "Receita" : "Despesa";
        const appUrlQuick = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
        const todayQuick = new Date();
        const dateQuickStr = todayQuick.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
        if (kind === "expense" && quickTx?.id) {
          await saveSession("waiting_expense_post_action", {
            transaction_id: quickTx.id,
            category,
          });
        }
        return res.json({ type: "user", reply:
          `✅ *${tipo} registrada automaticamente!* ${emoji}\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `📌 *Descrição:* ${category}\n` +
          `💰 *Valor:* ${brl(amount)}\n` +
          `🏷️ *Categoria:* ${category}\n` +
          `📅 *Data:* ${dateQuickStr}\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `📊 Acesse seu dashboard:\n${appUrlQuick}/insights/\n\n` +
          (kind === "expense"
            ? `Quer corrigir algo agora?\n` +
              `1️⃣ Alterar valor\n` +
              `2️⃣ Alterar local/descrição\n` +
              `3️⃣ Excluir despesa\n` +
              `4️⃣ Manter como está`
            : `_Digite *menu* para ver todas as opções._`)
        });
      }
    }

    if (isOption1) {
      await saveSession("waiting_extrato_days", {});
      return res.json({ type: "user", reply: "📊 *Extrato por período*\n\nQuantos dias você quer ver? (ex: *7*, *30*, *90*)" });
    }

    if (isOption2) {
      const { data: cats } = await sb.from("user_categories").select("name").eq("user_id", profile.id).in("kind", ["income","both"]).order("sort_order").limit(10);
      const list = (cats || []).map((c, i) => `${i + 1}. ${c.name}`).join("\n") || "1. Salário\n2. Freelance\n3. Outros";
      await saveSession("waiting_receita_category", {});
      return res.json({ type: "user", reply: `💚 *Lançar receita*\n\nEscolha a categoria:\n\n${list}\n\n_Ou digite o nome da categoria._` });
    }

    if (isOption3) {
      const { data: cats } = await sb.from("user_categories").select("name").eq("user_id", profile.id).in("kind", ["expense","both"]).order("sort_order").limit(10);
      const list = (cats || []).map((c, i) => `${i + 1}. ${c.name}`).join("\n") || "1. Alimentação\n2. Transporte\n3. Moradia\n4. Saúde\n5. Outros";
      await saveSession("waiting_despesa_category", {});
      return res.json({ type: "user", reply: `❤️ *Lançar despesa*\n\nEscolha a categoria:\n\n${list}\n\n_Ou digite o nome da categoria._` });
    }

    if (isOption4) {
      const { data: userCards } = await sb.from("credit_cards").select("id,name").eq("user_id", profile.id).order("created_at");
      const cardList = userCards || [];
      if (!cardList.length) {
        return res.json({ type: "user", reply: "Você ainda não tem cartões cadastrados. Acesse o dashboard em *Cartões* para adicionar! 💡" });
      }
      const list = cardList.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
      await saveSession("waiting_cartao_card", {});
      return res.json({ type: "user", reply: `💳 *Lançar no cartão de crédito*\n\nEscolha o cartão:\n\n${list}\n\n_Digite o número ou nome do cartão._` });
    }

    if (isOption5) {
      const asOf = accumulatedThroughYMD();
      const totals = await sumAccumulatedThroughDate(sb, asOf, profile.id);
      return res.json({
        type: "user",
        reply:
          `💰 *Saldo atual da conta única:*\n\n` +
          `🏆 *${brl(totals.balanceTotalAllTime)}*\n\n` +
          `📥 Receitas acumuladas: *${brl(totals.incomeTotalAllTime)}*\n` +
          `📤 Despesas acumuladas: *${brl(totals.expenseTotalAllTime)}*\n` +
          `📅 Atualizado até: *${asOf.split("-").reverse().join("/")}*`,
      });
    }

    if (isOption6) {
      await saveSession("waiting_question", {});
      return res.json({ type: "user", reply: "🤔 Qual é a sua dúvida? Pode perguntar!" });
    }

    // Sem intenção detectada → envia menu interativo
    return res.json({ type: "list", listData: WHATSAPP_MENU_LIST(profile.full_name), reply: WHATSAPP_MENU(profile.full_name) });
  })
);

// ─── Webhook: transação via ÁUDIO (Gemini transcreve + extrai) ───────────────
api.post(
  "/webhook/whatsapp-audio",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    const pushName = req.body?.pushName || "você";
    const audioBase64Raw = req.body?.audioBase64 || null;
    const mimeType = req.body?.mimeType || "audio/ogg; codecs=opus";

    const audioBase64 =
      typeof audioBase64Raw === "string"
        ? audioBase64Raw.trim().replace(/^data:[^;]+;base64,/, "")
        : null;

    if (!rawPhone) {
      return res.status(400).json({ error: "phone é obrigatório" });
    }
    if (!audioBase64) {
      return res.json({ type: "user", reply: "🎤 Recebi seu áudio, mas não consegui fazer o download. Tente enviar novamente!" });
    }

    const sb = getSupabase();

    // Busca usuário
    const phoneVariants = [rawPhone];
    if (rawPhone.startsWith("55") && rawPhone.length > 10) phoneVariants.push(rawPhone.slice(2));
    else phoneVariants.push("55" + rawPhone);

    const { data: profiles } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .in("whatsapp_phone", phoneVariants)
      .limit(1);
    const profile = profiles?.[0] || null;

    if (!profile || !profile.has_access) {
      return res.json({ type: "user", reply: "Acesso não liberado. Entre em contato para ativar sua conta! 😊" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ type: "user", reply: "Serviço de reconhecimento de voz temporariamente indisponível. Tente digitar sua transação." });

    const firstName = (profile.full_name || pushName).split(" ")[0];
    const brl = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

    // Usa Gemini para transcrever e extrair dados da transação
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType.split(";")[0].trim(), data: audioBase64 } },
              { text: `Você é um assistente financeiro. Transcreva o áudio e extraia informações de transação financeira.
Se a pessoa mencionou um gasto, despesa, compra ou pagamento → kind = "expense".
Se mencionou salário, receita, ganho ou entrada → kind = "income".
Extraia o valor numérico e a categoria/descrição do que foi gasto ou recebido.

Responda APENAS com um JSON válido neste formato exato:
{
  "transcript": "texto transcrito aqui",
  "transaction": {
    "kind": "expense",
    "amount": 50.00,
    "category": "Mercado"
  }
}

Se não conseguir identificar uma transação financeira no áudio, responda:
{"transcript": "...", "transaction": null}` }
            ],
          }],
          generationConfig: {
            maxOutputTokens: 400,
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const gemData = await gemRes.json();
    if (!gemRes.ok) {
      const errMsg = gemData?.error?.message || "falha na transcrição";
      return res.json({
        type: "user",
        reply: `🎤 Recebi seu áudio, mas houve falha ao transcrever agora (${errMsg}). Tente novamente em alguns segundos.`,
      });
    }
    const rawText = gemData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let parsed = null;
    try {
      const clean = String(rawText || "").replace(/```json|```/gi, "").trim();
      try {
        parsed = JSON.parse(clean);
      } catch (_) {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start >= 0 && end > start) {
          parsed = JSON.parse(clean.slice(start, end + 1));
        }
      }
    } catch (_) { /* ignora erro de parse */ }

    const transcript = String(parsed?.transcript || "").trim();
    const fallbackTx =
      parseQuickTransactionFromText(transcript) ||
      parseQuickTransactionFromText(rawText);
    const tx = parsed?.transaction || fallbackTx || null;

    if (!tx) {
      const transcriptSafe = transcript || "Áudio recebido";
      return res.json({ type: "user", reply:
        `🎤 *Áudio recebido!*\n\n📝 _"${transcriptSafe}"_\n\n` +
        `Hmm, não consegui identificar uma transação nesse áudio. 🤔\n\n` +
        `Tente falar algo como:\n` +
        `_"Gastei cinquenta reais no mercado"_ ou\n` +
        `_"Recebi mil e quinhentos de salário"_\n\n` +
        `Ou escolha uma opção no *menu*.`
      });
    }

    const { kind, amount, category } = tx;
    const validAmount = parseFloat(amount);
    if (!validAmount || validAmount <= 0) {
      return res.json({ type: "user", reply: `🎤 Áudio recebido! Mas não consegui identificar o valor. Tente novamente ou use o *menu*.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const dateStr = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";

    if (kind === "income") {
      await sb.from("transactions").insert({
        user_id: profile.id, kind: "income", category: category || "Receita",
        amount: validAmount, occurred_on: today, source: "whatsapp",
        description: transcript || category,
      });
      return res.json({ type: "user", reply:
        `🎤 *Áudio processado com sucesso!*\n\n` +
        `✅ *Receita registrada!* 💚\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Descrição:* ${category || "Receita"}\n` +
        `💰 *Valor:* ${brl(validAmount)}\n` +
        `🏷️ *Categoria:* ${category || "Receita"}\n` +
        `📅 *Data:* ${dateStr}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 ${appUrl}/insights/\n\n` +
        `_Se precisar de algo mais, é só chamar! 🎉_`
      });
    } else {
      await sb.from("transactions").insert({
        user_id: profile.id, kind: "expense", category: category || "Despesa",
        amount: validAmount, occurred_on: today, source: "whatsapp",
        description: normalizeDescriptionForKind("expense", category || "Despesa", transcript || null),
      });
      return res.json({ type: "user", reply:
        `🎤 *Áudio processado com sucesso!*\n\n` +
        `✅ *Despesa registrada!* ❤️\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Descrição:* ${category || "Despesa"}\n` +
        `💸 *Valor:* ${brl(validAmount)}\n` +
        `🏷️ *Categoria:* ${category || "Despesa"}\n` +
        `📅 *Data:* ${dateStr}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 ${appUrl}/insights/\n\n` +
        `_Se precisar de algo mais, é só chamar! 🎉_`
      });
    }
  })
);

// ─── Webhook: transação via IMAGEM/comprovante (Gemini Vision) ────────────────
api.post(
  "/webhook/whatsapp-image",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    const pushName = req.body?.pushName || "você";
    const imageBase64 = req.body?.imageBase64 || null;
    const mimeType = req.body?.mimeType || "image/jpeg";
    const caption = req.body?.caption || "";

    if (!rawPhone) {
      return res.status(400).json({ error: "phone é obrigatório" });
    }
    if (!imageBase64) {
      return res.json({ type: "user", reply: "📸 Recebi sua imagem, mas não consegui fazer o download. Tente enviar novamente!" });
    }

    const sb = getSupabase();

    const phoneVariants = [rawPhone];
    if (rawPhone.startsWith("55") && rawPhone.length > 10) phoneVariants.push(rawPhone.slice(2));
    else phoneVariants.push("55" + rawPhone);

    const { data: profiles } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .in("whatsapp_phone", phoneVariants)
      .limit(1);
    const profile = profiles?.[0] || null;

    if (!profile || !profile.has_access) {
      return res.json({ type: "user", reply: "Acesso não liberado. Entre em contato para ativar sua conta! 😊" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ type: "user", reply: "Serviço de análise de imagem temporariamente indisponível. Tente digitar sua transação." });

    const brl = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

    const captionHint = caption ? `\nO usuário também enviou a legenda: "${caption}"` : "";

    // Usa Gemini Vision para analisar comprovante
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType.split(";")[0].trim(), data: imageBase64 } },
              { text: `Você é um assistente financeiro. Analise esta imagem.${captionHint}

Se for um comprovante de pagamento, recibo, nota fiscal, extrato ou qualquer documento financeiro:
- Extraia o valor total pago
- Identifique o estabelecimento/descrição
- Classifique como despesa (pagamento) ou receita (recebimento)
- Sugira uma categoria (ex: Mercado, Restaurante, Combustível, Saúde, Serviços, etc.)

Responda APENAS com JSON válido:
{
  "isFinancial": true,
  "kind": "expense",
  "amount": 150.00,
  "category": "Mercado",
  "description": "Compra no Supermercado X",
  "date": "2024-01-15"
}

Se NÃO for um documento financeiro, responda:
{"isFinancial": false, "reason": "explicação"}`}
            ],
          }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
        }),
      }
    );

    const gemData = await gemRes.json();
    const rawText = gemData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let parsed = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (_) { /* ignora erro de parse */ }

    if (!parsed?.isFinancial) {
      return res.json({ type: "user", reply:
        `📸 *Imagem recebida!*\n\n` +
        `Hmm, não identifiquei um comprovante financeiro nessa imagem. 🤔\n\n` +
        `Você pode enviar:\n` +
        `📄 Comprovante de PIX\n` +
        `🧾 Nota fiscal ou recibo\n` +
        `📱 Print de pagamento\n` +
        `💳 Extrato bancário\n\n` +
        `Ou use o *menu* para lançar manualmente!`
      });
    }

    const validAmount = parseFloat(parsed.amount);
    if (!validAmount || validAmount <= 0) {
      return res.json({ type: "user", reply: `📸 Comprovante recebido, mas não consegui identificar o valor claramente. Tente uma foto mais nítida ou use o *menu* para lançar manualmente.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const occurredOn = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : today;
    const dateStr = new Date(occurredOn + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
    const kind = parsed.kind === "income" ? "income" : "expense";
    const kindEmoji = kind === "income" ? "💚" : "❤️";
    const kindLabel = kind === "income" ? "Receita" : "Despesa";
    const valorLabel = kind === "income" ? "💰" : "💸";

    await sb.from("transactions").insert({
      user_id: profile.id,
      kind,
      category: parsed.category || (kind === "income" ? "Receita" : "Despesa"),
      amount: validAmount,
      occurred_on: occurredOn,
      source: "whatsapp",
      description: parsed.description || parsed.category || "Via comprovante",
    });

    return res.json({ type: "user", reply:
      `📸 *Comprovante processado com sucesso!* ${kindEmoji}\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `📌 *Descrição:* ${parsed.description || parsed.category}\n` +
      `${valorLabel} *Valor:* ${brl(validAmount)}\n` +
      `🏷️ *Categoria:* ${parsed.category}\n` +
      `📅 *Data:* ${dateStr}\n` +
      `✔️ *Tipo:* ${kindLabel}\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 Para visualizar mais detalhes e relatórios:\n${appUrl}/insights/\n\n` +
      `_Se precisar de algo mais, é só chamar! 🎉_`
    });
  })
);

// ─── Categorias do usuário ─────────────────────────────────────────────────

api.get(
  "/categories/user",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const kind = req.query.kind;
    let q = sb
      .from("user_categories")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (kind === "income" || kind === "expense") q = q.in("kind", [kind, "both"]);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/categories/user",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, kind, sort_order } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name obrigatório" });
    }
    const validKind = ["income", "expense", "both"].includes(kind) ? kind : "both";
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_categories")
      .insert({
        user_id: req.userId,
        name: name.trim().slice(0, 120),
        kind: validKind,
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.patch(
  "/categories/user/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, kind, sort_order } = req.body || {};
    const patch = {};
    if (name != null) patch.name = String(name).trim().slice(0, 120);
    if (["income","expense","both"].includes(kind)) patch.kind = kind;
    if (sort_order != null && Number.isFinite(Number(sort_order))) patch.sort_order = Number(sort_order);
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Nenhum campo válido" });
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_categories")
      .update(patch)
      .eq("id", req.params.id)
      .eq("user_id", req.userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json(data);
  })
);

api.delete(
  "/categories/user/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { error } = await sb
      .from("user_categories")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.userId);
    if (error) throw error;
    res.status(204).end();
  })
);

// ─── Contas bancárias ──────────────────────────────────────────────────────

api.get(
  "/bank-accounts",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("bank_accounts")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/bank-accounts",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, bank_name, account_type, balance, color, sort_order } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name obrigatório" });
    }
    const validTypes = ["corrente","poupança","cartão","investimento","digital","outro"];
    const sb = getSupabase();
    const { data, error } = await sb
      .from("bank_accounts")
      .insert({
        user_id: req.userId,
        name: name.trim().slice(0, 120),
        bank_name: bank_name ? String(bank_name).trim().slice(0, 120) : null,
        account_type: validTypes.includes(account_type) ? account_type : "corrente",
        balance: Number.isFinite(Number(balance)) ? Number(balance) : 0,
        color: color ? String(color).slice(0, 20) : "#10B981",
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.patch(
  "/bank-accounts/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, bank_name, account_type, balance, color, sort_order } = req.body || {};
    const validTypes = ["corrente","poupança","cartão","investimento","digital","outro"];
    const patch = { updated_at: new Date().toISOString() };
    if (name != null) patch.name = String(name).trim().slice(0, 120);
    if (bank_name !== undefined) patch.bank_name = bank_name ? String(bank_name).trim().slice(0, 120) : null;
    if (validTypes.includes(account_type)) patch.account_type = account_type;
    if (balance != null && Number.isFinite(Number(balance))) patch.balance = Number(balance);
    if (color != null) patch.color = String(color).slice(0, 20);
    if (sort_order != null && Number.isFinite(Number(sort_order))) patch.sort_order = Number(sort_order);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("bank_accounts")
      .update(patch)
      .eq("id", req.params.id)
      .eq("user_id", req.userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json(data);
  })
);

api.delete(
  "/bank-accounts/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { error } = await sb
      .from("bank_accounts")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.userId);
    if (error) throw error;
    res.status(204).end();
  })
);

// ─── Cartões de crédito ────────────────────────────────────────────────────

api.get(
  "/credit-cards",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("credit_cards")
      .select("*")
      .eq("user_id", req.userId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

function normalizeDay(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1 || n > 31) return null;
  return n;
}

async function loadUserCreditCardsWithRows(sb, userId, startMonthKey, monthsAhead) {
  const { data: cards, error: cardErr } = await sb
    .from("credit_cards")
    .select("*")
    .eq("user_id", userId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (cardErr) throw cardErr;

  const list = cards || [];
  if (!list.length) return { cards: [], rows: [] };

  const startMonth = monthKeyFromDate(`${startMonthKey}-01`);
  const endMonth = shiftMonthKey(startMonth, Math.max(1, Number(monthsAhead || 1)));
  const startDate = `${startMonth}-01`;
  const endDate = `${endMonth}-01`;

  const { data: rows, error: txErr } = await sb
    .from("credit_card_transactions")
    .select("*")
    .eq("user_id", userId)
    .gte("purchase_date", startDate)
    .lt("purchase_date", endDate)
    .order("purchase_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (txErr) throw txErr;

  return { cards: list, rows: rows || [] };
}

function buildCreditCardOverview(cards, rows, startMonthKey, monthsAhead) {
  const monthCount = Math.max(1, Math.min(12, parseInt(String(monthsAhead || 6), 10) || 6));
  const monthKeys = Array.from({ length: monthCount }, (_, i) => shiftMonthKey(startMonthKey, i));
  const monthMap = new Map(
    monthKeys.map((key) => [
      key,
      {
        monthKey: key,
        total: 0,
        cards: {},
      },
    ])
  );

  for (const row of rows || []) {
    const key = monthKeyFromDate(row.purchase_date);
    const bucket = monthMap.get(key);
    if (!bucket) continue;
    const amount = Number(row.amount) || 0;
    bucket.total += amount;
    bucket.cards[row.card_id] = (bucket.cards[row.card_id] || 0) + amount;
  }

  const months = monthKeys.map((key) => {
    const bucket = monthMap.get(key);
    return {
      monthKey: key,
      total: bucket.total,
      cards: cards.map((card) => ({
        card_id: card.id,
        name: card.name,
        total: bucket.cards[card.id] || 0,
      })),
    };
  });

  const grouped = groupInstallmentRows(rows || []);
  const cardsSummary = cards.map((card) => {
    const cardRows = (rows || []).filter((row) => row.card_id === card.id);
    const currentMonthTotal = cardRows
      .filter((row) => monthKeyFromDate(row.purchase_date) === startMonthKey)
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const nextMonthTotal = cardRows
      .filter((row) => monthKeyFromDate(row.purchase_date) === shiftMonthKey(startMonthKey, 1))
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const openPurchases = grouped.filter(
      (group) => group.card_id === card.id && group.rows.some((row) => monthKeyFromDate(row.purchase_date) >= startMonthKey)
    ).length;
    const plannedTotal = cardRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

    return {
      ...card,
      currentMonthTotal,
      nextMonthTotal,
      openPurchases,
      plannedTotal,
    };
  });

  return { cards: cardsSummary, months };
}

api.get(
  "/credit-cards/overview",
  authRequired,
  asyncHandler(async (req, res) => {
    const months = Math.max(1, Math.min(12, parseInt(String(req.query.months || 6), 10) || 6));
    const startMonthKey = monthKeyFromParts(
      req.query.year || new Date().getFullYear(),
      req.query.month || new Date().getMonth() + 1
    ) || monthKeyFromDate(new Date().toISOString().slice(0, 10));
    const sb = getSupabase();
    const loaded = await loadUserCreditCardsWithRows(sb, req.userId, startMonthKey, months);
    res.json(buildCreditCardOverview(loaded.cards, loaded.rows, startMonthKey, months));
  })
);

api.post(
  "/credit-cards",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, due_day, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });
    const sb = getSupabase();
    const { data, error } = await sb.from("credit_cards").insert({
      user_id: req.userId,
      name: String(name).trim().slice(0, 120),
      bank_name: null,
      last_four: null,
      credit_limit: 0,
      closing_day: null,
      due_day: normalizeDay(due_day),
      color: color ? String(color).slice(0, 20) : "#10B981",
      sort_order: 0,
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.patch(
  "/credit-cards/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, due_day, color } = req.body || {};
    const patch = {};
    if (name != null) patch.name = String(name).trim().slice(0, 120);
    if (due_day !== undefined) patch.due_day = normalizeDay(due_day);
    if (color != null) patch.color = String(color).slice(0, 20);
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: "Nenhum campo válido enviado" });
    }
    const sb = getSupabase();
    const { data, error } = await sb.from("credit_cards").update(patch).eq("id", req.params.id).eq("user_id", req.userId).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Não encontrado" });
    res.json(data);
  })
);

api.delete(
  "/credit-cards/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    await sb.from("credit_card_transactions").delete().eq("card_id", req.params.id).eq("user_id", req.userId);
    const { error } = await sb.from("credit_cards").delete().eq("id", req.params.id).eq("user_id", req.userId);
    if (error) throw error;
    res.status(204).end();
  })
);

api.get(
  "/credit-card-transactions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { card_id, year, month } = req.query;
    const sb = getSupabase();
    let q = sb.from("credit_card_transactions").select("*, credit_cards(name,color,bank_name)")
      .eq("user_id", req.userId)
      .order("purchase_date", { ascending: false });
    if (card_id) q = q.eq("card_id", card_id);
    if (year && month) {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const nextM = m === 12 ? 1 : m + 1;
      const nextY = m === 12 ? y + 1 : y;
      const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
      q = q.gte("purchase_date", start).lt("purchase_date", end);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  })
);

api.post(
  "/credit-card-transactions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { card_id, description, category, amount, installments, purchase_date } = req.body || {};
    if (!card_id) return res.status(400).json({ error: "card_id obrigatório" });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "amount inválido" });
    const installs = Math.max(1, Math.min(60, parseInt(String(installments || 1), 10) || 1));
    const sb = getSupabase();
    // Valida que o cartão pertence ao usuário
    const { data: card } = await sb.from("credit_cards").select("id").eq("id", card_id).eq("user_id", req.userId).single();
    if (!card) return res.status(404).json({ error: "Cartão não encontrado" });

    const dateStr = purchase_date || new Date().toISOString().slice(0, 10);
    const rows = buildCreditCardInstallmentRows({
      userId: req.userId,
      cardId: card_id,
      description,
      category,
      totalAmount: amt,
      installments: installs,
      purchaseDateStr: dateStr,
    });
    const { data, error } = await sb.from("credit_card_transactions").insert(rows).select();
    if (error) throw error;
    res.status(201).json(data);
  })
);

api.delete(
  "/credit-card-transactions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const sb = getSupabase();
    const { data: row, error: fetchErr } = await sb
      .from("credit_card_transactions")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.userId)
      .single();
    if (fetchErr) throw fetchErr;
    if (!row) return res.status(404).json({ error: "Lançamento não encontrado" });

    let del = sb
      .from("credit_card_transactions")
      .delete()
      .eq("user_id", req.userId)
      .eq("card_id", row.card_id)
      .eq("created_at", row.created_at)
      .eq("category", row.category)
      .eq("installments", row.installments);
    if (row.description == null) del = del.is("description", null);
    else del = del.eq("description", row.description);
    const { error } = await del;
    if (error) throw error;
    res.status(204).end();
  })
);

api.get(
  "/credit-cards/:id/statement",
  authRequired,
  asyncHandler(async (req, res) => {
    const y = parseInt(String(req.query.year  || new Date().getFullYear()), 10);
    const m = parseInt(String(req.query.month || new Date().getMonth() + 1), 10);
    const sb = getSupabase();
    const { data: card } = await sb.from("credit_cards").select("*").eq("id", req.params.id).eq("user_id", req.userId).single();
    if (!card) return res.status(404).json({ error: "Cartão não encontrado" });

    const { data: txs, error } = await sb.from("credit_card_transactions")
      .select("*").eq("card_id", card.id).eq("user_id", req.userId)
      .order("purchase_date", { ascending: false });
    if (error) throw error;
    const monthKey = monthKeyFromParts(y, m);
    const groups = groupInstallmentRows(txs || []);
    const entries = groups
      .map((group) => {
        const currentRow = group.rows.find((row) => monthKeyFromDate(row.purchase_date) === monthKey);
        if (!currentRow) return null;
        return {
          id: currentRow.id,
          description: group.description || group.category,
          category: group.category,
          installmentAmount: Number(currentRow.amount) || 0,
          currentInstallment: Number(currentRow.current_installment) || 1,
          installments: group.installments,
          totalAmount: group.total_amount,
          purchaseDate: group.first_purchase_date,
          referenceDate: currentRow.purchase_date,
          remainingInstallments: Math.max(0, group.installments - (Number(currentRow.current_installment) || 1)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.referenceDate || "").localeCompare(String(a.referenceDate || "")));

    const total = entries.reduce((sum, entry) => sum + entry.installmentAmount, 0);
    res.json({ card, year: y, month: m, entries, total });
  })
);

// ─── Agente IA de Vendas (WhatsApp) ───────────────────────────────────────

const SALES_SYSTEM_PROMPT = `Você é o assistente de vendas do FinanceZap, um sistema de controle financeiro pessoal via WhatsApp.

PERSONALIDADE:
- Você é simpático, direto, entusiasmado mas nunca forçado
- Fala de forma natural, como um amigo que entende de finanças
- Usa emojis com moderação (1-2 por mensagem, nunca exagera)
- Respostas CURTAS (máximo 3-4 linhas), estilo WhatsApp
- Nunca use linguagem corporativa ou robótica
- Trate pelo nome quando disponível

PRODUTO — FinanceZap:
- Controle financeiro pessoal completo
- Registra gastos e receitas PELO WHATSAPP (ex: "saída 50 almoço")
- Dashboard completo com gráficos no navegador
- Lei dos Potes automática (divide renda em categorias)
- Múltiplas contas bancárias (Nubank, Itaú, etc.)
- Categorias personalizadas
- Controle de contas a pagar mensais
- Investimentos

PREÇO:
- R$ 27,90 — pagamento ÚNICO, acesso VITALÍCIO
- Sem mensalidade, sem taxa escondida
- Pague uma vez, use para sempre

COMO COMPRAR:
- Acesse o link de compra: https://financezap.thesilasstudio.com.br/checkout
- No link o cliente faz o pagamento e já cadastra seus dados (nome, email, WhatsApp)
- Após a confirmação do pagamento, o link de ativação chega no WhatsApp e no e-mail em minutos

REGRAS:
- Se o cliente perguntar sobre funcionalidades, explique de forma prática com exemplos
- Se perguntar o preço, SEMPRE diga R$ 27,90 pagamento único e vitalício
- Se mostrar interesse, envie o link: https://financezap.thesilasstudio.com.br/checkout
- SEMPRE que o cliente quiser comprar, envie o link do checkout — nunca passe chave PIX
- Se tiver objeção (caro, não sei se preciso), contorne com benefícios reais
- Se perguntar algo fora do escopo (outros produtos, suporte técnico após compra), diga que pode ajudar com dúvidas sobre o FinanceZap
- NUNCA invente funcionalidades que não existem
- NUNCA diga que é uma IA — você é o assistente do FinanceZap
- Se o cliente disser que já pagou, diga para aguardar alguns minutos que o link de ativação chega`;

api.post(
  "/ai/sales-chat",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const { phone, message, pushName, history } = req.body || {};
    if (!message) return res.status(400).json({ error: "message obrigatório" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Fallback sem IA: resposta padrão de venda
      return res.json({
        reply: `Olá! ⚡ O FinanceZap custa apenas R$ 27,90 (pagamento único, acesso vitalício).\n\nFaça sua compra aqui:\n👉 https://financezap.thesilasstudio.com.br/checkout\n\nApós o pagamento, seu link de ativação chega aqui no WhatsApp e no seu e-mail!`,
        fallback: true,
      });
    }

    // Monta histórico de conversa (formato Gemini)
    const contents = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        contents.push({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: String(h.content) }],
        });
      }
    }
    contents.push({
      role: "user",
      parts: [{ text: pushName ? `[${pushName}]: ${message}` : message }],
    });

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SALES_SYSTEM_PROMPT }] },
            contents,
            generationConfig: {
              maxOutputTokens: 350,
              temperature: 0.7,
            },
          }),
        }
      );

      const data = await geminiRes.json();
      if (!geminiRes.ok) {
        console.error("Gemini API error:", data);
        return res.status(500).json({ error: "Erro no agente IA", details: data });
      }

      const reply =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Desculpe, tive um problema. Tente novamente!";
      res.json({ reply, model: "gemini-2.5-flash" });
    } catch (e) {
      console.error("AI sales chat error:", e.message);
      res.status(500).json({ error: e.message });
    }
  })
);

// ─── Webhook WhatsApp (n8n → Evolution API) ───────────────────────────────
// Identifica o usuário pelo número de celular cadastrado no perfil.

api.post(
  "/webhook/whatsapp",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const body = { ...req.body };
    delete body.secret;

    // Normaliza telefone: remove tudo que não é dígito
    const rawPhone = String(body.phone || "").replace(/\D/g, "");
    if (!rawPhone) {
      return res.status(400).json({ error: "phone obrigatório" });
    }

    const sb = getSupabase();

    // Busca usuário pelo telefone
    const { data: profile, error: pErr } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .eq("whatsapp_phone", rawPhone)
      .single();

    if (pErr || !profile) {
      return res.status(404).json({
        error: "Usuário não encontrado para esse número",
        status: "not_registered",
        phone: rawPhone,
      });
    }

    if (!profile.has_access) {
      return res.status(402).json({
        error: "Usuário sem acesso ativo",
        status: "no_access",
        phone: rawPhone,
      });
    }

    const kind = body.kind === "income" ? "income" : "expense";
    const amt = Number(body.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount obrigatório e > 0" });
    }

    const row = {
      user_id: profile.id,
      kind,
      category: typeof body.category === "string" && body.category.trim() ? body.category.trim() : "WhatsApp",
      amount: amt,
      description: normalizeDescriptionForKind(
        kind,
        typeof body.category === "string" && body.category.trim() ? body.category.trim() : "WhatsApp",
        body.description
      ),
      occurred_on: body.occurred_on || body.date || new Date().toISOString().slice(0, 10),
      source: "whatsapp",
    };

    const { data, error } = await sb.from("transactions").insert(row).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, user: profile.full_name, transaction: data });
  })
);

// Mantém compatibilidade com integrações antigas que usam /webhook/n8n
api.post("/webhook/n8n", requireWebhookSecret, asyncHandler(async (req, res) => {
  req.url = "/webhook/whatsapp";
  return res.status(410).json({ error: "Use /webhook/whatsapp com o campo phone" });
}));

// ─── Helper: template de email de ativação ────────────────────────────────

function buildActivationEmail(name, activationLink, guiaLink) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body style="margin:0;padding:0;background:#0F172A;font-family:'Segoe UI',system-ui,sans-serif;color:#F8FAFC">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
  <div style="text-align:center;margin-bottom:32px">
    <div style="font-size:2.5rem">⚡</div>
    <h1 style="font-size:1.5rem;font-weight:800;color:#fff;margin:8px 0 4px">FinanceZap</h1>
    <p style="color:#64748B;font-size:.85rem;margin:0">Controle total no WhatsApp</p>
  </div>
  <div style="background:#1E293B;border:1px solid #2D3B55;border-radius:16px;padding:32px">
    <h2 style="font-size:1.2rem;font-weight:700;color:#fff;margin:0 0 8px">🎉 Seu acesso está liberado, ${name}!</h2>
    <p style="color:#94A3B8;font-size:.9rem;line-height:1.7;margin:0 0 24px">Seu pagamento foi confirmado. Agora é só criar sua conta e começar a controlar suas finanças pelo WhatsApp.</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${activationLink}" style="display:inline-block;background:linear-gradient(135deg,#10B981,#059669);color:#fff;font-weight:700;font-size:1rem;padding:14px 32px;border-radius:12px;text-decoration:none">👉 Criar minha conta agora</a>
    </div>
    <p style="color:#64748B;font-size:.78rem;text-align:center;margin:0">Este link é pessoal e intransferível.</p>
  </div>
  <div style="background:#1E293B;border:1px solid #2D3B55;border-radius:16px;padding:24px;margin-top:16px">
    <h3 style="font-size:1rem;font-weight:700;color:#10B981;margin:0 0 16px">📖 Como usar o FinanceZap</h3>
    <div style="margin-bottom:12px"><strong style="color:#fff">1. Configure seu perfil</strong><br/><span style="color:#94A3B8;font-size:.85rem">Após criar a conta, cadastre seus bancos, categorias de receita e despesa.</span></div>
    <div style="margin-bottom:12px"><strong style="color:#fff">2. Lance pelo WhatsApp</strong><br/><span style="color:#94A3B8;font-size:.85rem">Mande mensagens como "gastei 50 no mercado" ou "recebi 3000 salário".</span></div>
    <div style="margin-bottom:12px"><strong style="color:#fff">3. Acompanhe o dashboard</strong><br/><span style="color:#94A3B8;font-size:.85rem">Veja gráficos, saldo e relatórios em tempo real no seu painel.</span></div>
    <div style="text-align:center;margin-top:20px">
      <a href="${guiaLink}" style="color:#10B981;font-size:.85rem;text-decoration:none;font-weight:600">📘 Ver guia completo de uso →</a>
    </div>
  </div>
  <p style="text-align:center;color:#475569;font-size:.75rem;margin-top:24px">Dúvidas? Responda essa mensagem ou fale pelo WhatsApp. · FinanceZap</p>
</div></body></html>`;
}

// ─── Helper: envio de email via Resend (ou SMTP genérico) ─────────────────

// ── Transporter de email (Gmail SMTP ou Resend) ───────────────────────────
let _mailTransporter = null;
function getMailTransporter() {
  if (_mailTransporter) return _mailTransporter;
  const provider = (process.env.EMAIL_PROVIDER || "gmail").toLowerCase();

  if (provider === "gmail") {
    _mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    console.log("📧 Email provider: Gmail SMTP (" + process.env.GMAIL_USER + ")");
  } else {
    // Resend via SMTP (alternativa)
    _mailTransporter = nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      auth: {
        user: "resend",
        pass: process.env.RESEND_API_KEY,
      },
    });
    console.log("📧 Email provider: Resend SMTP");
  }
  return _mailTransporter;
}

async function sendEmail({ to, subject, html }) {
  const fromEmail = process.env.EMAIL_FROM || `FinanceZap <${process.env.GMAIL_USER || "noreply@financezap.app"}>`;
  const provider = (process.env.EMAIL_PROVIDER || "gmail").toLowerCase();

  // Validar config
  if (provider === "gmail" && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    console.warn("❌ GMAIL_USER ou GMAIL_APP_PASSWORD não configurado — email não enviado para", to);
    return { ok: false, reason: "no_gmail_config" };
  }
  if (provider === "resend" && !process.env.RESEND_API_KEY) {
    console.warn("❌ RESEND_API_KEY não configurado — email não enviado para", to);
    return { ok: false, reason: "no_api_key" };
  }

  console.log("📧 Enviando email via", provider, "de:", fromEmail, "para:", to);
  try {
    const transporter = getMailTransporter();
    const info = await transporter.sendMail({
      from: fromEmail,
      to,
      subject,
      html,
    });
    console.log("✅ Email enviado com sucesso! MessageId:", info.messageId);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error("❌ sendEmail error:", e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Static e rotas de páginas ─────────────────────────────────────────────

// Duplo prefixo de API: muitos proxies só repassam /api, não /insights/api
app.get(`${BASE}/api/dashboard`, authRequired, asyncHandler(dashboardRoute));
app.get("/api/dashboard", authRequired, asyncHandler(dashboardRoute));
app.use(`${BASE}/api`, api);
app.use("/api", api);

// Health na raiz (útil quando o proxy só repassa /health ou para teste rápido)
app.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const sb = getSupabase();
    const { error } = await sb.from("transactions").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true });
  })
);

// Landing page na raiz
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/onboarding", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "onboarding.html"));
});

app.get("/checkout", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "checkout.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/ativar", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ativar.html"));
});

app.get("/guia", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "guia.html"));
});

app.get(BASE, (_req, res) => {
  res.redirect(302, `${BASE}/`);
});

app.get(`${BASE}/`, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "insights", "index.html"));
});

app.use(BASE, express.static(path.join(__dirname, "public", "insights")));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Erro interno" });
});

app.listen(PORT, () => {
  console.log(`Gestão Contas em http://localhost:${PORT}/`);
  console.log(`Dashboard: http://localhost:${PORT}${BASE}/`);
  console.log(
    `API JSON: http://localhost:${PORT}/api/health · http://localhost:${PORT}${BASE}/api/health · http://localhost:${PORT}/health`
  );
});
