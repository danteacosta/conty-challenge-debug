import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { approvedCivilDay } from "../src/deadlines.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;

function setup(): App {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

async function postJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const approve = (app: App, mission_id: string, approved_at: string, idempotency_key: string) =>
  postJson(app, "/approvals", { mission_id, approved_at, idempotency_key });

async function mission(app: App, id: string) {
  const res = await app.request(`/missions/${id}`);
  return (await res.json()) as {
    ledger: Array<{ amount_brl: number }>;
    payout: { id: string; status: string; provider_status: string | null } | null;
  };
}

describe("dia do prazo em São Paulo (msn_1842, prazo 2026-03-12)", () => {
  it.each([
    ["o último milissegundo do dia em UTC-3", "2026-03-13T02:59:59.999Z", 201],
    ["o último instante escrito com o offset de São Paulo", "2026-03-12T23:59:59.999-03:00", 201],
    ["o início do dia do prazo", "2026-03-12T03:00:00.000Z", 201],
    ["um dia antes do prazo", "2026-03-11T15:00:00.000Z", 201],
    ["o primeiro instante do dia seguinte em UTC-3", "2026-03-13T03:00:00.000Z", 409],
    ["o primeiro instante do dia seguinte escrito com o offset", "2026-03-13T00:00:00.000-03:00", 409],
    ["vários dias depois", "2026-03-20T15:00:00.000Z", 409],
  ])("aprovação em %s: %s", async (_name, approvedAt, expected) => {
    const res = await approve(setup(), "msn_1842", approvedAt, "pay_deadline");
    expect(res.status).toBe(expected);
  });

  it("o dia civil muda à meia-noite de São Paulo, não à de UTC", () => {
    expect(approvedCivilDay("2026-03-13T02:59:59.999Z")).toBe("2026-03-12");
    expect(approvedCivilDay("2026-03-13T03:00:00.000Z")).toBe("2026-03-13");
    expect(approvedCivilDay("2026-03-12T02:59:59.999Z")).toBe("2026-03-11");
    expect(approvedCivilDay("2026-03-12T03:00:00.000Z")).toBe("2026-03-12");
    expect(approvedCivilDay("2026-03-12T23:59:59.999-03:00")).toBe("2026-03-12");
    expect(approvedCivilDay("2026-03-13T00:30:00-03:00")).toBe("2026-03-13");
    expect(approvedCivilDay("2026-12-31T23:30:00-03:00")).toBe("2026-12-31");
  });
});

describe("valor creditado em reais", () => {
  it.each([
    ["msn_1842", "2026-03-12T18:11:00.000Z", 150],
    ["msn_1900", "2026-03-12T18:11:00.000Z", 150],
    ["msn_2044", "2026-03-12T21:05:00.000Z", 80],
  ])("%s é creditada pelo valor combinado", async (id, approvedAt, reais) => {
    const app = setup();
    const res = await approve(app, id, approvedAt, `pay_${id}`);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { ledger: { amount_brl: number } }).ledger.amount_brl).toBe(reais);
    expect((await mission(app, id)).ledger.map((l) => l.amount_brl)).toEqual([reais]);
  });
});

