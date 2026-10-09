// A chave que o provedor reenvia no retry chega com sujeira que não muda o sentido: espaços nas pontas e
// caracteres invisíveis de formatação (como o espaço de largura zero U+200B), que trim() não remove.
export function normalizeKey(key: string): string {
  return key.replace(/\p{Cf}/gu, "").trim().toLowerCase();
}
