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
const PORT = Number(process.env.PORT) || (process.env.NODE_ENV === "production" ? 80 : 3000);
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
    const allowed = ["full_name", "whatsapp_phone", "email"];
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

    const appUrl = process.env.APP_URL || "https://financezap.thesilasstudio.com.br";
    const activationLink = `${appUrl}/ativar?token=${data.activation_token}`;
    const guiaLink = `${appUrl}/guia`;

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
          body: JSON.stringify({ phone: data.whatsapp_phone, message: whatsappMsg }),
        });
      } catch (e) {
        console.warn("Aviso: falha ao enviar WhatsApp:", e.message);
      }
    }

    // Enviar email de ativação
    if (data.email) {
      const emailHtml = buildActivationEmail(data.name, activationLink, guiaLink);
      await sendEmail({ to: data.email, subject: "🎉 Seu acesso ao FinanceZap está pronto!", html: emailHtml });
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

    // Receita total (pagamentos confirmados)
    const { data: revenueData } = await sb
      .from("pending_payments")
      .select("amount")
      .eq("status", "confirmed");
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
      .select("id, full_name, whatsapp_phone, email, has_access, paid_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;

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

    const users = (profiles || []).map(p => ({
      ...p,
      tx_count: txCountMap[p.id] || 0,
      last_activity: txLastMap[p.id] || null,
    }));

    res.json(users);
  })
);

// ─── Webhook: verificar usuário por telefone (para n8n) ───────────────────

