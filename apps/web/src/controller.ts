/**
 * Local game controller: owns the engine Game, applies human actions,
 * auto-plays the AI opponent (@solforge/ai), and auto-answers AI choices.
 * Also: deck presets, game configuration, save/load, saved custom decks.
 */
import {
  applyAction, applyChoice, createGame, loadCards, makeRng,
  type Game, type GameEvent, type ScrapedSet,
} from "@solforge/engine";
import { answerChoice, choiceOwner, chooseAction } from "@solforge/ai";
import set1 from "../../../tools/scraper/build/cards_Set_1.json" with { type: "json" };
import set15 from "../../../tools/scraper/build/cards_Set_1.5.json" with { type: "json" };
import set2 from "../../../tools/scraper/build/cards_Set_2.json" with { type: "json" };
import set21 from "../../../tools/scraper/build/cards_Set_2.1.json" with { type: "json" };
import set22 from "../../../tools/scraper/build/cards_Set_2.2.json" with { type: "json" };
import set23 from "../../../tools/scraper/build/cards_Set_2.3.json" with { type: "json" };
import set3 from "../../../tools/scraper/build/cards_Set_3.json" with { type: "json" };
import set31 from "../../../tools/scraper/build/cards_Set_3.1.json" with { type: "json" };
import set4 from "../../../tools/scraper/build/cards_Set_4.json" with { type: "json" };
import set41 from "../../../tools/scraper/build/cards_Set_4.1.json" with { type: "json" };
import set42 from "../../../tools/scraper/build/cards_Set_4.2.json" with { type: "json" };
import set5 from "../../../tools/scraper/build/cards_Set_5.json" with { type: "json" };
import set51 from "../../../tools/scraper/build/cards_Set_5.1.json" with { type: "json" };
import set52 from "../../../tools/scraper/build/cards_Set_5.2.json" with { type: "json" };
import set6 from "../../../tools/scraper/build/cards_Set_6.json" with { type: "json" };
import set61 from "../../../tools/scraper/build/cards_Set_6.1.json" with { type: "json" };
import set62 from "../../../tools/scraper/build/cards_Set_6.2.json" with { type: "json" };
import set7 from "../../../tools/scraper/build/cards_Set_7.json" with { type: "json" };
import set71 from "../../../tools/scraper/build/cards_Set_7.1.json" with { type: "json" };
import set72 from "../../../tools/scraper/build/cards_Set_7.2.json" with { type: "json" };
import set73 from "../../../tools/scraper/build/cards_Set_7.3.json" with { type: "json" };

export const CARDS = loadCards(
  set1 as ScrapedSet, set15 as ScrapedSet,
  set2 as ScrapedSet, set21 as ScrapedSet, set22 as ScrapedSet, set23 as ScrapedSet,
  set3 as ScrapedSet, set31 as ScrapedSet,
  set4 as ScrapedSet, set41 as ScrapedSet, set42 as ScrapedSet,
  set5 as ScrapedSet, set51 as ScrapedSet, set52 as ScrapedSet,
  set6 as ScrapedSet, set61 as ScrapedSet, set62 as ScrapedSet,
  set7 as ScrapedSet, set71 as ScrapedSet, set72 as ScrapedSet, set73 as ScrapedSet,
);

/** A starter-ish deck: 30 cards, legal (2 factions max, 3 copies max). */
export function starterDeck(ids: string[]): string[] {
  const deck: string[] = [];
  for (const id of ids) for (let i = 0; i < 3 && deck.length < 30; i++) deck.push(id);
  return deck.slice(0, 30);
}

export const DEFAULT_PLAYER_DECK = starterDeck([
  "cavern-hydra", "spring-dryad", "feral-instinct", "enrage", "grove-huntress",
  "deepbranch-ancient", "ether-hounds", "botanimate", "chrogias", "wildwood-sower",
]);
export const DEFAULT_AI_DECK = starterDeck([
  "ashurian-mystic", "cinderfist-brawler", "lightning-spark", "magma-hound",
  "firestorm", "everflame-phoenix", "uranti-bolt", "volcanic-giant",
  "flameblade-champion", "zyx-storm-herald",
]);

export function newGame(seed = Date.now() % 100000): Game {
  return createGame(CARDS, DEFAULT_PLAYER_DECK, DEFAULT_AI_DECK, seed);
}

// ---------- game configuration & presets ----------

export interface GameConfig {
  playerHealth: number;
  aiHealth: number;
  playerDeckId: string;
  aiDeckId: string;
  aiDifficulty: "easy" | "hard";
  aiSpeed: number; // ms per AI step
  seed: string;    // "" = random
}

/** Live-mutable UI settings (read by the AI driver each step). */
export const uiSettings = {
  aiDifficulty: "hard" as "easy" | "hard",
  aiSpeed: 900,
};

const FACTIONS = ["Alloyin", "Nekrium", "Tempys", "Uterra"] as const;

/** Deterministic preset deck: commons-first, 3 copies each, 30 cards. */
export function presetDeck(factions: string[], seed = 0): string[] {
  const pool = Object.values(CARDS)
    .filter((c) => c.rarity !== "Token" && factions.includes(c.faction)
      && c.levels.length >= 2 && c.levels.every((l) => l.attack !== null || c.types.includes("Spell")))
    .sort((a, b) => a.rarity.localeCompare(b.rarity) || a.name.localeCompare(b.name));
  const rng = makeRng(seed || 42);
  const deck: string[] = [];
  for (const c of pool) {
    for (let i = 0; i < 3 && deck.length < 30; i++) deck.push(c.id);
    if (deck.length >= 30) break;
  }
  while (deck.length < 30 && pool.length) deck.push(pool[0]!.id);
  return rng.shuffle(deck);
}

