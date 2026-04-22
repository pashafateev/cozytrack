/**
 * Heuristic to detect built-in/internal microphones from their label.
 * Case-insensitive keyword match — easy to extend.
 */
const BUILTIN_KEYWORDS = ["built-in", "internal", "macbook", "default"];

export function isBuiltInMic(label: string): boolean {
  const lower = label.toLowerCase();
  return BUILTIN_KEYWORDS.some((kw) => lower.includes(kw));
}
