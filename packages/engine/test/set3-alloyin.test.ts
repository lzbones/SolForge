import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getStats, hasKeyword, keywordValue, loadCards, refreshStatics, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet;
const set31 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set3, set31, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "technognome"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (level-gated plays, Allied conditions). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

function addToDiscard(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].discard.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

describe("Cerebral Scout (Forge: optional discard and level up a Metamind)", () => {
  it("discards and levels a chosen Metamind", () => {
    const g = gameWith("cerebral-scout"); // hand is all Metamind
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0, 1, 2, 3]);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3); // 5 - played - discarded
    expect(p0.discard.filter((c) => c.level === 1)).toHaveLength(1); // the discarded card
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play copy + effect copy
  });

  it("does not prompt without a Metamind in hand", () => {
    const g = gameWith("technognome");
    addToHand(g, 0, "cerebral-scout");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.pending).toBeNull();
  });

  it("does nothing when declined", () => {
    const g = gameWith("cerebral-scout");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].hand).toHaveLength(4);
  });
});

describe("Cypien Shieldwarden (Activate: Armor this turn)", () => {
  it("gives a creature Armor 2 until end of turn", () => {
    const g = gameWith("cypien-shieldwarden");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    const warden = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: warden.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: warden.uid });
    expect(keywordValue(warden, "Armor")).toBe(2);
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(warden, "Armor")).toBe(0); // temp wore off
  });
});

describe("Forge Guardian Delta (Solbind + Omega assembly)", () => {
  it("Solbind adds Alpha, Beta and Gamma to the deck at game start", () => {
    const g = gameWith("forge-guardian-delta");
    const p0 = g.state.players[0];
    const all = [...p0.deck, ...p0.hand].map((c) => c.defId);
    expect(all).toHaveLength(33); // 30 + 3 bound
    for (const id of ["forge-guardian-alpha", "forge-guardian-beta", "forge-guardian-gamma"]) {
      expect(all).toContain(id);
    }
  });

  it("puts a level-matching Forge Guardian Omega into the discard when it enters with all three guardians in play", () => {
    const g = gameWith("forge-guardian-delta");
    spawnCreature(g, [], 0, "forge-guardian-alpha", 1, { lane: 0 });
    spawnCreature(g, [], 0, "forge-guardian-beta", 1, { lane: 1 });
    spawnCreature(g, [], 0, "forge-guardian-gamma", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    const omegas = g.state.players[0].discard.filter((c) => c.defId === "forge-guardian-omega");
    expect(omegas).toHaveLength(1);
    expect(omegas[0]!.level).toBe(1); // the 25/25 token level
    expect(cards["forge-guardian-omega"]!.levels[0]!.attack).toBe(25);
  });

  it("does nothing without all three guardians in play", () => {
    const g = gameWith("forge-guardian-delta");
    spawnCreature(g, [], 0, "forge-guardian-alpha", 1, { lane: 0 });
    spawnCreature(g, [], 0, "forge-guardian-beta", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    expect(g.state.players[0].discard.filter((c) => c.defId === "forge-guardian-omega")).toHaveLength(0);
  });
});

describe("Ironbound Reinforcements (Forge: rank-gated buff)", () => {
  it("does not trigger below rank 2", () => {
    const g = gameWith("ironbound-reinforcements"); // rank 1
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes[1]!.attack).toBe(3);
  });

  it("gives a creature +5 attack at rank 2", () => {
    const g = gameWith("ironbound-reinforcements");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    const gnome = g.state.players[0].lanes[1]!;
    for (let t = 0; t < 4; t++) endRound(g);
    expect(g.state.players[0].rank).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.attack).toBe(8); // 3 + 5
  });
});