/** Random legal deck: two random factions, <=3 copies. */
export function randomDeck(seed: number): string[] {
  const rng = makeRng(seed);
  const picked = [FACTIONS[rng.int(4)]!, FACTIONS[rng.int(4)]!];
  const pool = Object.values(CARDS).filter(
    (c) => c.rarity !== "Token" && picked.includes(c.faction as never)
      && c.levels.length >= 2 && c.levels.every((l) => l.attack !== null || c.types.includes("Spell")),
  );
  const deck: string[] = [];
  const counts = new Map<string, number>();
  let guard = 5000;
  while (deck.length < 30 && guard-- > 0) {
    const c = pool[rng.int(pool.length)]!;
    const n = counts.get(c.id) ?? 0;
    if (n >= 3) continue;
    counts.set(c.id, n + 1);
    deck.push(c.id);
  }
  return deck;
}

export interface DeckOption { id: string; label: string; build: (seed: number) => string[]; }

export const DECK_OPTIONS: DeckOption[] = [
  { id: "uterra", label: "Uterra 自然（预设）", build: (s) => presetDeck(["Uterra"], s) },
  { id: "tempys", label: "Tempys 元素（预设）", build: (s) => presetDeck(["Tempys"], s) },
  { id: "alloyin", label: "Alloyin 机械（预设）", build: (s) => presetDeck(["Alloyin"], s) },
  { id: "nekrium", label: "Nekrium 死亡（预设）", build: (s) => presetDeck(["Nekrium"], s) },
  { id: "alloyin-uterra", label: "Alloyin+Uterra（预设）", build: (s) => presetDeck(["Alloyin", "Uterra"], s) },
  { id: "nekrium-tempys", label: "Nekrium+Tempys（预设）", build: (s) => presetDeck(["Nekrium", "Tempys"], s) },
  { id: "random", label: "随机牌组", build: (s) => randomDeck(s) },
];

// ---------- saved custom decks (from the deck builder) ----------

export interface SavedDeck { name: string; cards: string[]; }

const DECKS_KEY = "solforge-clone-decks-v1";

export function loadSavedDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(DECKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is SavedDeck => d && typeof d.name === "string" && Array.isArray(d.cards),
    );
  } catch {
    return [];
  }
}

export function storeSavedDecks(decks: SavedDeck[]): boolean {
  try {
    localStorage.setItem(DECKS_KEY, JSON.stringify(decks));
    return true;
  } catch {
    return false;
  }
}

/** Preset options followed by "自定义：{name}" entries from the deck builder. */
export function getDeckOptions(): DeckOption[] {
  const customs: DeckOption[] = loadSavedDecks().map((d) => ({
    id: `custom:${d.name}`,
    label: `自定义：${d.name}`,
    build: () => {
      const valid = d.cards.filter((id) => CARDS[id] && CARDS[id]!.rarity !== "Token");
      return valid.length >= 30 ? valid.slice(0, 30) : presetDeck(["Uterra"], 0);
    },
  }));
  return [...DECK_OPTIONS, ...customs];
}

export function buildDeck(id: string, seed: number): string[] {
  return (getDeckOptions().find((d) => d.id === id) ?? DECK_OPTIONS[0]!).build(seed);
}

export function newGameWith(cfg: GameConfig): Game {
  const seed = cfg.seed ? Number(cfg.seed) || hashStr(cfg.seed) : Date.now() % 1000000;
  return createGame(CARDS, buildDeck(cfg.playerDeckId, seed), buildDeck(cfg.aiDeckId, seed + 1), seed, {
    startingHealth: [cfg.playerHealth, cfg.aiHealth],
  });
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------- save / load ----------

const SAVE_KEY = "solforge-clone-save-v1";

export function saveGame(game: Game): boolean {
  try {
    const state = { ...game.state, cards: undefined };
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): Game | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    state.cards = CARDS;
    return { state, rng: makeRng(Date.now() % 100000) };
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

// ---------- AI driving ----------

/** Run the AI turn until control returns to the human (or a human choice is needed). */
export function runAiUntilHuman(game: Game, human: 0 | 1, log: GameEvent[]): void {
  let guard = 500;
  while (game.state.phase !== "gameOver" && guard-- > 0) {
    const step = stepAi(game, human);
    if (step.done) return;
    log.push(...step.events);
  }
}

/**
 * Perform exactly ONE AI step (one action or one choice answer).
 * Drives the animated, step-by-step AI turn in the UI.
 */
export function stepAi(game: Game, human: 0 | 1): { events: GameEvent[]; done: boolean } {
  if (game.state.phase === "gameOver") return { events: [], done: true };
  if (game.state.pending) {
    const owner = choiceOwner(game);
    if (owner === human) return { events: [], done: true }; // wait for human input
    return { events: applyChoice(game, answerChoice(game, owner)), done: false };
  }
  if (game.state.active === human) return { events: [], done: true };
  return { events: applyAction(game, chooseAction(game, game.state.active, uiSettings.aiDifficulty)), done: false };
}
