/**
 * `approved_at` estrito. Aceita ISO-8601 com data e hora (`YYYY-MM-DDTHH:mm[:ss[.fff]]`) e com `Z` ou offset `±HH:MM`.
 * Só devolve um instante se a data existe no calendário (30 de fevereiro, mês 13, hora 24 e segundo 60 são recusados), e não
 * deixa o `Date` "consertar" entradas por extenso ou em outro formato.
 *
 * Sem offset, o texto é horário CIVIL de America/Sao_Paulo (o mesmo fuso do prazo), e não o fuso do servidor: a mesma entrada
 * dá o mesmo instante em qualquer máquina. Isso é uma escolha de compatibilidade: clientes que mandavam "2026-03-12T23:59:59" já
 * esperavam o horário da marca.
 */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const CIVIL_ZONE = "America/Sao_Paulo";
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: CIVIL_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** `Date.UTC` com o ano LITERAL: o `Date.UTC` puro trata anos de 0 a 99 como 1900 a 1999. */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millis = 0): number {
  const date = new Date(Date.UTC(2000, month, day, hour, minute, second, millis));
  date.setUTCFullYear(year);
  return date.getTime();
}

/** Quanto o relógio civil de São Paulo está à frente do UTC, em ms, num instante (negativo em UTC−3). */
function zoneOffsetMs(instant: number): number {
  const p = Object.fromEntries(parts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const asUtc = utcMs(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function parseApprovedAt(input: string): Date | null {
  const match = SHAPE.exec(input);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  const millis = Number(frac.slice(0, 3).padEnd(3, "0")); // mais de 3 dígitos (microssegundos, nanossegundos) são truncados
  // O ano é lido literalmente. O contrato não fixa um piso ou um teto de negócio, então a única recusa é a de representação:
  // ano 0000 (o ISO usado aqui começa em 0001) e, mais abaixo, o instante que não cabe em 4 dígitos depois de ir para UTC.
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const civil = utcMs(year, month - 1, day, hour, minute, second, millis);
  if (new Date(civil).getUTCDate() !== day || new Date(civil).getUTCMonth() !== month - 1) return null; // o dia não existe neste mês (30 de fevereiro, 29 em ano não bissexto)

  const fits = (instant: number) => {
    const y = new Date(instant).getUTCFullYear();
    return y >= MIN_YEAR && y <= MAX_YEAR;
  };
  if (zone === "Z") return new Date(civil);
  if (zone !== undefined) {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const shifted = civil - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
    return fits(shifted) ? new Date(shifted) : null;
  }
  // Sem offset: resolve o horário civil de São Paulo para o instante. Duas passadas cobrem a troca de horário de verão histórica.
  let instant = civil - zoneOffsetMs(civil);
  instant = civil - zoneOffsetMs(instant);
  // Um horário civil que não existe (o relógio pulou, no início do horário de verão) não é "consertado" para o dia anterior:
  // o instante resolvido tem de voltar ao mesmo horário civil digitado, senão é recusado.
  if (zoneOffsetMs(instant) + instant !== civil || !fits(instant)) return null;
  return new Date(instant);
}
