import { describe, expect, it } from "vitest";
import {
  applyAction, createGame, legalActions, loadCards, slugify,
  type CardDef, type ScrapedSet,
} from "../src/index.js";

// --- minimal fake card set for unit tests ---
function creature(id: string, attack: number, health: number): CardDef {
  return {
    id, name: id, faction: "Tempys", rarity: "Common", set: "Set 1",
    types: ["Creature"], subtypes: [], images: [],
    levels: [1, 2, 3].map((level) => ({
      level, text: "", attack: attack * level, health: health * level,
    })),
  };
}
function spell(id: string): CardDef {
  return {
    id, name: id, faction: "Tempys", rarity: "Common", set: "Set 1",
    types: ["Spell"], subtypes: [], images: [],
    levels: [1, 2, 3].map((level) => ({ level, text: "", attack: null, health: null })),
  };
}

const cards: Record<string, CardDef> = {
  "gob-3-2": creature("gob-3-2", 3, 2),
  "wall-0-10": creature("wall-0-10", 0, 10),
  spark: spell("spark"),
};
const deckOf = (id: string) => Array(30).fill(id) as string[];

describe("slugify / loadCards", () => {
  it("slugifies names", () => {
    expect(slugify("Demara's Pitguard")).toBe("demaras-pitguard");
    expect(slugify("Zimus, the Undying")).toBe("zimus-the-undying");
  });
  it("loads scraped json", () => {
    const scraped: ScrapedSet = {
      set: "Set_1", count: 1, skipped: [],
      cards: [{
        name: "Alloyin General", faction: "Alloyin", rarity: "Rare", set: "Set 1",
        types: ["Creature"], subtypes: ["Human"], images: ["Alloyin General 1.jpg"],
        levels: [
          { level: 1, text: "Adjacent creatures get +2 attack", attack: "2", health: "8" },
          { level: 2, text: "", attack: "4", health: "13" },
          { level: 3, text: "", attack: "6", health: "18" },
        ],
      }],
    };
    const defs = loadCards(scraped);
    expect(defs["alloyin-general"]?.levels[2]?.attack).toBe(6);
  });
});

describe("game setup", () => {
  it("creates a game: 120 hp, 26-card deck after drawing 5", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    expect(g.state.players[0].health).toBe(120);
    expect(g.state.players[0].hand).toHaveLength(5);
    expect(g.state.players[0].deck).toHaveLength(25);
    expect(g.state.players[0].rank).toBe(1);
  });

  it("supports custom and unequal starting health", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42, { startingHealth: [80, 150] });
    expect(g.state.players[0].health).toBe(80);
    expect(g.state.players[1].health).toBe(150);
  });
});

describe("playing and leveling", () => {
  it("playing a creature puts the leveled copy in discard and costs a play", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    const events = applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const p0 = g.state.players[0];
    expect(p0.lanes[2]?.defId).toBe("gob-3-2");
    expect(p0.lanes[2]?.defensive).toBe(true);
    expect(p0.hand).toHaveLength(4);
    expect(g.state.playsLeft).toBe(1);
    expect(p0.discard.map((c) => c.level)).toEqual([2]);
    expect(events.some((e) => e.type === "levelUp" && e.toLevel === 2)).toBe(true);
  });

  it("discard-to-level also levels and costs a play", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    applyAction(g, { type: "discardToLevel", handIndex: 0 });
    expect(g.state.players[0].discard.map((c) => c.level)).toEqual([1, 2]);
    expect(g.state.playsLeft).toBe(1);
  });

  it("only two plays per turn", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    applyAction(g, { type: "discardToLevel", handIndex: 0 });
    applyAction(g, { type: "discardToLevel", handIndex: 0 });
    expect(() => applyAction(g, { type: "discardToLevel", handIndex: 0 })).toThrow();
    expect(legalActions(g).some((a) => a.type === "discardToLevel")).toBe(false);
  });
});

describe("turn flow and rank up", () => {
  it("end of turn discards hand, draws 5, passes to opponent", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    applyAction(g, { type: "endTurn" });
    expect(g.state.active).toBe(1);
    expect(g.state.players[0].hand).toHaveLength(5);
    expect(g.state.players[0].turnInRank).toBe(2);
  });

  it("rank up after 4 turns reshuffles with level gating", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    // play one card each p0 turn so there is a level-2 copy in discard
    for (let t = 0; t < 4; t++) {
      // p0 turn
      applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
      applyAction(g, { type: "endTurn" });
      // p1 turn
      applyAction(g, { type: "endTurn" });
    }
    const p0 = g.state.players[0];
    expect(p0.rank).toBe(2);
    // level-2 copies are <= rank 2, so they shuffle back in
    expect(p0.deck.some((c) => c.level === 2)).toBe(true);
  });

  it("cards above current rank stay in discard on reshuffle", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    const p0 = g.state.players[0];
    // craft a level-3 card in discard artificially
    p0.discard.push({ uid: 999, defId: "gob-3-2", level: 3, owner: 0 });
    for (let t = 0; t < 4; t++) {
      applyAction(g, { type: "endTurn" });
      applyAction(g, { type: "endTurn" });
    }
    expect(p0.rank).toBe(2);
    expect(p0.discard.some((c) => c.level === 3)).toBe(true);
    expect(p0.deck.every((c) => c.level <= 2)).toBe(true);
  });
});

describe("battle", () => {
  it("defensive creatures do not attack; ready creatures hit face when unopposed", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("wall-0-10"), 42);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "battle" });
    // just-played creature is defensive: no damage
    expect(g.state.players[1].health).toBe(120);
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "endTurn" }); // back to p0, creature readies
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(117); // 3 attack to face
  });

  it("opposing creatures trade damage; both die when lethal both ways", () => {
    const g = createGame(cards, deckOf("gob-3-2"), deckOf("gob-3-2"), 42);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 creature, defensive
    applyAction(g, { type: "endTurn" });
    // p0 creature is ready, p1 creature defensive: p0 hits p1's creature for 3,
    // and the defensive creature hits BACK for 3 (per rules: both deal damage
    // as long as at least one is offensive). Both 3/2 creatures die.
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[1].discard.some((c) => c.level === 1)).toBe(true);
    expect(g.state.players[0].discard.some((c) => c.level === 1)).toBe(true);
  });
});
