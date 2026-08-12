/**
 * Coverage audit: every non-token card in every scraped set must either
 * (a) have a registered script, (b) be vanilla (empty/keyword-only text), or
 * (c) be on the documented exceptions list.
 * Run: npx tsx packages/engine/test/audit.ts  (also runnable as a vitest test)
 */
import { readFileSync, readdirSync } from "node:fs";
import { loadCards, getCardScript, extractKeywords, type ScrapedSet } from "../src/index.js";

const DIR = new URL("../../../tools/scraper/build/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.startsWith("cards_") && f.endsWith(".json"));
const sets = files.map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as ScrapedSet);
const cards = loadCards(...sets);

/** Documented exceptions: known data gaps / restrictions, tracked in docs. */
const EXCEPTIONS: Record<string, string> = {
  "lifeshaper-savant": "wiki data gap: attack/health unknown (tools/scraper/overrides.json)",
  "arcflight-squadron": "partial: extra-play restriction unsupported",
  "lucid-echoes": "", // implemented via player effects; keep here only if audit flags
};

function kwOnly(text: string): boolean {
  const stripped = text
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<br\s*\/?>/g, "")
    .replace(/[\s.\-–—]/g, "");
  return stripped === "";
}

const missing: { id: string; set: string; reason: string }[] = [];
let vanilla = 0;
let scripted = 0;
let exceptions = 0;

for (const set of sets) {
  for (const c of set.cards) {
    if (c.rarity === "Token") continue;
    const id = c.name.toLowerCase().replace(/['’,.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const def = cards[id];
    if (!def) {
      missing.push({ id, set: set.set, reason: "no CardDef (load failure)" });
      continue;
    }
    const trivial = def.levels.every((l) => kwOnly(l.text));
    if (trivial) {
      vanilla++;
      continue;
    }
    const script = getCardScript(id);
    if (script && (script.levels || script.spell || script.solbind || script.ambush)) {
      scripted++;
      continue;
    }
    if (EXCEPTIONS[id] !== undefined) {
      exceptions++;
      if (EXCEPTIONS[id]) console.log(`  [exception] ${id}: ${EXCEPTIONS[id]}`);
      continue;
    }
    missing.push({ id, set: set.set, reason: "non-trivial text but no script" });
  }
}

console.log(`\ncoverage: ${scripted} scripted, ${vanilla} vanilla/keyword-only, ${exceptions} documented exceptions`);
if (missing.length) {
  console.log(`\nMISSING (${missing.length}):`);
  for (const m of missing) console.log(`  ${m.id}  (${m.set})  ${m.reason}`);
  process.exit(1);
} else {
  console.log("ALL CARDS COVERED ✔");
}
