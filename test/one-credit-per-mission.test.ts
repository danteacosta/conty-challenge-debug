import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";
import { tsWorker } from "./spawn-worker.ts";

type App = ReturnType<typeof createApp>;

const APPROVED_AT = "2026-03-12T18:11:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "repasses-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function setupWithDb(db = openDatabase(":memory:")) {
  seedIncident(db);
  return { db, app: createApp(db) };
}

const approve = (app: App, mission_id: string, idempotency_key: string) =>
  app.request("/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mission_id, approved_at: APPROVED_AT, idempotency_key }),
  });

async function mission(app: App, id: string) {
  const res = await app.request(`/missions/${id}`);
  return (await res.json()) as {
    mission: { status: string };
    ledger: Array<{ id: string; amount_brl: number; idempotency_key: string }>;
    payout: { id: string } | null;
  };
}

describe("a missão é paga uma vez, qualquer que seja a chave", () => {
  it("duas aprovações da mesma missão com chaves diferentes deixam um lançamento só e devolvem o original", async () => {
    const { app } = setupWithDb();
    const first = await approve(app, "msn_1900", "audit-a");
    const second = await approve(app, "msn_1900", "audit-b");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as { ledger: { id: string; idempotency_key: string } };
    const secondBody = (await second.json()) as { ledger: { id: string; idempotency_key: string }; payout: { id: string } | null };
    expect(secondBody.ledger.id).toBe(firstBody.ledger.id);
    expect(secondBody.ledger.idempotency_key).toBe("audit-a");
    expect(secondBody.payout).not.toBeNull();
    expect((await mission(app, "msn_1900")).ledger).toHaveLength(1);
  });

  it("muitas chaves diferentes para a mesma missão continuam sendo um crédito só", async () => {
    const { app } = setupWithDb();
    const statuses = [];
    for (const key of ["k1", "k2", "k3", "k4", "K1", "k1 "]) statuses.push((await approve(app, "msn_1900", key)).status);
    expect(statuses).toEqual([201, 200, 200, 200, 200, 200]);
    expect((await mission(app, "msn_1900")).ledger).toHaveLength(1);
  });

  it("o mesmo repasse é reaproveitado: a missão não ganha um segundo repasse", async () => {
    const { app, db } = setupWithDb();
    await approve(app, "msn_1900", "audit-a");
    await approve(app, "msn_1900", "audit-b");
    expect(db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE mission_id = 'msn_1900'").get()).toEqual({ n: 1 });
  });
});

describe("a chave de idempotência vale dentro da missão, não entre missões", () => {
  it("a mesma chave em duas missões credita cada uma pelo seu valor, sem devolver o ledger da outra", async () => {
    const { app } = setupWithDb();
    const a = await approve(app, "msn_1900", "audit-a");
    const b = await approve(app, "msn_2044", "audit-a");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const bBody = (await b.json()) as { mission_id: string; status: string; ledger: { mission_id: string; amount_brl: number }; payout: { mission_id: string } | null };
    expect(bBody).toMatchObject({ mission_id: "msn_2044", status: "approved", ledger: { mission_id: "msn_2044", amount_brl: 80 } });
    expect(bBody.payout).toMatchObject({ mission_id: "msn_2044" });

    expect((await mission(app, "msn_1900")).ledger.map((l) => l.amount_brl)).toEqual([150]);
    expect((await mission(app, "msn_2044")).ledger.map((l) => l.amount_brl)).toEqual([80]);
  });

  it("o retry da mesma chave na mesma missão continua devolvendo o próprio lançamento", async () => {
    const { app } = setupWithDb();
    await approve(app, "msn_1900", "audit-a");
    await approve(app, "msn_2044", "audit-a");
    const retry = await approve(app, "msn_2044", "audit-a");
    const body = (await retry.json()) as { ledger: { mission_id: string; amount_brl: number } };
    expect(retry.status).toBe(200);
    expect(body.ledger).toMatchObject({ mission_id: "msn_2044", amount_brl: 80 });
  });
});

describe("atomicidade", () => {
  it("se o repasse falha no meio, nada fica gravado: sem crédito sem repasse e a missão continua aberta", async () => {
    const { app, db } = setupWithDb();
    db.exec("CREATE TRIGGER falha_repasse BEFORE INSERT ON payouts BEGIN SELECT RAISE(ABORT, 'repasse indisponível'); END;");
    const failed = await approve(app, "msn_1900", "audit-a");
    expect(failed.status).toBe(500);
    expect((await mission(app, "msn_1900")).ledger).toHaveLength(0);
    expect((await mission(app, "msn_1900")).mission.status).toBe("open");

    db.exec("DROP TRIGGER falha_repasse");
    const retry = await approve(app, "msn_1900", "audit-a");
    expect(retry.status).toBe(201);
    const after = await mission(app, "msn_1900");
    expect(after.ledger).toHaveLength(1);
    expect(after.payout).not.toBeNull();
  });
});

describe("restrição de unicidade no banco", () => {
  it("o banco recusa um segundo lançamento para a mesma missão, mesmo fora da API", () => {
    const { db } = setupWithDb();
    const insert = db.prepare("INSERT INTO ledger (id, mission_id, idempotency_key, amount_brl, created_at) VALUES (?, 'msn_1900', ?, 150, 'x')");
    insert.run("led_1", "a");
    expect(() => insert.run("led_2", "b")).toThrow(/UNIQUE/i);
  });

  it("banco com duplicados históricos abre sem erro, avisa e não altera nenhuma linha", async () => {
    const path = join(dir, "historico.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, deadline_date TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE ledger (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, amount_brl REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE payouts (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL UNIQUE, provider_status TEXT, status TEXT NOT NULL);
      INSERT INTO missions VALUES ('msn_1900', 'crt_bruno', 15000, '2026-03-20', 'approved');
      INSERT INTO ledger VALUES ('led_1', 'msn_1900', 'pay_22a', 1.5, '2026-03-13T01:11:02.040Z');
      INSERT INTO ledger VALUES ('led_2', 'msn_1900', 'pay_22a ', 1.5, '2026-03-13T01:11:09.130Z');
    `);
    old.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openDatabase(path);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/1 missão/);
    expect(db.prepare("SELECT id, amount_brl FROM ledger ORDER BY id").all()).toEqual([
      { id: "led_1", amount_brl: 1.5 },
      { id: "led_2", amount_brl: 1.5 },
    ]);

    // a guarda da API segue valendo sem a restrição: nova aprovação não cria um terceiro lançamento
    const res = await approve(createApp(db), "msn_1900", "outra-chave");
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 2 });
  });
});

describe("concorrência: várias conexões ao mesmo arquivo", () => {
  /** Sobe os workers, espera todos prontos na barreira e libera a largada de uma vez. */
  async function race(path: string, missionId: string, keysPerWorker: string[][]) {
    const barrier = new SharedArrayBuffer(8);
    const flags = new Int32Array(barrier);
    const done = keysPerWorker.map(
      (keys) =>
        new Promise<number[]>((resolve, reject) => {
          const w = tsWorker(new URL("./credit-worker.ts", import.meta.url), { path, missionId, keys, barrier });
          w.once("message", resolve);
          w.once("error", reject);
        }),
    );
    while (Atomics.load(flags, 1) < keysPerWorker.length) await new Promise((resolve) => setTimeout(resolve, 5));
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    return (await Promise.all(done)).flat();
  }

  function freshDb(name: string) {
    const path = join(dir, name);
    const db = openDatabase(path);
    seedIncident(db);
    db.close();
    return path;
  }

  it("4 conexões aprovando a mesma missão com chaves diferentes, largando juntas, 12 vezes em bancos novos: sempre um 201 e um lançamento", async () => {
    for (let round = 0; round < 12; round += 1) {
      const path = freshDb(`corrida-${round}.sqlite`);
      const statuses = await race(path, "msn_1900", [0, 1, 2, 3].map((w) => [`w${w}-a`, `w${w}-b`]));

      expect(statuses.filter((s) => s === 201), `rodada ${round}: ${statuses}`).toHaveLength(1);
      expect(statuses.filter((s) => s === 200), `rodada ${round}: ${statuses}`).toHaveLength(7);
      const check = openDatabase(path);
      expect(check.prepare("SELECT COUNT(*) AS n FROM ledger WHERE mission_id = 'msn_1900'").get()).toEqual({ n: 1 });
      expect(check.prepare("SELECT COUNT(*) AS n FROM payouts WHERE mission_id = 'msn_1900'").get()).toEqual({ n: 1 });
      check.close();
    }
  }, 60_000);

  it("a mesma chave repetida por várias conexões, largando juntas, também credita uma vez só", async () => {
    const path = freshDb("corrida-mesma-chave.sqlite");
    const statuses = await race(path, "msn_2044", Array.from({ length: 4 }, () => ["mesma", "mesma"]));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    expect(openDatabase(path).prepare("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 1 });
  }, 30_000);
});
