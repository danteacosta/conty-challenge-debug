import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { parseApprovedAt } from "../src/approved-at.ts";
import { openDatabase } from "../src/db.ts";
import { approvedCivilDay } from "../src/deadlines.ts";
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

  it("o ano é lido literalmente: 0099 é o ano 99, não 1999 (Date.UTC trataria como 1900+), e não há piso de negócio no contrato", () => {
    expect(parseApprovedAt("0099-01-01T00:00:00Z")?.toISOString()).toBe("0099-01-01T00:00:00.000Z");
    expect(parseApprovedAt("0001-06-15T12:00:00Z")?.toISOString()).toBe("0001-06-15T12:00:00.000Z");
    expect(parseApprovedAt("1969-12-31T23:59:59Z")?.toISOString()).toBe("1969-12-31T23:59:59.000Z");
    expect(parseApprovedAt("0000-01-01T00:00:00Z")).toBeNull(); // o ano 0000 não existe no calendário ISO usado aqui (começa em 0001)
  });

  it.each([
    ["ano 9999 sem offset (em UTC vira o ano 10000)", "9999-12-31T23:59:59"],
    ["ano 9999 com offset negativo", "9999-12-31T23:59:59-03:00"],
    ["ano 0001 com offset positivo (em UTC vira o ano 0)", "0001-01-01T00:30:00+01:00"],
  ])("só o que não cabe no ISO de 4 dígitos depois da conversão para UTC é recusado: %s", (_name, input) => {
    expect(parseApprovedAt(input)).toBeNull();
  });
  it("anos de 0001 a 0099 também valem SEM offset (horário civil de São Paulo, com o LMT da época)", () => {
    expect(parseApprovedAt("0001-06-15T12:00:00")?.toISOString()).toBe("0001-06-15T15:06:28.000Z");
    expect(parseApprovedAt("0099-06-15T12:00:00")?.toISOString()).toBe("0099-06-15T15:06:28.000Z");
    expect(parseApprovedAt("0004-02-29T12:00:00")?.toISOString()).toBe("0004-02-29T15:06:28.000Z"); // bissexto
    expect(parseApprovedAt("0100-06-15T12:00:00")?.toISOString()).toBe("0100-06-15T15:06:28.000Z");
    expect(parseApprovedAt("0099-02-29T12:00:00")).toBeNull();
  });

  it("o último instante que cabe em 4 dígitos vale", () => {
    expect(parseApprovedAt("9999-12-31T23:59:59Z")?.toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(parseApprovedAt("9999-12-31T23:59:59+03:00")?.toISOString()).toBe("9999-12-31T20:59:59.000Z");
  });

  it("hora civil que não existe em São Paulo (pulo do horário de verão) é recusada, em vez de cair no dia anterior", () => {
    expect(parseApprovedAt("2018-11-04T00:30:00")).toBeNull(); // o relógio foi de 00:00 para 01:00
    expect(parseApprovedAt("2018-11-04T01:00:00")?.toISOString()).toBe("2018-11-04T03:00:00.000Z"); // já existe
    expect(parseApprovedAt("2018-11-03T23:59:59")?.toISOString()).toBe("2018-11-04T02:59:59.000Z"); // ainda UTC−3: o horário de verão começa à meia-noite
    // com offset escrito a hora é um instante real e vale
    expect(parseApprovedAt("2018-11-04T00:30:00-03:00")?.toISOString()).toBe("2018-11-04T03:30:00.000Z");
  });

  it("o horário ambíguo (a hora que se repete na volta do horário de verão) resolve de forma determinística, no mesmo dia civil", () => {
    expect(parseApprovedAt("2019-02-16T23:30:00")?.toISOString()).toBe("2019-02-17T01:30:00.000Z");
  });

  it("fração com mais de 3 dígitos (Python, Go, Java) é aceita e truncada para milissegundos", () => {
    expect(parseApprovedAt("2026-03-12T10:00:00.123456+00:00")?.toISOString()).toBe("2026-03-12T10:00:00.123Z");
    expect(parseApprovedAt("2026-03-12T10:00:00.123456789Z")?.toISOString()).toBe("2026-03-12T10:00:00.123Z");
    expect(parseApprovedAt("2026-03-12T10:00:00.5Z")?.toISOString()).toBe("2026-03-12T10:00:00.500Z");
    expect(parseApprovedAt("2026-03-12T10:00:00.1234567890Z")).toBeNull(); // 10 dígitos: fora do que algum cliente manda
  });

  it("29 de fevereiro de ano bissexto vale", () => {
    expect(parseApprovedAt("2028-02-29T10:00:00Z")?.toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(parseApprovedAt("2026-02-29T10:00:00Z")).toBeNull();
  });
});

describe("o dia civil do prazo tem sempre 4 dígitos de ano", () => {
  it.each([
    ["0001-06-15T12:00:00Z", "0001-06-15"],
    ["0099-06-15T12:00:00Z", "0099-06-15"],
    ["0203-06-15T12:00:00Z", "0203-06-15"],
    ["0999-12-31T12:00:00Z", "0999-12-31"],
    ["2026-03-12T12:00:00Z", "2026-03-12"],
  ])("%s → %s", (input, expected) => {
    expect(approvedCivilDay(input)).toBe(expected);
  });

  it.each(["0001-06-15T12:00:00Z", "0099-06-15T12:00:00Z", "0203-06-15T12:00:00Z", "0500-06-15T12:00:00Z", "0999-06-15T12:00:00Z", "1000-06-15T12:00:00Z"])(
    "uma aprovação em %s é anterior ao prazo de 2026 e é aceita (antes comparava texto sem zero à esquerda e dava 409)",
    async (approved_at) => {
      const { app } = fresh();
      const res = await post(app, { mission_id: "msn_1842", approved_at, idempotency_key: "k1" });
      expect(res.status).toBe(201);
    },
  );
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
