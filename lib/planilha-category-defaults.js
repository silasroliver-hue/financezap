/**
 * ENTRADAS: lista fixa do DADOS MENSAIS (ordem da planilha). O combobox de entrada usa só isto.
 */
const PLANILHA_INCOME_CATEGORIES = [
  "Tokio",
  "Aluguel Cond Nossa Sra Fatima",
  "Aluguel CDHU",
  "Casa Mathues",
  "TS Tech",
  "Mathu",
  "Joel",
  "Outros",
  "Investimentos",
  "Celular ida e vindas",
];

const PLANILHA_EXPENSE_CATEGORIES = [
  "Academia",
  "Açocue",
  "Almoços",
  "Aluguel",
  "App CCB",
  "Arthur/Maria",
  "Beleza e Farmacia",
  "Caridade e Coleta",
  "Carro",
  "Cartão",
  "Casa",
  "Coisas Casa",
  "Combustivel",
  "Condominio",
  "Dentista 2025",
  "Dentista/medico",
  "Diversos",
  "Empregada",
  "Enel",
  "Ensino",
  "Escola",
  "Estacionamento",
  "Farmácia+beleza",
  "Financiamento Carro",
  "Ifood",
  "Internet",
  "Investimento",
  "IPTU",
  "Lava Rapido",
  "Lazer",
  "Lazer e Jantares",
  "Manutenção",
  "Manutenção Carro",
  "Mathu Emporio",
  "Netflix+Spotify",
  "Oliver Store",
  "Pedágio",
  "PET (Banho e ração)",
  "Presentes",
  "Prestação Santander",
  "Salão Beleza",
  "Sammartino",
  "Supermercado",
  "Suplemetação",
  "Tarifas bancária",
  "TV",
  "Uber",
  "Vestuário",
  "Vestuário Arthur e Maria",
  "Vestuário Silas",
  "Vestuário Thais",
  "Viagens",
  "Vinho",
];

function mergeCategoryLists(fromDb, planilhaDefaults) {
  const set = new Set();
  for (const c of planilhaDefaults) {
    const t = String(c).trim();
    if (t) set.add(t);
  }
  for (const c of fromDb) {
    const t = String(c).trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

module.exports = {
  PLANILHA_INCOME_CATEGORIES,
  PLANILHA_EXPENSE_CATEGORIES,
  mergeCategoryLists,
};
