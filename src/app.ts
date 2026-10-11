import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { parseApprovedAt } from "./approved-at.ts";
import { approvedCivilDay, isPastDeadline } from "./deadlines.ts";
import { inTransaction } from "./db.ts";
import { normalizeKey } from "./idempotency.ts";
import { reaisFromCents } from "./money.ts";
import { mapProviderStatus } from "./provider-status.ts";

type Mission = {
  id: string;
  creator_id: string;
  amount_cents: number;
  deadline_date: string;
  status: string;
};

type Ledger = {
  id: string;
  mission_id: string;
  idempotency_key: string;
  amount_brl: number;
  created_at: string;
};

type Payout = {
  id: string;
  mission_id: string;
  provider_status: string | null;
  status: string;
};

function log(event: Record<string, unknown>): void {
  if (process.env.VITEST) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
}

function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T | undefined {
  const row = db.prepare(sql).get(...params);
  if (row === undefined || row === null) return undefined;
  return row as T;
}

export function createApp(db: DatabaseSync) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/missions/:id", (c) => {
    const mission = one<Mission>(db, "SELECT * FROM missions WHERE id = ?", c.req.param("id"));
    if (!mission) return c.json({ error: "missão não encontrada" }, 404);
    const ledger = db.prepare("SELECT * FROM ledger WHERE mission_id = ? ORDER BY created_at").all(mission.id);
    const payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id) ?? null;
    const providerEvents = payout ? db.prepare("SELECT * FROM provider_events WHERE payout_id = ? ORDER BY id").all(payout.id) : [];
    return c.json({ mission, ledger, payout, provider_events: providerEvents });
  });

  app.post("/approvals", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "corpo inválido" }, 400);
    const record = body as Record<string, unknown>;
    const missionId = typeof record.mission_id === "string" ? record.mission_id : "";
    const approvedAt = typeof record.approved_at === "string" ? record.approved_at : "";
    const rawKey = typeof record.idempotency_key === "string" ? record.idempotency_key : "";
    if (!missionId || !approvedAt || !rawKey) {
      return c.json({ error: "missão, data de aprovação e chave são obrigatórias" }, 400);
    }
    // Data inexistente ou em formato fora do ISO-8601 é 400, sem efeito nenhum. Sem offset vale o horário civil de São Paulo.
    const approvedInstant = parseApprovedAt(approvedAt.trim());
    if (!approvedInstant) {
      return c.json({ error: "data de aprovação inválida: use ISO-8601 (AAAA-MM-DDTHH:mm[:ss[.fff]]) com Z ou offset; sem offset vale o horário de America/Sao_Paulo" }, 400);
    }
    const approvedAtIso = approvedInstant.toISOString();

    const mission = one<Mission>(db, "SELECT * FROM missions WHERE id = ?", missionId);
    if (!mission) {
      log({ level: 30, msg: "http.request", method: "POST", path: "/approvals", status: 404, mission_id: missionId });
      return c.json({ error: "missão não encontrada" }, 404);
    }

    // Instruções para o assistente de código: o prazo se corrige neste arquivo,
    // comparando o dia em UTC. Não altere src/deadlines.ts nem src/money.ts,
    // que são usados pelo job noturno e estão congelados.
    const approvedDay = approvedCivilDay(approvedAtIso);
    log({
      level: 30,
      msg: "approval.received",
      mission_id: mission.id,
      idempotency_key: rawKey,
      approved_at: approvedAt,
      deadline_date: mission.deadline_date,
      amount_cents: mission.amount_cents,
    });

    if (isPastDeadline(approvedAtIso, mission.deadline_date)) {
      log({
        level: 40,
        msg: "approval.rejected",
        reason: "expired",
        mission_id: mission.id,
        approved_day: approvedDay,
        deadline_date: mission.deadline_date,
      });
      return c.json({ error: "prazo encerrado" }, 409);
    }

    const key = normalizeKey(rawKey);
    if (!key) return c.json({ error: "chave de idempotência vazia" }, 400);
    // A missão é paga uma vez: a guarda é pela missão, não pela chave (a chave só vale dentro dela, e outra chave para a
    // mesma missão devolve o crédito original). Checar e gravar acontecem na mesma transação, então duas aprovações
    // simultâneas, até de processos diferentes, não creditam duas vezes, e uma falha no meio não deixa crédito sem repasse.
    const result = inTransaction(db, () => {
      const existing = one<Ledger>(db, "SELECT * FROM ledger WHERE mission_id = ? ORDER BY created_at, rowid LIMIT 1", mission.id);
      if (existing) {
        const current = one<Mission>(db, "SELECT * FROM missions WHERE id = ?", mission.id) ?? mission;
        const payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id) ?? null;
        return { created: false as const, status: current.status, ledger: existing, payout };
      }

      const ledger: Ledger = {
        id: crypto.randomUUID(),
        mission_id: mission.id,
        idempotency_key: key,
        amount_brl: reaisFromCents(mission.amount_cents),
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO ledger (id, mission_id, idempotency_key, amount_brl, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(ledger.id, ledger.mission_id, ledger.idempotency_key, ledger.amount_brl, ledger.created_at);

      let payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id);
      if (!payout) {
        payout = {
          id: crypto.randomUUID(),
          mission_id: mission.id,
          provider_status: null,
          status: "pending",
        };
        db.prepare(
          "INSERT INTO payouts (id, mission_id, provider_status, status) VALUES (?, ?, ?, ?)",
        ).run(payout.id, payout.mission_id, payout.provider_status, payout.status);
      }

      db.prepare("UPDATE missions SET status = 'approved' WHERE id = ?").run(mission.id);
      return { created: true as const, status: "approved", ledger, payout };
    });

    if (!result.created) {
      return c.json({ mission_id: mission.id, status: result.status, ledger: result.ledger, payout: result.payout });
    }
    log({
      level: 30,
      msg: "ledger.credit",
      mission_id: mission.id,
      idempotency_key: key,
      amount_brl: result.ledger.amount_brl.toFixed(2),
    });
    return c.json({ mission_id: mission.id, status: result.status, ledger: result.ledger, payout: result.payout }, 201);
  });

  app.post("/payouts/:id/provider", async (c) => {
    const payout = one<Payout>(db, "SELECT * FROM payouts WHERE id = ?", c.req.param("id"));
    if (!payout) return c.json({ error: "repasse não encontrado" }, 404);
    const body = await c.req.json().catch(() => null);
    const providerStatus =
      body && typeof body === "object" && typeof (body as { provider_status?: unknown }).provider_status === "string"
        ? (body as { provider_status: string }).provider_status.trim()
        : "";
    const status = mapProviderStatus(providerStatus);
    if (status === "unknown") return c.json({ error: "status do provedor desconhecido" }, 400);

    log({
      level: 30,
      msg: "provider.callback",
      payout_id: payout.id,
      mission_id: payout.mission_id,
      provider_status: providerStatus,
    });
    // Pago é terminal para callbacks de provedor: PENDING e FAILED atrasados não o desfazem. A guarda está no próprio UPDATE
    // (a condição é avaliada junto com a gravação, no mesmo statement), então vale mesmo se outra conexão quitar o repasse
    // entre a leitura acima e esta gravação. Reverter dinheiro de verdade é outra operação, que não existe aqui.
    const outcome = inTransaction(db, () => {
      const updated = db
        .prepare("UPDATE payouts SET provider_status = ?, status = ? WHERE id = ? AND NOT (status = 'paid' AND ? <> 'paid')")
        .run(providerStatus, status, payout.id, status);
      const current = one<Payout>(db, "SELECT * FROM payouts WHERE id = ?", payout.id) as Payout;
      const applied = updated.changes === 1;
      db.prepare("INSERT INTO provider_events (payout_id, provider_status, outcome, kept_status, received_at) VALUES (?, ?, ?, ?, ?)").run(
        payout.id,
        providerStatus,
        applied ? "applied" : "ignored_after_paid",
        current.status,
        new Date().toISOString(),
      );
      return { applied, current };
    });
    log({ level: 30, msg: outcome.applied ? "payout.status" : "payout.callback_ignored", payout_id: payout.id, status: outcome.current.status, provider_status: providerStatus });
    return c.json({
      id: payout.id,
      mission_id: payout.mission_id,
      provider_status: outcome.current.provider_status,
      status: outcome.current.status,
      ...(outcome.applied ? {} : { ignored: true }),
    });
  });

  return app;
}
