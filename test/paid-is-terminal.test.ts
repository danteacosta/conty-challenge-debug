import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";
import { tsWorker } from "./spawn-worker.ts";

type App = ReturnType<typeof createApp>;
const dir = mkdtempSync(join(tmpdir(), "repasses-pago-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const post = (app: App, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function approvedPayout(app: App, missionId = "msn_1900") {
  const res = await post(app, "/approvals", { mission_id: missionId, approved_at: "2026-03-12T18:11:00.000Z", idempotency_key: `k-${missionId}` });
  return ((await res.json()) as { payout: { id: string } }).payout.id;
}
const callback = async (app: App, payoutId: string, provider_status: string) => {
  const res = await post(app, `/payouts/${payoutId}/provider`, { provider_status });
  return { status: res.status, body: (await res.json()) as any };
};
const mission = async (app: App, id: string) => (await (await app.request(`/missions/${id}`)).json()) as any;

function fresh() {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return { db, app: createApp(db) };
}

describe("pago é terminal: um callback atrasado não desfaz o repasse", () => {
  it.each(["PENDING", "FAILED"])("depois de CONFIRMED, %s não regride o repasse: continua pago, com o status confirmado", async (late) => {
    const { app } = fresh();
    const payout = await approvedPayout(app);
    await callback(app, payout, "CONFIRMED");
    const res = await callback(app, payout, late);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "paid", provider_status: "CONFIRMED", ignored: true });
    expect((await mission(app, "msn_1900")).payout).toMatchObject({ status: "paid", provider_status: "CONFIRMED" });
  });

  it("o callback ignorado fica registrado, com o que chegou e o que foi mantido", async () => {
    const { app } = fresh();
    const payout = await approvedPayout(app);
    await callback(app, payout, "RECEIVED");
    await callback(app, payout, "PENDING");
    await callback(app, payout, "FAILED");
    const { provider_events: events } = await mission(app, "msn_1900");
    expect(events.map((e: any) => [e.provider_status, e.outcome])).toEqual([
      ["RECEIVED", "applied"],
      ["PENDING", "ignored_after_paid"],
      ["FAILED", "ignored_after_paid"],
    ]);
    expect(events[1]).toMatchObject({ payout_id: payout, kept_status: "paid" });
  });

  it("outro status de pago ainda atualiza o status do provedor (RECEIVED depois de CONFIRMED)", async () => {
    const { app } = fresh();
    const payout = await approvedPayout(app);
    await callback(app, payout, "CONFIRMED");
    const res = await callback(app, payout, "RECEIVED");
    expect(res.body).toMatchObject({ status: "paid", provider_status: "RECEIVED" });
    expect(res.body.ignored).toBeUndefined();
  });

  it("antes de pago nada muda: PENDING, FAILED e depois CONFIRMED seguem o fluxo de sempre", async () => {
    const { app } = fresh();
    const payout = await approvedPayout(app);
    expect((await callback(app, payout, "PENDING")).body.status).toBe("pending");
    expect((await callback(app, payout, "FAILED")).body.status).toBe("failed");
    expect((await callback(app, payout, "CONFIRMED")).body.status).toBe("paid");
    expect((await mission(app, "msn_1900")).provider_events.map((e: any) => e.outcome)).toEqual(["applied", "applied", "applied"]);
  });

  it("o histórico de callbacks devolvido é limitado aos 100 mais recentes, em ordem cronológica", async () => {
    const { app, db } = fresh();
    const payout = await approvedPayout(app);
    for (let i = 0; i < 130; i += 1) await callback(app, payout, i === 129 ? "CONFIRMED" : "PENDING");
    const view = await mission(app, "msn_1900");
    const events = view.provider_events;
    expect(events).toHaveLength(100);
    expect(events.at(-1)).toMatchObject({ provider_status: "CONFIRMED", outcome: "applied" });
    expect(events[0].id).toBeLessThan(events[1].id);
    // O limite é só da consulta: a resposta diz quantos existem e o histórico persistido continua inteiro.
    expect(view.provider_events_total).toBe(130);
    expect(view.provider_events_returned).toBe(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_events WHERE payout_id = ?").get(payout)).toEqual({ n: 130 });
  });

  it("status desconhecido continua sendo 400 e não registra evento", async () => {
    const { app } = fresh();
    const payout = await approvedPayout(app);
    expect((await callback(app, payout, "REFUNDED")).status).toBe(400);
    expect((await mission(app, "msn_1900")).provider_events).toEqual([]);
  });

  it("a proteção está no próprio UPDATE: outra conexão quita o repasse depois de o app lê-lo como pendente e antes de gravar", async () => {
    const path = join(dir, "update.db");
    const seeded = openDatabase(path);
    seedIncident(seeded);
    const payout = await approvedPayout(createApp(seeded));
    seeded.close();

    const db = openDatabase(path);
    const other = openDatabase(path);
    let fired = false;
    const hooked = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "exec") {
          return (sql: string) => {
            // o app já leu o repasse como pendente; imediatamente antes de abrir a transação de gravação, a outra conexão o quita
            if (!fired && /^\s*BEGIN IMMEDIATE/i.test(sql)) {
              fired = true;
              other.prepare("UPDATE payouts SET status = 'paid', provider_status = 'CONFIRMED' WHERE id = ?").run(payout);
            }
            return target.exec(sql);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await callback(createApp(hooked), payout, "PENDING");
    expect(fired).toBe(true);
    expect(res.body).toMatchObject({ status: "paid", provider_status: "CONFIRMED", ignored: true });
    expect(db.prepare("SELECT status FROM payouts WHERE id = ?").get(payout)).toEqual({ status: "paid" });
    db.close();
    other.close();
  });
});

describe("corrida entre conexões: confirmações e callbacks atrasados chegando juntos", () => {
  it("12 rodadas em bancos novos, 4 workers (2 mandam CONFIRMED, 1 PENDING, 1 FAILED, vários callbacks cada): o repasse termina pago", async () => {
    for (let round = 0; round < 12; round += 1) {
      const path = join(dir, `corrida-${round}.db`);
      const seed = openDatabase(path);
      seedIncident(seed);
      const app = createApp(seed);
      const payout = await approvedPayout(app);
      seed.close();

      const barrier = new SharedArrayBuffer(8);
      const flags = new Int32Array(barrier);
      const sequences = [["CONFIRMED", "PENDING", "CONFIRMED"], ["PENDING", "FAILED", "PENDING", "FAILED"], ["FAILED", "PENDING", "FAILED"], ["RECEIVED", "PENDING"]];
      const done = sequences.map(
        (statuses) =>
          new Promise<number[]>((resolve, reject) => {
            const worker = tsWorker(new URL("./payout-worker.ts", import.meta.url), { path, payout, statuses, barrier });
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      );
      done.forEach((p) => p.catch(() => {}));
      while (Atomics.load(flags, 1) < sequences.length) await new Promise((resolve) => setTimeout(resolve, 5));
      Atomics.store(flags, 0, 1);
      Atomics.notify(flags, 0);
      await Promise.all(done);

      const check = openDatabase(path);
      const row = check.prepare("SELECT status, provider_status FROM payouts WHERE id = ?").get(payout) as { status: string; provider_status: string };
      const events = check.prepare("SELECT provider_status, outcome FROM provider_events WHERE payout_id = ? ORDER BY id").all(payout) as Array<{ provider_status: string; outcome: string }>;
      check.close();
      expect(row.status, `rodada ${round}`).toBe("paid");
      expect(["CONFIRMED", "RECEIVED"]).toContain(row.provider_status);
      // depois do primeiro callback de pago, nenhum PENDING/FAILED foi aplicado
      const firstPaid = events.findIndex((e) => ["CONFIRMED", "RECEIVED"].includes(e.provider_status) && e.outcome === "applied");
      expect(firstPaid, `rodada ${round}`).toBeGreaterThanOrEqual(0);
      for (const e of events.slice(firstPaid)) {
        if (e.provider_status === "PENDING" || e.provider_status === "FAILED") expect(e.outcome, `rodada ${round}`).toBe("ignored_after_paid");
      }
      expect(events).toHaveLength(sequences.flat().length);
    }
  }, 90_000);
});
