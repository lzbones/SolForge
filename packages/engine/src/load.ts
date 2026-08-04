/** Convert scraper output (tools/scraper/build/cards_*.json) into CardDefs. */
import type { CardDef, Faction, Rarity } from "./types.js";
import { extractKeywords } from "./keywords.js";

export interface ScrapedLevel { level: number; text: string; attack: string; health: string; }
export interface ScrapedCard {
  name: string; faction: string; rarity: string; set: string;
  types: string[]; subtypes: string[]; images: string[];
  levels: ScrapedLevel[];
}
export interface ScrapedSet { set: string; count: number; skipped: string[]; cards: ScrapedCard[]; }

export function slugify(name: string): string {
  return name.toLowerCase().replace(/['’,.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function loadCards(...sets: ScrapedSet[]): Record<string, CardDef> {
  const out: Record<string, CardDef> = {};
  for (const set of sets) {
    for (const c of set.cards) {
      const id = slugify(c.name);
      if (out[id]) throw new Error(`duplicate card id: ${id}`);
      out[id] = {
        id,
        name: c.name,
        faction: c.faction as Faction,
        rarity: c.rarity as Rarity,
        set: c.set,
        types: c.types as CardDef["types"],
        subtypes: c.subtypes,
        images: c.images,
        levels: c.levels.map((l) => ({
          level: l.level,
          text: l.text,
          attack: l.attack === "" ? null : Number(l.attack),
          health: l.health === "" ? null : Number(l.health),
          keywords: extractKeywords(l.text),
        })),
      };
    }
  }
  return out;
}
