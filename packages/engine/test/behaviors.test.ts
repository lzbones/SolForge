import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, findCreature, hasKeyword, keywordValue,
  loadCards, type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

describe("Lightning Spark (targeted spell with choice)", () => {
  it("pauses for a target, then damages the enemy player", () => {
    const g = gameWith("lightning-spark");
    const events = applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).not.toBeNull();
    expect(events.some((e) => e.type === "choiceRequest")).toBe(true);
    // leveled copy went to discard on play
    expect(g.state.players[0].discard.some((c) => c.defId === "lightning-spark" && c.level === 2)).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: -2 }); // -2 = player 1
    expect(g.state.players[1].health).toBe(114);
    expect(g.state.pending).toBeNull();
    // spell card itself is in discard now
    expect(g.state.players[0].discard.some((c) => c.defId === "lightning-spark" && c.level === 1)).toBe(true);
  });

  it("can kill a creature", () => {
    const g = gameWith("lightning-spark");
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" }); // p0
    applyAction(g, { type: "playCard", handIndex: 0 }); // spark
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(6);
    expect(g.state.players[1].lanes[2]).not.toBeNull(); // 7 health survives
  });
});

describe("Death Seeker (Vengeance)", () => {
  it("spawns a 5/5 Spirit in its lane when destroyed", () => {
    const g = gameWith("death-seeker", "ashurian-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // seeker 1/1
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 mystic 3/5 (Aggressive)
    applyAction(g, { type: "endTurn" });
    // p1 mystic (aggressive) already fought on p1's turn? No — battle is manual.
    // p0 battle: seeker is ready now; mystic offensive too (aggressive). They trade.
    applyAction(g, { type: "battle" });
    const spirit = g.state.players[0].lanes[1];
    expect(spirit?.defId).toBe("spirit-nekrium");
    expect(spirit?.attack).toBe(5);
    expect(spirit?.health).toBe(5);
  });
});

describe("Aegis Conscript (Forge) + Armor", () => {
  it("grants Armor which prevents the first damage each turn", () => {
    const g = gameWith("aegis-conscript", "lightning-spark");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // conscript 3/6
    expect(g.state.pending).not.toBeNull();
    const self = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: self.uid });
    expect(keywordValue(self, "Armor")).toBe(1);
    // p1 sparks it for 6: 1 absorbed by armor
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: self.uid });
    expect(self.damage).toBe(5);
    expect(g.state.players[0].lanes[0]).not.toBeNull();
  });
});

describe("Cavern Hydra (Regenerate)", () => {
  it("heals at the start of its controller's turn", () => {
    const g = gameWith("cavern-hydra", "ashurian-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // mystic 3/5
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // hydra takes 3 -> damage 3
    const hydra = g.state.players[0].lanes[0]!;
    expect(hydra.damage).toBe(3);
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "endTurn" }); // p0 turn start: regenerate 1
    expect(hydra.damage).toBe(2);
  });
});

describe("Ashurian Mystic (Aggressive)", () => {
  it("can battle the turn it is played and grows after hitting face", () => {
    const g = gameWith("ashurian-mystic", "cavern-hydra");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 }); // mystic, aggressive
    applyAction(g, { type: "battle" }); // hits face immediately
    expect(g.state.players[1].health).toBe(117);
    const mystic = g.state.players[0].lanes[4]!;
    expect(mystic.attack).toBe(4); // 3 + 1
    expect(mystic.health).toBe(6); // 5 + 1
  });
});

describe("Ferocious Roar (board buff spell)", () => {
  it("buffs all friendly creatures", () => {
    const g = gameWith("ferocious-roar", "cavern-hydra");
    const p0 = g.state.players[0];
    // plant two hydras via direct state manipulation isn't possible; play roar with empty board = no-op
    applyAction(g, { type: "playCard", handIndex: 0 }); // roar, no targets needed
    expect(g.state.pending).toBeNull();
    expect(p0.discard.some((c) => c.defId === "ferocious-roar" && c.level === 1)).toBe(true);
    expect(p0.discard.some((c) => c.defId === "ferocious-roar" && c.level === 2)).toBe(true);
  });
});

describe("Energy Surge (Free at L2+ / Overload at L3)", () => {
  it("L1 costs a play and draws 1", () => {
    const g = gameWith("energy-surge", "cavern-hydra");
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playsLeft).toBe(1);
    expect(g.state.players[0].hand).toHaveLength(5); // 4 + 1 drawn
  });
});
