/**
 * Importa planilha.xlsx (raiz do projeto) para Supabase.
 * Uso: npm run import-excel
 *
 * .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * DADOS MENSAIS → tabela transactions (source=import).
 * Reimportar apaga antes todos os lançamentos com source=import.
 *
 * Anos (planilha começa em Outubro = ano fiscal):
 *   IMPORT_DADOS_ANO_OUT_A_DEZ=2025   (Out–Dez)
 *   IMPORT_DADOS_ANO_JAN_A_SET=2026   (Jan–Set)
 * Planilha começando em Janeiro (todos os meses no mesmo ano):
 *   IMPORT_DADOS_ANO=2026
 *
 * Pular só dados mensais: IMPORT_SKIP_DADOS_MENSAIS=1
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const root = path.join(__dirname, "..");
const xlsxPath = path.join(root, "planilha.xlsx");

function monthFromExcelDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    return { y: v.getFullYear(), m: v.getMonth() + 1 };
  }
  return null;
}

const PT_MONTH = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  março: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

function monthNumFromHeader(cell) {
  if (typeof cell !== "string") return null;
  const k = cell
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace("ç", "c");
  return PT_MONTH[k] ?? null;
}

function numCell(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(String(v).replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function importDadosMensais(sb, wb) {
  if (process.env.IMPORT_SKIP_DADOS_MENSAIS === "1") {
    console.log("DADOS MENSAIS: ignorado (IMPORT_SKIP_DADOS_MENSAIS=1).");
    return;
  }

  const sheet = wb.Sheets["DADOS MENSAIS"];
  if (!sheet) {
    console.warn('Aba "DADOS MENSAIS" não encontrada.');
    return;
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  let headerRowIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    if (row[1] === "Grupo de Contas") {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx < 0) {
    console.warn("DADOS MENSAIS: linha de cabeçalho (Grupo de Contas) não encontrada.");
    return;
  }

  const header = rows[headerRowIdx];
  const monthCols = [];
  for (let c = 2; c < header.length; c++) {
    const h = header[c];
    if (typeof h === "string" && /total\s*anual/i.test(h.trim())) break;
    const m = monthNumFromHeader(h);
    if (!m) continue;
    monthCols.push({ col: c, month: m, header: h });
  }
  if (!monthCols.length) {
    console.warn("DADOS MENSAIS: nenhuma coluna de mês reconhecida.");
    return;
  }

  const singleYear = parseInt(process.env.IMPORT_DADOS_ANO, 10);
  const anoOutDez = parseInt(process.env.IMPORT_DADOS_ANO_OUT_A_DEZ, 10) || 2025;
  const anoJanSet = parseInt(process.env.IMPORT_DADOS_ANO_JAN_A_SET, 10) || 2026;
  const fiscal = monthCols[0].month === 10;

  const colMeta = monthCols.map(({ col, month: m }) => {
    let year;
    if (Number.isFinite(singleYear)) year = singleYear;
    else if (fiscal) year = m >= 10 ? anoOutDez : anoJanSet;
    else year = anoJanSet;
    return { col, year, month: m };
  });

  let kind = "income";
  const transactions = [];

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    const g0 = row[0];
    const g1 = row[1];
    const g0s = typeof g0 === "string" ? g0.trim() : "";

    if (g0s === "ENTRADAS") kind = "income";
    else if (g0s === "SAÍDAS" || g0s === "SAIDAS") kind = "expense";

    const isSection = g0s === "ENTRADAS" || g0s === "SAÍDAS" || g0s === "SAIDAS";
    const account = !isSection && g0s
      ? g0s
      : typeof g1 === "string"
        ? g1.trim()
        : "";
    if (!account) continue;
    if (/^(entradas|sa[ií]das|saldo|grupo de contas)$/i.test(account)) continue;

    for (const { col, year, month } of colMeta) {
      const raw = row[col];
      const n = numCell(raw);
      if (n == null || n === 0) continue;
      const amount = Math.abs(n);
      if (amount < 0.005) continue;
      const dd = String(month).padStart(2, "0");
      transactions.push({
        kind,
        category: account.slice(0, 200),
        amount,
        description: "Import planilha — DADOS MENSAIS",
        occurred_on: `${year}-${dd}-01`,
        source: "import",
      });
    }
  }

  if (!transactions.length) {
    console.warn("DADOS MENSAIS: nenhum valor numérico para importar.");
    return;
  }

  const { error: delErr } = await sb.from("transactions").delete().eq("source", "import");
  if (delErr) {
    console.error("DADOS MENSAIS: ao limpar import anterior:", delErr.message);
    return;
  }

  const chunk = 300;
  for (let i = 0; i < transactions.length; i += chunk) {
    const slice = transactions.slice(i, i + chunk);
    const { error } = await sb.from("transactions").insert(slice);
    if (error) {
      console.error("DADOS MENSAIS: insert:", error.message);
      return;
    }
  }
  console.log("DADOS MENSAIS: lançamentos importados:", transactions.length);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  console.log(
    "Dica: DADOS MENSAIS substitui lançamentos com source=import. Investimentos/contas/potes duplicam se você repetir o import completo em banco já preenchido.\n"
  );

  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  console.log("Abas:", wb.SheetNames.join(", "));

  await importDadosMensais(sb, wb);

  const invSheet = wb.Sheets["INVESTIMENTOS"];
  if (invSheet) {
    const rows = XLSX.utils.sheet_to_json(invSheet, { header: 1, defval: null });
    const investments = [];
    for (const row of rows) {
      const name = row[2];
      const balance = row[4];
      if (typeof name === "string" && name.trim() && typeof balance === "number" && balance > 0) {
        if (/ganhos com ativos/i.test(name)) continue;
        if (/TOTAL|POTES|%/i.test(name)) continue;
        investments.push({ broker_name: name.trim(), balance, sort_order: investments.length });
      }
    }
    if (investments.length) {
      const { error } = await sb.from("investments").insert(investments);
      if (error) console.error("Investimentos:", error.message);
      else console.log("Investimentos inseridos:", investments.length);
    }
  }

  const paySheet = wb.Sheets["PAGAMENTOS"];
  if (paySheet) {
    const rows = XLSX.utils.sheet_to_json(paySheet, { header: 1, defval: null });
    let headerRow = -1;
    let colStart = -1;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const idx = row.findIndex((c) => c === "Conta" || (typeof c === "string" && c === "Valores"));
      if (row.includes("Conta") && row.includes("Valores")) {
        headerRow = r;
        colStart = row.indexOf("Conta");
        break;
      }
    }
    if (headerRow < 0) {
      console.warn("Cabeçalho PAGAMENTOS não encontrado.");
    } else {
      const header = rows[headerRow];
      const monthCols = [];
      for (let c = colStart + 2; c < header.length; c++) {
        const dt = monthFromExcelDate(header[c]);
        if (dt) monthCols.push({ col: c, ...dt });
      }
      const templates = [];
      for (let r = headerRow + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row) || row[colStart] == null) continue;
        const name = String(row[colStart]).trim();
        if (!name || name === "Conta") continue;
        const val = row[colStart + 1];
        const default_amount = typeof val === "number" ? val : Number(val) || 0;
        templates.push({ name, default_amount, sort_order: templates.length });
      }
      if (templates.length) {
        const { data: inserted, error: e1 } = await sb.from("recurring_bills").insert(templates).select();
        if (e1) console.error("Contas:", e1.message);
        else {
          console.log("Contas recorrentes:", inserted.length);
          const idByName = new Map(inserted.map((t) => [t.name, t.id]));
          const payments = [];
          for (let r = headerRow + 1; r < rows.length; r++) {
            const row = rows[r];
            if (!Array.isArray(row) || row[colStart] == null) continue;
            const name = String(row[colStart]).trim();
            const billId = idByName.get(name);
            if (!billId) continue;
            for (const { col, y, m } of monthCols) {
              const cell = row[col];
              const ok =
                cell === "OK" ||
                (typeof cell === "string" && cell.trim().toUpperCase() === "OK");
              if (ok) {
                const val = row[colStart + 1];
                const default_amount = typeof val === "number" ? val : Number(val) || 0;
                payments.push({
                  bill_id: billId,
                  year: y,
                  month: m,
                  paid: true,
                  amount_paid: default_amount,
                  paid_at: `${y}-${String(m).padStart(2, "0")}-01`,
                });
              }
            }
          }
          if (payments.length) {
            const { error: e2 } = await sb.from("bill_payments").upsert(payments, {
              onConflict: "bill_id,year,month",
            });
            if (e2) console.error("Pagamentos:", e2.message);
            else console.log("Registros de pagamento OK:", payments.length);
          }
        }
      }
    }
  }

  const potsSheet = wb.Sheets["LEI DOS POTES"];
  if (potsSheet) {
    const rows = XLSX.utils.sheet_to_json(potsSheet, { header: 1, defval: null });
    const pots = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      let label;
      let pct;
      if (typeof row[1] === "string" && typeof row[2] === "number") {
        label = row[1].trim();
        pct = row[2];
      } else if (typeof row[2] === "string" && typeof row[3] === "number") {
        label = row[2].trim();
        pct = row[3];
      } else continue;
      if (!label || !Number.isFinite(pct)) continue;
      if (/insira aqui|total das células|você pode mudar/i.test(label)) continue;
      if (label === "POTES" || label === "%") continue;
      if (pct > 1) pct = pct / 100;
      if (pct < 0 || pct > 1) continue;
      pots.push({ name: label, percent: pct, sort_order: pots.length });
    }
    if (pots.length) {
      const { data: existing } = await sb.from("budget_pots").select("id");
      if (existing?.length) {
        await sb.from("budget_pots").delete().in(
          "id",
          existing.map((r) => r.id)
        );
      }
      const { error } = await sb.from("budget_pots").insert(
        pots.map((p, i) => ({
          name: p.name,
          percent: p.percent,
          sort_order: i,
        }))
      );
      if (error) console.error("Potes:", error.message);
      else console.log("Potes inseridos:", pots.length);
    }
  }

  console.log("Importação concluída.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
