const PAGE = 1000;

/** Data limite (YYYY-MM-DD) no fuso do app — só lançamentos até esse dia entram no saldo acumulado. */
function accumulatedThroughYMD() {
  const tz = process.env.APP_TIMEZONE || "America/Sao_Paulo";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Saldo acumulado: soma de todas as entradas e saídas com occurred_on <= asOfYMD
 * (equivale ao que foi “sobrando” mês a mês até essa data; datas futuras não entram).
 */
async function sumAccumulatedThroughDate(sb, asOfYMD, userId) {
  let income = 0;
  let expense = 0;
  let from = 0;
  for (;;) {
    let q = sb
      .from("transactions")
      .select("id, kind, amount")
      .lte("occurred_on", asOfYMD)
      .order("occurred_on", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw error;
    const chunk = data || [];
    for (const t of chunk) {
      const a = Number(t.amount) || 0;
      if (t.kind === "income") income += a;
      else expense += a;
    }
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return {
    incomeTotalAllTime: income,
    expenseTotalAllTime: expense,
    balanceTotalAllTime: income - expense,
    accumulatedThroughDate: asOfYMD,
  };
}

/**
 * Categorias distintas já usadas nos lançamentos.
 */
async function distinctCategories(sb, userId) {
  return distinctCategoriesByKind(sb, null, userId);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {"income"|"expense"|null} kind — null = todas
 * @param {string} [userId]
 */
async function distinctCategoriesByKind(sb, kind, userId) {
  const set = new Set();
  let from = 0;
  for (;;) {
    let q = sb.from("transactions").select("category").range(from, from + PAGE - 1);
    if (kind === "income" || kind === "expense") {
      q = q.eq("kind", kind);
    }
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw error;
    const chunk = data || [];
    for (const r of chunk) {
      const c = r.category != null ? String(r.category).trim() : "";
      if (c) set.add(c);
    }
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

module.exports = {
  accumulatedThroughYMD,
  sumAccumulatedThroughDate,
  distinctCategories,
  distinctCategoriesByKind,
};
