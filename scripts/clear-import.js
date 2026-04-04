/**
 * Remove dados trazidos da planilha / import para você rodar npm run import-excel de novo.
 *
 * Padrão: apaga só lançamentos com source = 'import' (DADOS MENSAIS).
 *
 * Com --seed também apaga: investments, recurring_bills (e bill_payments em cascata),
 * budget_pots — use se duplicou investimentos/contas/potes ao importar várias vezes.
 *
 * Uso: npm run clear-import
 *       npm run clear-import -- --seed
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env");
    process.exit(1);
  }

  const seed = process.argv.includes("--seed");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { error: delTx } = await sb.from("transactions").delete().eq("source", "import");
  if (delTx) {
    console.error("Erro ao apagar lançamentos import:", delTx.message);
    process.exit(1);
  }
  console.log("Lançamentos com source=import removidos.");

  if (!seed) {
    console.log("Pronto. Rode: npm run import-excel");
    console.log("Se ainda houver duplicata em investimentos/contas/potes: npm run clear-import -- --seed");
    return;
  }

  const { error: eInv } = await sb.from("investments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (eInv) {
    console.error("investments:", eInv.message);
    process.exit(1);
  }
  console.log("Tabela investments esvaziada.");

  const { error: eBill } = await sb.from("recurring_bills").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (eBill) {
    console.error("recurring_bills:", eBill.message);
    process.exit(1);
  }
  console.log("Contas recorrentes e pagamentos do mês removidos (cascata).");

  const { data: potIds, error: ePotQ } = await sb.from("budget_pots").select("id");
  if (ePotQ) {
    console.error("budget_pots select:", ePotQ.message);
    process.exit(1);
  }
  if (potIds?.length) {
    const { error: ePot } = await sb.from("budget_pots").delete().in(
      "id",
      potIds.map((r) => r.id)
    );
    if (ePot) {
      console.error("budget_pots:", ePot.message);
      process.exit(1);
    }
  }
  console.log("Potes removidos.");

  console.log("Pronto. Rode: npm run import-excel");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