api.post(
  "/webhook/check-user",
  requireWebhookSecret,
  asyncHandler(async (req, res) => {
    const rawPhone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!rawPhone) return res.status(400).json({ error: "phone obrigatório" });

    const sb = getSupabase();
    const { data: profile } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .eq("whatsapp_phone", rawPhone)
      .single();

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

const WHATSAPP_MENU = (name) =>
  `Olá, *${name}*! 👋 O que você quer fazer?\n\n` +
  `1️⃣ Extrato por período\n` +
  `2️⃣ Lançar receita\n` +
  `3️⃣ Lançar despesa\n` +
  `4️⃣ Lançar investimento\n` +
  `5️⃣ Ver saldo das contas\n` +
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

    // Busca usuário
    const { data: profile } = await sb
      .from("user_profiles")
      .select("id, full_name, has_access")
      .eq("whatsapp_phone", rawPhone)
      .single();

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

    // ── Detecta "cancelar" em qualquer estado
    if (["cancelar", "sair", "voltar", "menu", "cancel"].includes(lower)) {
      await clearSession();
      return res.json({ type: "user", reply: WHATSAPP_MENU(profile.full_name) });
    }

    // ── Estado: aguardando dias do extrato
    if (state === "waiting_extrato_days") {
      const days = parseInt(lower.replace(/\D/g, ""), 10);
      if (!days || days < 1 || days > 365) {
        return res.json({ type: "user", reply: "Por favor, informe um número de dias válido (ex: *7*, *30*, *90*)." });
      }
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      const fromStr = fromDate.toISOString().slice(0, 10);

      const { data: txs } = await sb
        .from("transactions")
        .select("kind, amount, category, occurred_on")
        .eq("user_id", profile.id)
        .gte("occurred_on", fromStr)
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
        occurred_on: new Date().toISOString().slice(0, 10), source: "whatsapp",
      }).select().single();
      await clearSession();
      return res.json({ type: "user", reply: `💚 *Receita registrada!*\n\n💰 ${brl(amount)} — ${ctx.category}\n✅ Salvo no FinanceZap!` });
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
      const amount = parseFloat(lower.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!amount || amount <= 0) {
        return res.json({ type: "user", reply: "Valor inválido. Informe o valor da despesa (ex: *250* ou *89,90*):" });
      }
      await sb.from("transactions").insert({
        user_id: profile.id, kind: "expense",
        category: ctx.category || "Despesa", amount,
        occurred_on: new Date().toISOString().slice(0, 10), source: "whatsapp",
      });
      await clearSession();
      return res.json({ type: "user", reply: `❤️ *Despesa registrada!*\n\n💸 ${brl(amount)} — ${ctx.category}\n✅ Salvo no FinanceZap!` });
    }

    // ── Estado: aguardando banco do investimento
    if (state === "waiting_invest_broker") {
      const broker = text.trim().slice(0, 120);
      await saveSession("waiting_invest_amount", { broker });
      return res.json({ type: "user", reply: `📈 Banco/corretora: *${broker}*\n\nAgora informe o *saldo atual* nessa conta (ex: 5000):` });
    }

    // ── Estado: aguardando valor do investimento
    if (state === "waiting_invest_amount") {
      const balance = parseFloat(lower.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!balance || balance < 0) {
        return res.json({ type: "user", reply: "Valor inválido. Informe o saldo (ex: *5000* ou *5000,50*):" });
      }
      // Upsert investimento
      const { data: existing } = await sb
        .from("investments")
        .select("id")
        .eq("user_id", profile.id)
        .ilike("broker_name", ctx.broker || "")
        .single();
      if (existing) {
        await sb.from("investments").update({ balance, updated_at: new Date().toISOString() }).eq("id", existing.id);
      } else {
        await sb.from("investments").insert({ user_id: profile.id, broker_name: ctx.broker, balance, updated_at: new Date().toISOString() });
      }
      await clearSession();
      return res.json({ type: "user", reply: `📈 *Investimento atualizado!*\n\n🏦 ${ctx.broker}: *${brl(balance)}*\n✅ Salvo no FinanceZap!` });
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
    const isOption4 = /^(4|investimento|investimento|poupança|poupanca|aplicacao|aplicação)/.test(lower);
    const isOption5 = /^(5|saldo|contas|conta|balance)/.test(lower);
    const isOption6 = /^(6|duvida|dúvida|ajuda|pergunta|como|o que|como funciona|\?)/.test(lower);

    if (isGreeting) {
      return res.json({ type: "user", reply: WHATSAPP_MENU(profile.full_name) });
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
      await saveSession("waiting_invest_broker", {});
      return res.json({ type: "user", reply: "📈 *Lançar investimento*\n\nQual banco ou corretora? (ex: Nubank, XP, Itaú)" });
    }

    if (isOption5) {
      const { data: accounts } = await sb.from("bank_accounts").select("name, balance").eq("user_id", profile.id).order("sort_order");
      const { data: investments } = await sb.from("investments").select("broker_name, balance").eq("user_id", profile.id).order("sort_order");

      const accLines = (accounts || []).map(a => `🏦 ${a.name}: *${brl(a.balance)}*`);
      const invLines = (investments || []).map(i => `📈 ${i.broker_name}: *${brl(i.balance)}*`);
      const totalAcc = (accounts || []).reduce((s, a) => s + Number(a.balance || 0), 0);
      const totalInv = (investments || []).reduce((s, i) => s + Number(i.balance || 0), 0);

      const lines = [...accLines, ...(invLines.length ? ["", ...invLines] : [])];
      if (!lines.length) {
        return res.json({ type: "user", reply: "Você ainda não cadastrou nenhuma conta. Acesse o dashboard para adicionar suas contas! 💡" });
      }
      return res.json({ type: "user", reply: `💰 *Saldo das suas contas:*\n\n${lines.join("\n")}\n\n💳 Total contas: *${brl(totalAcc)}*\n📈 Total invest.: *${brl(totalInv)}*\n\n🏆 Patrimônio total: *${brl(totalAcc + totalInv)}*` });
    }

    if (isOption6) {
      await saveSession("waiting_question", {});
      return res.json({ type: "user", reply: "🤔 Qual é a sua dúvida? Pode perguntar!" });
    }

    // ── Fallback: tenta detectar transação rápida (ex: "saiu 50 mercado")
    const ENTRADA_WORDS = ["entrada", "recebi", "salario", "salário", "renda", "ganho", "ganhei"];
    const SAIDA_WORDS   = ["saida", "saída", "gasto", "gastei", "paguei", "pagamento", "despesa", "comprei", "transferi"];
    let kind = null;
    for (const w of ENTRADA_WORDS) { if (lower.includes(w)) { kind = "income"; break; } }
    if (!kind) for (const w of SAIDA_WORDS) { if (lower.includes(w)) { kind = "expense"; break; } }

    const amountMatch = text.match(/(\d+[.,]?\d*)/);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(",", ".")) : null;

    if (kind && amount && amount > 0) {
      const after = amountMatch ? text.slice(text.indexOf(amountMatch[1]) + amountMatch[1].length).trim() : "";
      const category = after.length > 1 ? after.charAt(0).toUpperCase() + after.slice(1) : (kind === "income" ? "Receita" : "Despesa");
      await sb.from("transactions").insert({
        user_id: profile.id, kind, category, amount,
        occurred_on: new Date().toISOString().slice(0, 10), source: "whatsapp",
        description: text,
      });
      const emoji = kind === "income" ? "💚" : "❤️";
      const tipo = kind === "income" ? "Receita" : "Despesa";
      return res.json({ type: "user", reply: `${emoji} *${tipo} registrada!*\n\n💰 ${brl(amount)} — ${category}\n✅ Salvo no FinanceZap!\n\nDigite *menu* para mais opções.` });
    }

    // Sem intenção detectada → envia menu
    return res.json({ type: "user", reply: WHATSAPP_MENU(profile.full_name) });
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