describe("Killion, Infinity Warden (Forge: level ups)", () => {
  it("L1 levels a level 1 card in the discard pile in place", () => {
    const g = gameWith("killion-infinity-warden");
    addToDiscard(g, 0, "technognome", 1);
    addToDiscard(g, 0, "technognome", 2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInDiscard");
    expect(req.options).toEqual([0]); // the L2 card (and the L2 play copy) are gated out
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.discard).toHaveLength(3); // gnome L1, gnome L2, Killion L2 play copy
    expect(p0.discard[0]).toMatchObject({ defId: "technognome", level: 2 }); // leveled in place
    expect(p0.discard[1]).toMatchObject({ defId: "technognome", level: 2 }); // untouched
  });

  it("L3 chains a hand level-up into a discard-pile level-up", () => {
    const g = gameWith("killion-infinity-warden");
    addToDiscard(g, 0, "technognome", 1);
    addToHand(g, 0, "killion-infinity-warden", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("cardInHand");
    applyChoice(g, { id: req1.id, accepted: true, handIndex: 0 });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("cardInDiscard");
    // gnome L1 (0) and the fresh Killion L2 copy (2); the Killion L4 play copy (1) is max level
    expect(req2.options).toEqual([0, 2]);
    applyChoice(g, { id: req2.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).toBeNull();
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(5); // hand card leveled, not discarded
    expect(p0.discard[0]).toMatchObject({ defId: "technognome", level: 2 });
    expect(p0.discard.filter((c) => c.defId === "killion-infinity-warden" && c.level === 2)).toHaveLength(1);
  });

  it("L4 levels each card in hand, deck and discard pile", () => {
    const g = gameWith("killion-infinity-warden");
    addToDiscard(g, 0, "technognome", 1);
    addToHand(g, 0, "killion-infinity-warden", 4);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.pending).toBeNull(); // no choices
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(5);
    expect(p0.deck).toHaveLength(25);
    expect(p0.deck.every((c) => c.level === 2)).toBe(true);
    expect(p0.discard[0]).toMatchObject({ defId: "technognome", level: 2 });
    // discard gnome leveled in place + one L2 copy per hand card (5)
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(6);
  });
});

describe("Nanoswarm (debuff + remove all abilities)", () => {
  it("gives a level 1 creature -5 attack and silences it (Vengeance stops working)", () => {
    const g = gameWith("nanoswarm");
    spawnCreature(g, [], 1, "metamind-explorer", 1, { lane: 0 });
    spawnCreature(g, [], 1, "metamind-explorer", 2, { lane: 1 });
    const [e0, e1] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    const p1hand = g.state.players[1].hand.length;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([e0.uid]); // L2 explorer gated out at L1
    applyChoice(g, { id: req.id, accepted: true, targetUid: e0.uid });
    expect(e0.attack).toBe(-2); // 3 - 5
    expect(e0.silenced).toBe(true);
    destroyCreature(g, [], e0);
    runBatches(g, [], []);
    expect(g.state.players[1].hand).toHaveLength(p1hand); // silenced: no Vengeance draw
    destroyCreature(g, [], e1); // control: unsilenced explorer still draws
    runBatches(g, [], []);
    expect(g.state.players[1].hand).toHaveLength(p1hand + 2);
  });
});

describe("Nexus Gunner (center-only Activate)", () => {
  it("activates only from the center space and gives a creature +5 attack", () => {
    const g = gameWith("nexus-gunner");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // off-center
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // center
    endRound(g);
    const off = g.state.players[0].lanes[0]!;
    const mid = g.state.players[0].lanes[2]!;
    expect(() => applyAction(g, { type: "activate", uid: off.uid })).toThrow();
    applyAction(g, { type: "activate", uid: mid.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: off.uid });
    expect(off.attack).toBe(10); // 5 + 5
  });
});

describe("Oratek Explosives (+5 attack; Allied Tempys battle-damage rider)", () => {
  it("L1: with a Tempys card in hand, player battle damage splashes to a random enemy creature this turn", () => {
    const g = gameWith("oratek-explosives");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 }); // not opposing the attacker
    const gnome = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[2]!;
    endRound(g); // gnome becomes offensive
    addToHand(g, 0, "lightning-spark"); // Allied Tempys
    const oi = g.state.players[0].hand.findIndex((c) => c.defId === "oratek-explosives");
    applyAction(g, { type: "playCard", handIndex: oi });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.attack).toBe(8); // 3 + 5
    expect(gnome.grantedAbilities).toContain("alloyin:oratek-boom-1");
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(112); // 120 - 8 to the face
    expect(foe.damage).toBe(8); // rider splashed the same amount to it
    applyAction(g, { type: "endTurn" });
    expect(gnome.grantedAbilities).toHaveLength(0); // "this turn" expired
  });

  it("only buffs without a Tempys card in hand", () => {
    const g = gameWith("oratek-explosives");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    const gnome = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.attack).toBe(8);
    expect(gnome.grantedAbilities).toHaveLength(0);
  });

  it("L3: the rider hits each enemy creature", () => {
    const g = gameWith("oratek-explosives");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 3 });
    const gnome = g.state.players[0].lanes[0]!;
    const [f1, f3] = [g.state.players[1].lanes[1]!, g.state.players[1].lanes[3]!];
    endRound(g);
    addToHand(g, 0, "lightning-spark");
    addToHand(g, 0, "oratek-explosives", 3);
    const oi = g.state.players[0].hand.findIndex((c) => c.defId === "oratek-explosives" && c.level === 3);
    applyAction(g, { type: "playCard", handIndex: oi });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.grantedAbilities).toContain("alloyin:oratek-boom-3");
    applyAction(g, { type: "battle" });
    expect(f1.damage).toBe(8);
    expect(f3.damage).toBe(8);
  });
});

