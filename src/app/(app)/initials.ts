/** Up to two letters from the first two words of a name, e.g. "Ada Lovelace" -> "AL". */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
