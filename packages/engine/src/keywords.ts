/**
 * Keyword extraction from raw scraped rules text.
 *
 * Raw text uses wiki templates: {{Forge}}, {{Armor|1}}, {{cardtt|Name}}, <br>.
 * Inherent keywords appear at the start of the text (one per line / template);
 * keywords that are *granted to other creatures* appear inside sentences and
 * must NOT be extracted as inherent.
 */
import { KEYWORDS, type Keyword } from "./types.js";
import type { KeywordValue } from "./state.js";
export type { KeywordValue } from "./state.js";

/**
 * Extract inherent keywords: template occurrences that appear before the first
 * plain sentence (i.e. in the "keyword block" at the top of the text).
 * Examples:
 *   "{{Regenerate|1}}"                              -> Regenerate 1
 *   "{{Mobility|1}}<br>\n{{Flank}}: Destroy..."     -> Mobility 1 (Flank is a trigger, kept as keyword too)
 *   "{{Aggressive}}<br>\nWhen Ashurian Mystic..."   -> Aggressive
 */
export function extractKeywords(text: string): KeywordValue[] {
  const out: KeywordValue[] = [];
  // Work through the leading run of templates, allowing <br>, whitespace and
  // stray punctuation (e.g. "{{Free}}. <br>{{Aggressive}}") between them.
  let rest = text.trim();
  while (rest.length) {
    const m = rest.match(/^\{\{(\w+)(?:\|([^}]*))?\}\}/);
    if (!m) break;
    const [, name, arg] = m;
    const canonical = KEYWORDS.find((k) => k.toLowerCase() === name!.toLowerCase());
    if (canonical) {
      out.push({ keyword: canonical, value: arg ? Number(arg) || 0 : 0 });
    }
    rest = rest.slice(m[0].length);
    if (rest.startsWith(":")) break; // trigger prefix (Forge:, Vengeance:, ...)
    rest = rest.replace(/^[\s.,;]*(<br\s*\/?>)?[\s]*/, "");
  }
  return dedupe(out);
}

/** All trigger-prefix keywords present anywhere at a line start (Forge:, Vengeance:, ...). */
export function extractTriggerPrefixes(text: string): Keyword[] {
  const out: Keyword[] = [];
  for (const m of text.matchAll(/\{\{(\w+)(?:\|[^}]*)?\}\}\s*:/g)) {
    const canonical = KEYWORDS.find((k) => k.toLowerCase() === m[1]!.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return dedupe(out.map((keyword) => ({ keyword, value: 0 }))).map((k) => k.keyword);
}

/** Strip wiki templates for display: {{Armor|1}} -> Armor 1, {{cardtt|X|Y}} -> Y. */
export function displayText(text: string): string {
  return text
    .replace(/\{\{cardtt\|([^}|]*)\|([^}]*)\}\}/g, "$2")
    .replace(/\{\{cardtt\|([^}]*)\}\}/g, "$1")
    .replace(/\{\{(\w+)\|([^}]*)\}\}/g, "$1 $2")
    .replace(/\{\{(\w+)\}\}/g, "$1")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function dedupe(kws: KeywordValue[]): KeywordValue[] {
  const seen = new Map<Keyword, number>();
  for (const k of kws) seen.set(k.keyword, Math.max(seen.get(k.keyword) ?? 0, k.value));
  return [...seen.entries()].map(([keyword, value]) => ({ keyword, value }));
}