describe("Perilous Insight (Overload: discard and level up 2 cards)", () => {
  it("chains two discards and removes itself from the game", () => {
    const g = gameWith("perilous-insight");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("cardInHand");
    expect(req1.options).toEqual([0, 1, 2, 3]);
    applyChoice(g, { id: req1.id, accepted: true, handIndex: 0 });
    const req2 = g.state.pending!.request;
    expect(req2.options).toEqual([0, 1, 2]);
    applyChoice(g, { id: req2.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).toBeNull();
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(2); // 5 - played - 2 discarded
    expect(p0.removed).toHaveLength(1); // Overload removes the played card
    expect(p0.removed[0]!.defId).toBe("perilous-insight");
    // single-level card: no level-up copies, just the two discarded originals
    expect(p0.discard).toHaveLength(2);
    expect(p0.discard.every((c) => c.level === 1)).toBe(true);
  });
});

describe("Seal of Anvillon (attack buff)", () => {
  it("gives any creature +3 attack", () => {
    const g = gameWith("seal-of-anvillon");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(6); // 3 + 3
  });
});

describe("Steelskin Spelunker (Forge: Armor to the other center-space creature)", () => {
  it("gives the friendly center-space creature Armor 1", () => {
    const g = gameWith("steelskin-spelunker");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 2 });
    const center = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(center, "Armor")).toBe(1);
  });

  it("does nothing when it is itself in the center space", () => {
    const g = gameWith("steelskin-spelunker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Armor")).toBe(0);
  });
});

describe("Forge Oracle (Forge: optional discard and level up an Alloyin card)", () => {
  it("discards and levels a chosen Alloyin card", () => {
    const g = gameWith("forge-oracle"); // pure Alloyin hand
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0, 1, 2, 3]);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3);
    expect(p0.discard.filter((c) => c.level === 1)).toHaveLength(1);
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play copy + effect copy
  });

  it("does not prompt without an Alloyin card in hand", () => {
    const g = gameWith("cavern-hydra"); // Uterra deck
    addToHand(g, 0, "forge-oracle");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Nexus Aeronaut (center aura / self Armor)", () => {
  it("in the center: other friendly creatures get +2 attack, no self Armor", () => {
    const g = gameWith("nexus-aeronaut");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // center
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const p0 = g.state.players[0];
    refreshStatics(g);
    expect(getStats(g, p0.lanes[0]!).attack).toBe(6); // 4 + 2
    expect(getStats(g, p0.lanes[2]!).attack).toBe(4); // does not buff itself
    expect(keywordValue(p0.lanes[2]!, "Armor")).toBe(0);
    expect(keywordValue(p0.lanes[2]!, "Mobility")).toBe(1); // inherent
  });

  it("outside the center: gets Armor 2 itself and buffs nobody", () => {
    const g = gameWith("nexus-aeronaut");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    const p0 = g.state.players[0];
    refreshStatics(g);
    expect(keywordValue(p0.lanes[1]!, "Armor")).toBe(2);
    expect(keywordValue(p0.lanes[3]!, "Armor")).toBe(2);
    expect(getStats(g, p0.lanes[3]!).attack).toBe(4); // no buff while off-center
  });
});

describe("Iron Maiden (L3: reflect damage to the enemy player)", () => {
  it("deals damage back to the enemy player when dealt damage", () => {
    const g = gameWith("iron-maiden");
    spawnCreature(g, [], 0, "iron-maiden", 3, { lane: 0 });
    const maiden = g.state.players[0].lanes[0]!;
    expect(hasKeyword(maiden, "Breakthrough")).toBe(true); // inherent at L3
    const items = collectInto(() => dealCreatureDamage(g, [], maiden, 7));
    runBatches(g, [], items);
    expect(maiden.damage).toBe(7);
    expect(g.state.players[1].health).toBe(113); // 120 - 7 reflected
  });

  it("L2 has no reflect (Consistent only)", () => {
    const g = gameWith("iron-maiden");
    spawnCreature(g, [], 0, "iron-maiden", 2, { lane: 0 });
    const maiden = g.state.players[0].lanes[0]!;
    expect(hasKeyword(maiden, "Consistent")).toBe(true);
    const items = collectInto(() => dealCreatureDamage(g, [], maiden, 2));
    runBatches(g, [], items);
    expect(g.state.players[1].health).toBe(120);
  });
});
