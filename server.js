require("dotenv").config();
const path = require("path");
const express = require("express");
const { getSupabase } = require("./lib/supabase");
const { dashboardRoute } = require("./lib/dashboard-route");
const { authRequired, authOnly } = require("./lib/auth-middleware");
const {
  distinctCategories,
  distinctCategoriesByKind,
} = require("./lib/transactions-aggregate");
const {
  PLANILHA_INCOME_CATEGORIES,
  PLANILHA_EXPENSE_CATEGORIES,
  mergeCategoryLists,
} = require("./lib/planilha-category-defaults");

const app = express();
app.set("strict routing", true);
const PORT = Number(process.env.PORT) || 3000;
const BASE = "/insights";

app.use(express.json({ limit: "256kb" }));

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

const CATEGORIES_LEGACY_FALLBACK = [
  "Moradia",
  "Alimentação",
  "Transporte",
  "Saúde",
  "Educação",
  "Lazer",
  "Salário / renda",
  "Investimentos",
  "Outros",
];

async function buildCategoryList(sb, kind, userId) {
  // Primeiro tenta categorias do usuário (user_categories)
  let userQ = sb.from("user_categories").select("name, kind").eq("user_id", userId).order("sort_order");
  if (kind === "income") userQ = userQ.in("kind", ["income","both"]);
  else if (kind === "expense") userQ = userQ.in("kind", ["expense","both"]);
  const { data: userCats } = await userQ;
  const fromUser = (userCats || []).map(c => c.name);
  if (fromUser.length > 0) return fromUser;

  // Fallback: categorias extraídas das transações + padrões do planilha
  if (kind === "income") {
    return [...PLANILHA_INCOME_CATEGORIES];
  }
  if (kind === "expense") {
    const fromDb = await distinctCategoriesByKind(sb, "expense", userId);
    const list = mergeCategoryLists(fromDb, PLANILHA_EXPENSE_CATEGORIES);
    return list.length ? list : CATEGORIES_LEGACY_FALLBACK;
  }
  const fromDb = await distinctCategories(sb, userId);
  let list = mergeCategoryLists(fromDb, [
    ...PLANILHA_INCOME_CATEGORIES,
    ...PLANILHA_EXPENSE_CATEGORIES,
  ]);
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
    const allowed = ["full_name", "whatsapp_phone"];
    const patch = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        patch[key] = req.body[key] != null ? String(req.body[key]).trim().slice(0, 200) : null;
      }
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
    const { kind, category, amount, description, occurred_on, source } = req.body || {};
    if (kind !== "income" && kind !== "expense") {
      return res.status(400).json({ error: "kind deve ser income ou expense" });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount inválido" });
    }
    const row = {
      user_id: req.userId,
      kind,
      category: typeof category === "string" && category.trim() ? category.trim() : "Geral",
      amount: amt,
      description: description != null ? String(description).slice(0, 500) : null,
      occurred_on: occurred_on || new Date().toISOString().slice(0, 10),
      source: source === "whatsapp" || source === "import" || source === "api" ? source : "manual",
    };
    const sb = getSupabase();
    const { data, error } = await sb.from("transactions").insert(row).select().single();
    if (error) throw error;
    res.status(201).json(data);
  })
);

const TX_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const { name, default_amount, due_day, sort_order } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name obrigatório" });
    const sb = getSupabase();
    const { data, error } = await sb
      .from("recurring_bills")
      .insert({
        user_id: req.userId,
        name: name.trim().slice(0, 200),
        default_amount: Number(default_amount) || 0,
        due_day: due_day != null ? Number(due_day) : null,
        sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
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
    const { name, whatsapp_phone, email, notes } = req.body || {};
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
    if (data.status !== "confirmed") return res.status(402).json({ error: "Pagamento ainda não confirmado" });
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
    if (pmt.status !== "confirmed") return res.status(402).json({ error: "Pagamento não confirmado" });

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
    if (!authRes.ok) {
      const msg = authData?.msg || authData?.message || JSON.stringify(authData);
      return res.status(400).json({ error: msg });
    }

    const userId = authData.id;
    // Cria/atualiza perfil com has_access = true
    await sb.from("user_profiles").upsert({
      id: userId,
      full_name: pmt.name,
      whatsapp_phone: pmt.whatsapp_phone,
      has_access: true,
      paid_at: new Date().toISOString(),
      payment_ref: pmt.id,
    });

    // Marca token como usado (cancela para evitar reuso)
    await sb.from("pending_payments").update({ status: "cancelled" }).eq("id", pmt.id);

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

    // Enviar WhatsApp via n8n (se configurado)
    const sendUrl = process.env.N8N_SEND_WHATSAPP_URL;
    if (sendUrl) {
      const appUrl = process.env.APP_URL || "https://finanzem.com.br";
      const activationLink = `${appUrl}/ativar?token=${data.activation_token}`;
      const message =
        `Olá, ${data.name}! 🎉\n\n` +
        `Seu pagamento foi confirmado. Agora crie sua conta:\n` +
        `👉 ${activationLink}\n\n` +
        `Com esse link você define seu email e senha para acessar o FinanceZap.\n` +
        `Dúvidas? É só chamar aqui!`;
      try {
        await fetch(sendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-secret": process.env.N8N_WEBHOOK_SECRET || "",
          },
          body: JSON.stringify({ phone: data.whatsapp_phone, message }),
        });
      } catch (e) {
        console.warn("Aviso: falha ao enviar WhatsApp:", e.message);
      }
    }

    res.json({ ok: true, payment: data });
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
- Pagar via PIX
- Chave PIX (aleatória): 6369d56a-dbfd-453b-862c-82b2998be04b
- Após pagar, o link de ativação chega aqui no WhatsApp em minutos

REGRAS:
- Se o cliente perguntar sobre funcionalidades, explique de forma prática com exemplos
- Se perguntar o preço, SEMPRE diga R$ 27,90 pagamento único e vitalício
- Se mostrar interesse, envie a chave PIX e explique que é só pagar e aguardar o link
- Se tiver objeção (caro, não sei se preciso), contorne com benefícios reais
- Se perguntar algo fora do escopo (outros produtos, suporte técnico após compra), diga que pode ajudar com dúvidas sobre o FinanceZap
- NUNCA invente funcionalidades que não existem
- NUNCA diga que é uma IA — você é o assistente do FinanceZap
- Se o cliente disser que já pagou, diga para aguardar alguns minutos que o link chega`;

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
        reply: `Olá! ⚡ O FinanceZap custa apenas R$ 27,90 (pagamento único, acesso vitalício).\n\nChave PIX: 6369d56a-dbfd-453b-862c-82b2998be04b\n\nApós pagar, envio o link de ativação aqui mesmo!`,
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
      description: body.description != null ? String(body.description).slice(0, 500) : null,
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

// ─── Static e rotas de páginas ─────────────────────────────────────────────

// Duplo prefixo de API: muitos proxies só repassam /api, não /insights/api
app.get(`${BASE}/api/dashboard`, authRequired, asyncHandler(dashboardRoute));
app.get("/api/dashboard", authRequired, asyncHandler(dashboardRoute));
app.use(`${BASE}/api`, api);
app.use("/api", api);

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
  console.log(`API: /api/dashboard`);
});
