/**
 * `approved_at` estrito. Aceita ISO-8601 com data e hora (`YYYY-MM-DDTHH:mm[:ss[.fff]]`) e com `Z` ou offset `±HH:MM`.
 * Só devolve um instante se a data existe no calendário (30 de fevereiro, mês 13, hora 24 e segundo 60 são recusados), e não
 * deixa o `Date` "consertar" entradas por extenso ou em outro formato.
 *
 * Sem offset, o texto é horário CIVIL de America/Sao_Paulo (o mesmo fuso do prazo), e não o fuso do servidor: a mesma entrada
 * dá o mesmo instante em qualquer máquina. Isso é uma escolha de compatibilidade: clientes que mandavam "2026-03-12T23:59:59" já
 * esperavam o horário da marca.
 */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const CIVIL_ZONE = "America/Sao_Paulo";

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

/** Quanto o relógio civil de São Paulo está à frente do UTC, em ms, num instante (negativo em UTC−3). */
function zoneOffsetMs(instant: number): number {
  const p = Object.fromEntries(parts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function parseApprovedAt(input: string): Date | null {
  const match = SHAPE.exec(input);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  const millis = Number(frac.padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const civil = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (new Date(civil).getUTCDate() !== day) return null; // o dia não existe neste mês (30 de fevereiro, 29 em ano não bissexto)

  if (zone === "Z") return new Date(civil);
  if (zone !== undefined) {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    return new Date(civil - sign * (offsetHours * 60 + offsetMinutes) * 60_000);
  }
  // Sem offset: resolve o horário civil de São Paulo para o instante. Duas passadas cobrem a troca de horário de verão histórica.
  let instant = civil - zoneOffsetMs(civil);
  instant = civil - zoneOffsetMs(instant);
  return new Date(instant);
}
