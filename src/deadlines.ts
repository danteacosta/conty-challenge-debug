// O prazo é um dia civil em America/Sao_Paulo (o último instante desse dia ainda vale), não o dia em UTC.
const PRAZO_FUSO = "America/Sao_Paulo";

const diaCivil = new Intl.DateTimeFormat("en-CA", {
  timeZone: PRAZO_FUSO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function approvedCivilDay(approvedAt: string): string {
  const parts = Object.fromEntries(diaCivil.formatToParts(new Date(approvedAt)).map((part) => [part.type, part.value]));
  // O ano com 4 dígitos: a comparação com o prazo é de texto, e "99-06-15" > "2026-03-12" daria prazo encerrado para o ano 99.
  return `${String(parts.year).padStart(4, "0")}-${parts.month}-${parts.day}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
