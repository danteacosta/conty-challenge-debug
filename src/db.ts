import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  deadline_date TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_brl REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL UNIQUE,
  provider_status TEXT,
  status TEXT NOT NULL
);

-- Append-only: cada callback do provedor, aplicado ou ignorado. Um callback atrasado que não pode desfazer um repasse pago fica aqui.
CREATE TABLE IF NOT EXISTS provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored_after_paid')),
  kept_status TEXT NOT NULL,
  received_at TEXT NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Várias conexões ao mesmo arquivo esperam o lock de escrita em vez de falhar na hora.
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  ensureOneCreditPerMission(db);
  return db;
}

/**
 * Um lançamento por missão também no banco. Se já existem duplicados históricos (os do incidente), o índice não
 * pode ser criado: avisamos e seguimos, sem apagar nem ajustar nenhuma linha. A guarda da API vale de qualquer jeito.
 */
function ensureOneCreditPerMission(db: DatabaseSync): void {
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_per_mission ON ledger (mission_id)");
  } catch {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM (SELECT mission_id FROM ledger GROUP BY mission_id HAVING COUNT(*) > 1)")
      .get() as { n: number };
    console.warn(
      `[repasses] ${row.n} missão(ões) com mais de um lançamento no ledger: a restrição de unicidade por missão não foi criada e nenhum dado foi alterado. Revise os duplicados antes de criar o índice.`,
    );
  }
}

/** Transação que já toma o lock de escrita (BEGIN IMMEDIATE): checar e gravar viram um passo só, mesmo entre processos. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
