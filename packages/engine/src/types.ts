/** Core static data model (card definitions, as produced by the scraper). */

export type Faction = "Alloyin" | "Nekrium" | "Tempys" | "Uterra";
export type CardType = "Creature" | "Spell";
export type Rarity = "Common" | "Rare" | "Heroic" | "Legendary" | "Token";

export const KEYWORDS = [
  "Activate", "Aggressive", "Allied", "Ambush", "Armor", "Assault",
  "Breakthrough", "Consistent", "Defender", "Flank", "Forge", "Formation",
  "Free", "Mobility", "Negate", "Overload", "Poison", "Raid", "Regenerate",
  "Solbind", "Spawn", "Upgrade", "Vengeance",
] as const;
export type Keyword = (typeof KEYWORDS)[number];

export interface LevelDef {
  level: number;
  /** Raw rules text as scraped. */
  text: string;
  attack: number | null;
  health: number | null;
  /** Inherent keywords parsed from the text (see keywords.ts). */
  keywords?: import("./keywords.js").KeywordValue[];
}

export interface CardDef {
  /** Slug id derived from name, e.g. "alloyin-general". */
  id: string;
  name: string;
  faction: Faction;
  rarity: Rarity;
  set: string;
  types: CardType[];
  subtypes: string[];
  levels: LevelDef[];
  /** Image filenames, one per level (spells often have just one). */
  images: string[];
}

export function isCreature(def: CardDef): boolean {
  return def.types.includes("Creature");
}

/** Highest level a card can reach in play (2-level cards like Metasight exist). */
export function maxLevel(def: CardDef): number {
  return def.levels[def.levels.length - 1]?.level ?? 1;
}
