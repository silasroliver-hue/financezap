/**
 * Agrega transações do mês: categorias, série diária, distribuição por pote (palavras-chave).
 */

function monthRange(y, m) {
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { start, end, daysInMonth: new Date(y, m, 0).getDate() };
}

function normalizeStr(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ç/g, "c");
}

const STOP = new Set([
  "com",
  "das",
  "dos",
  "por",
  "para",
  "e",
  "de",
  "da",
  "do",
  "em",
  "na",
  "no",
  "aos",
  "nas",
  "nos",
]);

const POT_SYNONYMS = [
  {
    match: (k) => k.includes("contas") && k.includes("basic"),
    extra: [
      "aluguel",
      "condominio",
      "cond",
      "internet",
      "enel",
      "energia",
      "iptu",
      "supermercado",
      "mercado",
      "acougue",
      "açougue",
      "casa",
      "empregada",
      "agua",
      "luz",
      "gas",
      "fatura",
      "coisas",
      "manutencao",
      "manutenção",
      "sammartino",
      "santander",
      "prestacao",
      "prestação",
      "financiamento",
    ],
  },
  {
    match: (k) => k.includes("educ"),
    extra: ["escola", "curso", "faculdade", "livro", "ensino", "matricula", "matrícula"],
  },
  {
    match: (k) => k.includes("invest"),
    extra: ["cdb", "tesouro", "acao", "ação", "cripto", "rendimento"],
  },
  {
    match: (k) => k.includes("merec"),
    extra: ["lazer", "viagem", "restaurante", "vinho", "hobby", "presente"],
  },
  {
    match: (k) => k.includes("sonho"),
    extra: ["viagem", "reserva", "objetivo"],
  },
  {
    match: (k) => k.includes("dizimo") || k.includes("caridade") || k.includes("dízimo"),
    extra: ["igreja", "adventista", "oferta", "contribuicao", "contribuição", "ccb"],
  },
];

function synonymsForPot(potNameNorm) {
  for (const rule of POT_SYNONYMS) {
    if (rule.match(potNameNorm)) return rule.extra;
  }
  return [];
}

function potKeywords(potName) {
  const base = normalizeStr(potName)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const syn = synonymsForPot(normalizeStr(potName).replace(/\s+/g, " "));
  return [...new Set([...base, ...syn])];
}

function bestPotForCategory(category, pots) {
  const nc = normalizeStr(category);
  let best = null;
  let bestScore = 0;
  for (const p of pots) {
    const kws = potKeywords(p.name);
    let score = 0;
    for (const k of kws) {
      if (nc.includes(k)) score += 1;
    }
    const full = normalizeStr(p.name).replace(/\s+/g, "");
    if (full.length >= 4 && nc.replace(/\s+/g, "").includes(full.slice(0, 6))) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

function aggregateByCategory(transactions, kind) {
  const map = new Map();
  for (const t of transactions) {
    if (t.kind !== kind) continue;
    const cat = (t.category || "Geral").trim() || "Geral";
    const a = Number(t.amount) || 0;
    map.set(cat, (map.get(cat) || 0) + a);
  }
  const arr = [...map.entries()].map(([category, amount]) => ({ category, amount }));
  arr.sort((a, b) => b.amount - a.amount);
  return arr;
}

function dailySeries(transactions, y, m, daysInMonth) {
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({
      day: d,
      date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      income: 0,
      expense: 0,
    });
  }
  for (const t of transactions) {
    const od = t.occurred_on;
    if (!od || typeof od !== "string") continue;
    const parts = od.slice(0, 10).split("-");
    if (parts.length < 3) continue;
    const ty = parseInt(parts[0], 10);
    const tm = parseInt(parts[1], 10);
    const td = parseInt(parts[2], 10);
    if (ty !== y || tm !== m || td < 1 || td > daysInMonth) continue;
    const idx = td - 1;
    const a = Number(t.amount) || 0;
    if (t.kind === "income") days[idx].income += a;
    else days[idx].expense += a;
  }
  return days;
}

function buildPotsFromSpending(potsConfig, expenseTransactions) {
  const byId = new Map(potsConfig.map((p) => [p.id, { pot: p, spent: 0 }]));
  let unallocated = 0;

  for (const t of expenseTransactions) {
    if (t.kind !== "expense") continue;
    const amt = Number(t.amount) || 0;
    const match = bestPotForCategory(t.category, potsConfig);
    if (match) {
      byId.get(match.id).spent += amt;
    } else {
      unallocated += amt;
    }
  }

  const totalExpense = expenseTransactions
    .filter((t) => t.kind === "expense")
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);

  const rows = potsConfig.map((p) => {
    const spent = byId.get(p.id).spent;
    const pctExpense = totalExpense > 0 ? spent / totalExpense : 0;
    return {
      id: p.id,
      name: p.name,
      targetPercent: Number(p.percent) || 0,
      spent,
      pctOfTotalExpenses: pctExpense,
    };
  });

  return {
    rows,
    unallocated,
    totalExpense,
    pctUnallocated: totalExpense > 0 ? unallocated / totalExpense : 0,
  };
}

module.exports = {
  monthRange,
  aggregateByCategory,
  dailySeries,
  buildPotsFromSpending,
};