api.post(
  "/credit-cards",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, bank_name, last_four, credit_limit, closing_day, due_day, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });
    const sb = getSupabase();
    const { data, error } = await sb.from("credit_cards").insert({
      user_id: req.userId,
      name: String(name).trim().slice(0, 120),
      bank_name: bank_name ? String(bank_name).trim().slice(0, 120) : null,
      last_four: last_four ? String(last_four).replace(/\D/g, "").slice(-4) : null,
      credit_limit: Number.isFinite(Number(credit_limit)) ? Number(credit_limit) : 0,
      closing_day: Number.isInteger(Number(closing_day)) ? Number(closing_day) : null,
      due_day: Number.isInteger(Number(due_day)) ? Number(due_day) : null,
      color: color ? String(color).slice(0, 20) : "#8B5CF6",
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
    const { name, bank_name, last_four, credit_limit, closing_day, due_day, color } = req.body || {};
    const patch = {};
    if (name != null) patch.name = String(name).trim().slice(0, 120);
    if (bank_name !== undefined) patch.bank_name = bank_name ? String(bank_name).trim().slice(0, 120) : null;
    if (last_four != null) patch.last_four = String(last_four).replace(/\D/g, "").slice(-4);
    if (credit_limit != null && Number.isFinite(Number(credit_limit))) patch.credit_limit = Number(credit_limit);
    if (closing_day != null) patch.closing_day = Number(closing_day);
    if (due_day != null) patch.due_day = Number(due_day);
    if (color != null) patch.color = String(color).slice(0, 20);
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
    const rows = [];
    for (let i = 1; i <= installs; i++) {
      const d = new Date(dateStr + "T12:00:00Z");
      d.setMonth(d.getMonth() + (i - 1));
      rows.push({
        user_id: req.userId,
        card_id,
        description: description ? String(description).slice(0, 300) : null,
        category: category ? String(category).slice(0, 120) : "Geral",
        amount: amt,
        installments: installs,
        current_installment: i,
        purchase_date: d.toISOString().slice(0, 10),
      });
    }
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
    const { error } = await sb.from("credit_card_transactions").delete().eq("id", req.params.id).eq("user_id", req.userId);
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

    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const end   = `${nextY}-${String(nextM).padStart(2, "0")}-01`;

    const { data: txs, error } = await sb.from("credit_card_transactions")
      .select("*").eq("card_id", card.id).eq("user_id", req.userId)
      .gte("purchase_date", start).lt("purchase_date", end)
      .order("purchase_date", { ascending: false });
    if (error) throw error;

    const total = (txs || []).reduce((s, t) => s + Number(t.amount), 0);
    res.json({ card, year: y, month: m, transactions: txs || [], total });
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

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || "FinanceZap <noreply@financezap.app>";
  if (!apiKey) {
    console.warn("RESEND_API_KEY não configurado — email não enviado para", to);
    return { ok: false, reason: "no_api_key" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromEmail, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) { console.warn("Resend error:", data); return { ok: false, error: data }; }
    return { ok: true, id: data.id };
  } catch (e) {
    console.warn("sendEmail error:", e.message);
    return { ok: false, error: e.message };
  }
}

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
  console.log(`API: /api/dashboard`);
});
