/**
 * Divide um valor total em n parcelas (centavos; o resto vai nas primeiras parcelas).
 */
function splitInstallmentAmounts(total, n) {
  const nInt = Math.max(1, Math.min(60, parseInt(String(n), 10) || 1));
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return [];
  const base = Math.floor(cents / nInt);
  const remainder = cents % nInt;
  const amounts = [];
  for (let i = 0; i < nInt; i++) {
    const c = base + (i < remainder ? 1 : 0);
    amounts.push(c / 100);
  }
  return amounts;
}

/**
 * Linhas para insert em credit_card_transactions (uma por parcela, datas mensais).
 */
function buildCreditCardInstallmentRows({
  userId,
  cardId,
  description,
  category,
  totalAmount,
  installments,
  purchaseDateStr,
}) {
  const installs = Math.max(1, Math.min(60, parseInt(String(installments), 10) || 1));
  const amounts = splitInstallmentAmounts(totalAmount, installs);
  if (!amounts.length) return [];
  const dateStr = purchaseDateStr || new Date().toISOString().slice(0, 10);
  const rows = [];
  for (let i = 1; i <= installs; i++) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + (i - 1));
    rows.push({
      user_id: userId,
      card_id: cardId,
      description: description ? String(description).slice(0, 300) : null,
      category: category ? String(category).slice(0, 120) : "Geral",
      amount: amounts[i - 1],
      installments: installs,
      current_installment: i,
      purchase_date: d.toISOString().slice(0, 10),
    });
  }
  return rows;
}

function monthKeyFromDate(dateStr) {
  const s = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  return s.slice(0, 7);
}

function monthKeyFromParts(year, month) {
  const y = parseInt(String(year), 10);
  const m = parseInt(String(month), 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return "";
  return `${y}-${String(m).padStart(2, "0")}`;
}

function shiftMonthKey(monthKey, delta) {
  const base = monthKeyFromDate(`${monthKey}-01`);
  if (!base) return "";
  const d = new Date(`${base}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Number(delta || 0));
  return d.toISOString().slice(0, 7);
}

function buildPurchaseGroupKey(row) {
  return [
    row.card_id || "",
    row.created_at || "",
    row.description || "",
    row.category || "",
    Number(row.installments) || 1,
  ].join("::");
}

function groupInstallmentRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = buildPurchaseGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        card_id: row.card_id,
        created_at: row.created_at,
        description: row.description || null,
        category: row.category || "Geral",
        installments: Math.max(1, parseInt(String(row.installments || 1), 10) || 1),
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }

  return [...groups.values()].map((group) => {
    const ordered = [...group.rows].sort((a, b) => {
      const da = String(a.purchase_date || "");
      const db = String(b.purchase_date || "");
      if (da !== db) return da.localeCompare(db);
      return (Number(a.current_installment) || 1) - (Number(b.current_installment) || 1);
    });
    const totalAmount = ordered.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    return {
      ...group,
      rows: ordered,
      first_purchase_date: ordered[0]?.purchase_date || null,
      last_purchase_date: ordered[ordered.length - 1]?.purchase_date || null,
      total_amount: totalAmount,
    };
  });
}

module.exports = {
  splitInstallmentAmounts,
  buildCreditCardInstallmentRows,
  monthKeyFromDate,
  monthKeyFromParts,
  shiftMonthKey,
  buildPurchaseGroupKey,
  groupInstallmentRows,
};
