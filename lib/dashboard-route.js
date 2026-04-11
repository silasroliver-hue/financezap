const { getSupabase } = require("./supabase");
const {
  monthRange,
  aggregateByCategory,
  dailySeries,
} = require("./dashboard-metrics");
const { sumAccumulatedThroughDate } = require("./transactions-aggregate");

function isYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}

function nextDayYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dailySeriesRange(transactions, fromYmd, toYmd) {
  const start = new Date(`${fromYmd}T12:00:00Z`);
  const end = new Date(`${toYmd}T12:00:00Z`);
  const days = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    days.push({ day: d.getUTCDate(), date: ymd, income: 0, expense: 0 });
  }
  const map = new Map(days.map((r, i) => [r.date, i]));
  for (const t of transactions) {
    const od = String(t.occurred_on || "").slice(0, 10);
    if (!map.has(od)) continue;
    const i = map.get(od);
    const amount = Number(t.amount) || 0;
    if (t.kind === "income") days[i].income += amount;
    else days[i].expense += amount;
  }
  return days;
}

/**
 * Handler GET /insights/api/dashboard (registrado também direto no app para evitar 404 em deploy).
 */
async function dashboardRoute(req, res) {
  const fromQ = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const toQ = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const useRange = isYmd(fromQ) && isYmd(toQ) && fromQ <= toQ;

  const y = parseInt(String(req.query.year || new Date().getFullYear()), 10);
  const m = parseInt(String(req.query.month || new Date().getMonth() + 1), 10);
  if (!useRange && (m < 1 || m > 12)) {
    res.status(400).json({ error: "month inválido" });
    return;
  }

  const userId = req.userId;
  const { start, end, daysInMonth } = monthRange(y, m);
  const rangeStart = useRange ? fromQ : start;
  const rangeEndInclusive = useRange ? toQ : `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const rangeEndExclusive = useRange ? nextDayYmd(toQ) : end;

  const sb = getSupabase();
  const { data: tx, error } = await sb
    .from("transactions")
    .select("kind, amount, category, occurred_on, description, source")
    .eq("user_id", userId)
    .gte("occurred_on", rangeStart)
    .lt("occurred_on", rangeEndExclusive)
    .order("occurred_on", { ascending: false });
  if (error) throw error;
  const transactions = tx || [];

  let income = 0;
  let expense = 0;
  for (const t of transactions) {
    const a = Number(t.amount);
    if (t.kind === "income") income += a;
    else expense += a;
  }

  const expenseByCategory = aggregateByCategory(transactions, "expense");
  const incomeByCategory = aggregateByCategory(transactions, "income");
  const daily = useRange
    ? dailySeriesRange(transactions, rangeStart, rangeEndInclusive)
    : dailySeries(transactions, y, m, daysInMonth);

  // Saldo acumulado deve respeitar o período filtrado na tela.
  const defaultAsOf = rangeEndInclusive;
  const qAsOf =
    typeof req.query.accumulatedAsOf === "string" ? req.query.accumulatedAsOf.trim() : "";
  const asOf =
    /^\d{4}-\d{2}-\d{2}$/.test(qAsOf) ? qAsOf : defaultAsOf;
  const totals = await sumAccumulatedThroughDate(sb, asOf, userId);

  const { data: bills, error: bErr } = await sb
    .from("bill_payments")
    .select("paid")
    .eq("user_id", userId)
    .eq("year", y)
    .eq("month", m);
  if (bErr) throw bErr;
  const bl = bills || [];
  const billsProgress =
    bl.length === 0 ? null : { paid: bl.filter((b) => b.paid).length, total: bl.length };

  res.json({
    year: y,
    month: m,
    from: rangeStart,
    to: rangeEndInclusive,
    income,
    expense,
    balance: income - expense,
    ...totals,
    billsProgress,
    expenseByCategory,
    incomeByCategory,
    daily,
    recentTransactions: transactions.slice(0, 12),
  });
}

module.exports = { dashboardRoute };