describe("retry do provedor com a chave de idempotência suja (msn_2044, como no log)", () => {
  const APPROVED_AT = "2026-03-20T15:00:00.000Z";
  let app: App;
  beforeEach(() => {
    app = setup();
  });

  it.each([
    ["espaço de largura zero (U+200B) no fim, o caso da msn_2044 no log", "pay_7c1​"],
    ["espaço de largura zero no começo", "​pay_7c1"],
    ["espaço de largura zero no meio", "pay_​7c1"],
    ["marca de ordem de bytes (U+FEFF)", "﻿pay_7c1"],
    ["espaço comum no fim", "pay_7c1 "],
    ["espaço não separável (U+00A0)", "pay_7c1 "],
    ["tab e quebra de linha", "\tpay_7c1\n"],
    ["outra caixa", "PAY_7C1"],
  ])("não credita de novo com %s", async (_name, retryKey) => {
    const first = await approve(app, "msn_2044", APPROVED_AT, "pay_7c1");
    expect(first.status).toBe(201);
    const retry = await approve(app, "msn_2044", APPROVED_AT, retryKey);
    expect(retry.status).toBe(200);
    expect((await mission(app, "msn_2044")).ledger).toHaveLength(1);
  });

  it("o retry devolve o lançamento que já existia", async () => {
    const first = (await (await approve(app, "msn_2044", APPROVED_AT, "pay_7c1")).json()) as { ledger: { id: string } };
    const retry = (await (await approve(app, "msn_2044", APPROVED_AT, "pay_7c1​")).json()) as { ledger: { id: string } };
    expect(retry.ledger.id).toBe(first.ledger.id);
  });

  it("chave que só tem caracteres invisíveis é recusada, não vira uma chave vazia", async () => {
    expect((await approve(app, "msn_2044", APPROVED_AT, "​​")).status).toBe(400);
    expect((await approve(app, "msn_2044", APPROVED_AT, "   ")).status).toBe(400);
    expect((await mission(app, "msn_2044")).ledger).toHaveLength(0);
  });

  it("chaves realmente diferentes em missões diferentes continuam gerando um crédito cada", async () => {
    expect((await approve(app, "msn_2044", APPROVED_AT, "pay_7c1")).status).toBe(201);
    expect((await approve(app, "msn_1900", APPROVED_AT, "pay_22a")).status).toBe(201);
    expect((await mission(app, "msn_2044")).ledger).toHaveLength(1);
    expect((await mission(app, "msn_1900")).ledger).toHaveLength(1);
  });
});

describe("repasse enquanto o provedor ainda não confirmou", () => {
  let app: App;
  let payoutId: string;
  beforeEach(async () => {
    app = setup();
    const res = await approve(app, "msn_2044", "2026-03-20T15:00:00.000Z", "pay_provider");
    payoutId = ((await res.json()) as { payout: { id: string } }).payout.id;
  });

  const callback = async (provider_status: string) => {
    const res = await postJson(app, `/payouts/${payoutId}/provider`, { provider_status });
    return { status: res.status, body: (await res.json()) as { status?: string } };
  };

  it("PENDING deixa o repasse pendente também no que a API devolve depois", async () => {
    expect((await callback("PENDING")).body.status).toBe("pending");
    const seen = await mission(app, "msn_2044");
    expect(seen.payout).toMatchObject({ status: "pending", provider_status: "PENDING" });
  });

  it("PENDING e depois CONFIRMED quita", async () => {
    await callback("PENDING");
    expect((await callback("CONFIRMED")).body.status).toBe("paid");
    expect((await mission(app, "msn_2044")).payout?.status).toBe("paid");
  });

  it("a confirmação repetida pelo provedor continua paga", async () => {
    await callback("CONFIRMED");
    expect((await callback("CONFIRMED")).body.status).toBe("paid");
    expect((await callback("RECEIVED")).body.status).toBe("paid");
  });

  it("status que o provedor não documentou é recusado e não altera o repasse", async () => {
    expect((await callback("INVENTADO")).status).toBe(400);
    expect((await mission(app, "msn_2044")).payout?.status).toBe("pending");
  });
});

describe("jornada do incidente de 13 de março, mission a mission, como no log", () => {
  it("cada missão fica com um crédito, no valor certo, e o repasse pendente continua pendente", async () => {
    const app = setup();

    expect((await approve(app, "msn_1842", "2026-03-13T01:02:00.000Z", "pay_9f3")).status).toBe(201);

    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_22a")).status).toBe(201);
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_22a ")).status).toBe(200);
    const m1900 = await mission(app, "msn_1900");
    expect(m1900.payout).not.toBeNull();
    const pending = await postJson(app, `/payouts/${m1900.payout!.id}/provider`, { provider_status: "PENDING" });
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    expect((await approve(app, "msn_2044", "2026-03-12T21:05:00.000Z", "pay_7c1")).status).toBe(201);
    expect((await approve(app, "msn_2044", "2026-03-12T21:05:00.000Z", "pay_7c1​")).status).toBe(200);

    expect((await approve(app, "msn_missing", "2026-03-12T18:11:00.000Z", "pay_x")).status).toBe(404);

    expect((await mission(app, "msn_1842")).ledger.map((l) => l.amount_brl)).toEqual([150]);
    expect((await mission(app, "msn_1900")).ledger.map((l) => l.amount_brl)).toEqual([150]);
    expect((await mission(app, "msn_2044")).ledger.map((l) => l.amount_brl)).toEqual([80]);
    expect((await mission(app, "msn_1900")).payout?.status).toBe("pending");
  });
});
