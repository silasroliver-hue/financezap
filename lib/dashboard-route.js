const { getSupabase } = require("./supabase");
const {
  monthRange,
  aggregateByCategory,
  dailySeries,
  buildPotsFromSpending,
} = require("./dashboard-metrics");
const { accumulatedThroughYMD, sumAccumulatedThroughDate } = require("./transactions-aggregate");

/**
 * Handler GET /insights/api/dashboard (registrado também direto no app para evitar 404 em deploy).
 */
async function dashboardRoute(req, res) {
  const y = parseInt(String(req.query.year || new Date().getFullYear()), 10);
  const m = parseInt(String(req.query.month || new Date().getMonth() + 1), 10);
  if (m < 1 || m > 12) {
    res.status(400).json({ error: "month inválido" });
    return;
  }

  const userId = req.userId;
  const { start, end, daysInMonth } = monthRange(y, m);
  const sb = getSupabase();
  const { data: tx, error } = await sb
    .from("transactions")
    .select("kind, amount, category, occurred_on, description, source")
    .eq("user_id", userId)
    .gte("occurred_on", start)
    .lt("occurred_on", end)
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
  const daily = dailySeries(transactions, y, m, daysInMonth);

  const { data: potsData, error: pErr } = await sb
    .from("budget_pots")
    .select("*")
    .eq("user_id", userId)
    .order("sort_order", { ascending: true });
  if (pErr) throw pErr;
  const potAlloc = buildPotsFromSpending(potsData || [], transactions);

  const potRows = potAlloc.rows.map((row) => {
    const targetAmount = income * row.targetPercent;
    return {
      id: row.id,
      name: row.name,
      targetPercent: row.targetPercent,
      targetAmount,
      spent: row.spent,
      pctOfTotalExpenses: row.pctOfTotalExpenses,
      vsTarget: targetAmount > 0 ? row.spent / targetAmount : null,
    };
  });

  const { data: inv, error: invErr } = await sb.from("investments").select("balance").eq("user_id", userId);
  if (invErr) throw invErr;
  const investmentsTotal = (inv || []).reduce((s, r) => s + Number(r.balance || 0), 0);

  const qAsOf =
    typeof req.query.accumulatedAsOf === "string" ? req.query.accumulatedAsOf.trim() : "";
  const asOf =
    /^\d{4}-\d{2}-\d{2}$/.test(qAsOf) ? qAsOf : accumulatedThroughYMD();
  const totals = await sumAccumulatedThroughDate(sb, asOf, userId);

  // Saldo em contas: soma das contas cadastradas; se não houver nenhuma, usa saldo acumulado dos lançamentos
  const { data: bankAccs, error: baErr } = await sb.from("bank_accounts").select("balance").eq("user_id", userId);
  if (baErr) throw baErr;
  const bankRows = bankAccs || [];
  const bankSumFromDb = bankRows.reduce((s, r) => s + Number(r.balance || 0), 0);
  const txNet = totals.balanceTotalAllTime;
  const dbZero = Math.abs(bankSumFromDb) < 0.005;
  const txNonZero = Math.abs(txNet) > 0.005;

  let bankAccountsTotal = bankSumFromDb;
  let bankBalanceSource = "bank_accounts";

  if (bankRows.length === 0) {
    bankAccountsTotal = txNet;
    bankBalanceSource = "transactions";
  } else if (dbZero && txNonZero) {
    // Contas existem mas saldo não foi informado (tudo 0) — usa caixa dos lançamentos
    bankAccountsTotal = txNet;
    bankBalanceSource = "transactions_unset_balances";
  }

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
    income,
    expense,
    balance: income - expense,
    ...totals,
    bankAccountsTotal,
    bankBalanceSource,
    bankAccountsCount: bankRows.length,
    investmentsTotal,
    billsProgress,
    expenseByCategory,
    incomeByCategory,
    daily,
    potsFromSpending: {
      rows: potRows,
      unallocated: potAlloc.unallocated,
      totalExpense: potAlloc.totalExpense,
      pctUnallocated: potAlloc.pctUnallocated,
    },
    recentTransactions: transactions.slice(0, 12),
  });
}

module.exports = { dashboardRoute };
