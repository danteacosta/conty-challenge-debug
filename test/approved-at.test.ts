import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { parseApprovedAt } from "../src/approved-at.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;
const post = (app: App, body: unknown) => app.request("/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function fresh() {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return { db, app: createApp(db) };
}

describe("datas impossíveis são 400 e não têm nenhum efeito", () => {
  it.each([
    ["30 de fevereiro", "2026-02-30T10:00:00.000Z"],
    ["29 de fevereiro de ano não bissexto", "2026-02-29T10:00:00-03:00"],
    ["mês 13", "2026-13-01T10:00:00Z"],
    ["dia 32", "2026-03-32T10:00:00Z"],
    ["hora 24", "2026-03-12T24:00:00Z"],
    ["minuto 61", "2026-03-12T10:61:00Z"],
    ["segundo 60", "2026-03-12T10:00:60Z"],
    ["offset fora do intervalo", "2026-03-12T10:00:00+25:00"],
    ["só a data", "2026-03-12"],
    ["formato por extenso que o Date aceitaria", "March 12, 2026 10:00:00"],
    ["formato brasileiro", "12/03/2026 10:00"],
    ["texto", "ontem"],
  ])("%s: %s", async (_name, approved_at) => {
    const { db, app } = fresh();
    const res = await post(app, { mission_id: "msn_1900", approved_at, idempotency_key: "k1" });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM payouts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status FROM missions WHERE id = 'msn_1900'").get()).toEqual({ status: "open" });
  });

  it("29 de fevereiro de ano bissexto vale", () => {
    expect(parseApprovedAt("2028-02-29T10:00:00Z")?.toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(parseApprovedAt("2026-02-29T10:00:00Z")).toBeNull();
  });
});

describe("entrada sem offset é horário civil de America/Sao_Paulo, em qualquer fuso do processo", () => {
  it.each([
    ["o último instante do dia do prazo", "2026-03-12T23:59:59.999", 201],
    ["um minuto do dia seguinte", "2026-03-13T00:00:00", 409],
    ["o começo do dia do prazo", "2026-03-12T00:00:00", 201],
  ])("%s (%s) → %i", async (_name, approved_at, expected) => {
    const { app } = fresh();
    const res = await post(app, { mission_id: "msn_1842", approved_at, idempotency_key: "k1" });
    expect(res.status).toBe(expected);
  });

  it("converte para o instante UTC (UTC−3) e aceita segundos e milissegundos opcionais", () => {
    expect(parseApprovedAt("2026-03-12T23:59:59.999")?.toISOString()).toBe("2026-03-13T02:59:59.999Z");
    expect(parseApprovedAt("2026-03-12T10:30")?.toISOString()).toBe("2026-03-12T13:30:00.000Z");
    expect(parseApprovedAt("2026-03-12T10:30:15")?.toISOString()).toBe("2026-03-12T13:30:15.000Z");
  });

  it("com offset ou Z escritos, o offset vale e o fuso de São Paulo não interfere", () => {
    expect(parseApprovedAt("2026-03-12T23:59:59.999-03:00")?.toISOString()).toBe("2026-03-13T02:59:59.999Z");
    expect(parseApprovedAt("2026-03-13T02:59:59.999Z")?.toISOString()).toBe("2026-03-13T02:59:59.999Z");
    expect(parseApprovedAt("2026-03-12T10:00:00+05:30")?.toISOString()).toBe("2026-03-12T04:30:00.000Z");
  });

  it("a mesma entrada dá o mesmo instante em processos com fusos diferentes", () => {
    const module = new URL("../src/approved-at.ts", import.meta.url).href;
    const script = `import { parseApprovedAt } from ${JSON.stringify(module)};
      const inputs = ["2026-03-12T23:59:59.999", "2026-03-13T00:00:00", "2026-06-15T12:00:00", "2026-03-12T23:59:59.999-03:00"];
      console.log(JSON.stringify(inputs.map((i) => parseApprovedAt(i)?.toISOString())));`;
    const outputs = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "America/Sao_Paulo"].map((tz) =>
      execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim(),
    );
    expect(new Set(outputs).size).toBe(1);
    expect(JSON.parse(outputs[0]!)).toEqual(["2026-03-13T02:59:59.999Z", "2026-03-13T03:00:00.000Z", "2026-06-15T15:00:00.000Z", "2026-03-13T02:59:59.999Z"]);
  });
});
