import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getStats, grantKeyword, hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type GameEvent, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

/** Deal damage to a creature outside of combat, resolving its trigger batch. */
function ping(g: Game, uid: number, amount: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => dealCreatureDamage(g, [], c, amount));
  runBatches(g, [], initial);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

describe("Arboris, Grove Dragon (static +N/+N while owner over 100 health)", () => {
  it("grows only while its controller has over 100 health", () => {
    const g = gameWith("arboris-grove-dragon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    expect(getStats(g, c)).toEqual({ attack: 9, health: 9 }); // 120 > 100
    g.state.players[0].health = 100;
    expect(getStats(g, c)).toEqual({ attack: 5, health: 5 }); // "over 100", not >=
    g.state.players[0].health = 101;
    expect(getStats(g, c)).toEqual({ attack: 9, health: 9 });
  });
});

describe("Botanimate (replace enemy creature with 3/3 Sapling)", () => {
  it("replaces an enemy level 1 creature with a Sapling owned by the enemy", () => {
    const g = gameWith("botanimate");
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0 }); // botanimate L1
    expect(g.state.pending).not.toBeNull();
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    const c = g.state.players[1].lanes[2]!;
    expect(c.defId).toBe("sapling");
    expect([c.attack, c.health, c.owner]).toEqual([3, 3, 1]);
  });
});

describe("Cadaverous Thicket (damage to a creature -> Poison)", () => {
  it("gives Poison 1 to the creature it damages in battle", () => {
    const g = gameWith("cadaverous-thicket");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // thicket 1/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    const hydra = g.state.players[1].lanes[0]!;
    expect(hydra.damage).toBe(1);
    expect(keywordValue(hydra, "Poison")).toBe(1);
    expect(g.state.players[0].lanes[0]!.damage).toBe(4); // thicket survives
  });
});

describe("Chrogias (when dealt damage, you gain that much health)", () => {
  it("L2 heals its controller for the damage taken", () => {
    const g = gameWith("chrogias");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    c.level = 2; c.attack = 0; c.health = 12; // stand-in for the leveled copy
    g.state.players[0].health = 100;
    ping(g, c.uid, 5);
    expect(g.state.players[0].health).toBe(105);
  });
});

describe("Cultivate (replace a friendly Plant with a Treefolk)", () => {
  it("offers only friendly Plants and replaces with a 9/9 Treefolk", () => {
    const g = gameWith("cultivate");
    spawnCreature(g, [], 0, "grove-matriarch", 1, { lane: 1 });
    spawnCreature(g, [], 0, "ashurian-mystic", 1, { lane: 2 }); // not a Plant
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    const matriarch = g.state.players[0].lanes[1]!;
    expect(req.options).toEqual([matriarch.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: matriarch.uid });
    const c = g.state.players[0].lanes[1]!;
    expect([c.defId, c.attack, c.health]).toEqual(["treefolk", 9, 9]);
  });
});

describe("Deepbranch Ancient (Forge: +N/+N if board full)", () => {
  it("does nothing on a non-full board, grows on a full one", () => {
    const g = gameWith("deepbranch-ancient");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([4, 4]);
    for (const i of [1, 2, 3, 4]) spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: i });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // replaces the hydra there
    expect([g.state.players[0].lanes[2]!.attack, g.state.players[0].lanes[2]!.health]).toEqual([8, 8]);
  });
});

describe("Druid's Chant (gain health)", () => {
  it("heals 8 at level 1", () => {
    const g = gameWith("druids-chant");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].health).toBe(108);
  });
});

describe("Echowisp (Forge: optional adjacent copy)", () => {
  it("accepting puts a copy in an adjacent space", () => {
    const g = gameWith("echowisp");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending!.request.optional).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter(Boolean).length).toBe(2);
    expect(lanes[1]!.defId).toBe("echowisp"); // seed 7 picks lane 1
    expect([lanes[1]!.attack, lanes[1]!.health]).toEqual([7, 1]);
  });
  it("declining leaves only the original", () => {
    const g = gameWith("echowisp");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes.filter(Boolean).length).toBe(1);
  });
});

describe("Enrage (single-target buff spell)", () => {
  it("gives +3/+3 at level 1", () => {
    const g = gameWith("enrage");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([7, 10]);
  });
});

describe("Ether Hounds (Forge: optional copy in any open space)", () => {
  it("accepting puts a second Ether Hounds on the board", () => {
    const g = gameWith("ether-hounds");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter(Boolean).length).toBe(2);
    expect(lanes.filter(Boolean).every((c) => c!.defId === "ether-hounds")).toBe(true);
  });
});

describe("Feral Instinct (buff + Breakthrough)", () => {
  it("gives +1/+1 and Breakthrough at level 1", () => {
    const g = gameWith("feral-instinct");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([5, 8]);
    expect(hasKeyword(hydra, "Breakthrough")).toBe(true);
  });
});

describe("Frostwild Tracker (Forge: optional extra play)", () => {
  it("L2 grants an additional play when accepted", () => {
    const g = gameWith("frostwild-tracker");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([7, 4]);
    expect(g.state.playsLeft).toBe(1);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    expect(g.state.playsLeft).toBe(2);
  });
  it("declining leaves playsLeft unchanged", () => {
    const g = gameWith("frostwild-tracker");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.playsLeft).toBe(1);
  });
});

describe("Gemhide Basher (Aggressive while opposed)", () => {
  it("gains Aggressive when an enemy enters the opposing space and loses it when that creature dies", () => {
    const g = gameWith("gemhide-basher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // basher 5/3
    const basher = g.state.players[0].lanes[0]!;
    expect(hasKeyword(basher, "Aggressive")).toBe(false);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra opposite
    expect(hasKeyword(basher, "Aggressive")).toBe(true);
    const hydra = g.state.players[1].lanes[0]!;
    destroyCreature(g, [], hydra);
    runBatches(g, [], []);
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(hasKeyword(basher, "Aggressive")).toBe(false);
  });
});

describe("Ghostscale Cobra (battle damage to a creature -> Poison 4)", () => {
  it("poisons the creature it battles", () => {
    const g = gameWith("ghostscale-cobra");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // cobra 4/1
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    const hydra = g.state.players[1].lanes[0]!;
    expect(hydra.damage).toBe(4);
    expect(keywordValue(hydra, "Poison")).toBe(4);
    expect(g.state.players[0].lanes[0]).toBeNull(); // cobra died to the hydra
  });
});

describe("Glowstride Stag (Forge: gain health)", () => {
  it("heals its controller for 5 on Forge", () => {
    const g = gameWith("glowstride-stag");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[0].health).toBe(105);
  });
});

describe("Grove Huntress (Forge: buff a friendly creature)", () => {
  it("gives the chosen friendly creature +1/+1", () => {
    const g = gameWith("grove-huntress");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending!.request.kind).toBe("friendlyCreature");
    const self = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: self.uid });
    expect([self.attack, self.health]).toEqual([5, 4]);
  });
});

describe("Grove Matriarch (Vengeance: token in this space)", () => {
  it("puts a 1/1 Seedling into its lane when destroyed", () => {
    const g = gameWith("grove-matriarch");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const c = g.state.players[0].lanes[1]!;
    destroyCreature(g, [], c);
    runBatches(g, [], []);
    const t = g.state.players[0].lanes[1]!;
    expect([t.defId, t.attack, t.health, t.lane]).toEqual(["seedling", 1, 1, 1]);
  });
});

describe("Heart Tree (Regenerate aura via granted abilities)", () => {
  it("grants turnStart healing to other friendly creatures played after it", () => {
    const g = gameWith("heart-tree");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const second = g.state.players[0].lanes[1]!;
    expect(second.grantedAbilities).toEqual(["uterra:heart-tree-regen-2"]);
    ping(g, second.uid, 3); // 3 damage: own Regenerate 2 heals 2, aura heals the rest
    passTurns(g, 2);
    expect(second.damage).toBe(0); // would be 1 without the aura
  });
  it("removes the granted heal when Heart Tree is destroyed", () => {
    const g = gameWith("heart-tree");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const first = g.state.players[0].lanes[0]!;
    const second = g.state.players[0].lanes[1]!;
    destroyCreature(g, [], first);
    runBatches(g, [], []);
    expect(second.grantedAbilities).toEqual([]);
  });
});

describe("Hunting Pack (50% chaining copy on enter)", () => {
  it("spawns a copy when the coin flip succeeds (seed 7)", () => {
    const g = gameWith("hunting-pack");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter(Boolean).length).toBe(2);
    expect(lanes.filter(Boolean).every((c) => c!.defId === "hunting-pack")).toBe(true);
  });
});

describe("Leafkin Progenitor (Activate upgrades)", () => {
  it("L1 Activate replaces it with a level 2 copy", () => {
    const g = gameWith("leafkin-progenitor");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    passTurns(g, 2);
    const c = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "activate", uid: c.uid });
    const nc = g.state.players[0].lanes[2]!;
    expect([nc.defId, nc.level, nc.attack, nc.health]).toEqual(["leafkin-progenitor", 2, 7, 7]);
  });
  it("L3 Activate puts a level 1 copy into an adjacent space", () => {
    const g = gameWith("leafkin-progenitor");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const c = g.state.players[0].lanes[2]!;
    c.level = 3; c.attack = 11; c.health = 11;
    passTurns(g, 2);
    applyAction(g, { type: "activate", uid: c.uid });
    const others = g.state.players[0].lanes.filter((x) => x && x.uid !== c.uid);
    expect(others.length).toBe(1);
    expect([others[0]!.level, others[0]!.attack, others[0]!.health]).toEqual([1, 3, 3]);
    expect([1, 3]).toContain(others[0]!.lane);
  });
});

describe("Lifeblood Dryad (Forge: full board buffs others)", () => {
  it("buffs each other friendly creature but not itself", () => {
    const g = gameWith("lifeblood-dryad");
    for (const i of [0, 2, 3, 4]) spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: i });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([6, 9]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([4, 4]);
  });
});

describe("Lightbringer Cleric (start of your turn: random heal)", () => {
  it("heals its controller at the start of their turn (seed 7: +2)", () => {
    const g = gameWith("lightbringer-cleric");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    passTurns(g, 2);
    expect(g.state.players[0].health).toBe(102);
  });
});

describe("Mossbeard Patriarch (Activate: another creature gets +N health)", () => {
  it("gives the chosen other creature +4 health", () => {
    const g = gameWith("mossbeard-patriarch");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    passTurns(g, 2);
    const first = g.state.players[0].lanes[0]!;
    const second = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: first.uid });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([second.uid]); // self excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: second.uid });
    expect(second.health).toBe(12); // 8 + 4
  });
});

describe("Natural Selection (full board: destroy a creature)", () => {
  it("destroys the chosen level 1 creature when the board is full", () => {
    const g = gameWith("natural-selection");
    for (let i = 0; i < 5; i++) spawnCreature(g, [], 0, "bramblewood-guardian", 1, { lane: i });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[0].lanes.filter(Boolean).length).toBe(5);
  });
  it("fizzles without a prompt when the board is not full", () => {
    const g = gameWith("natural-selection");
    spawnCreature(g, [], 0, "bramblewood-guardian", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[2]).not.toBeNull();
  });
});

describe("Oxidon Spitter (Forge: Negate Armor)", () => {
  it("removes Armor from the chosen enemy creature", () => {
    const g = gameWith("oxidon-spitter");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    const hydra = g.state.players[1].lanes[3]!;
    grantKeyword([], hydra, { keyword: "Armor", value: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(keywordValue(hydra, "Armor")).toBe(0);
  });
});

describe("Phytobomb (fill both players' open spaces with tokens)", () => {
  it("puts a 1/1 Seedling into every open space for both players", () => {
    const g = gameWith("phytobomb");
    applyAction(g, { type: "playCard", handIndex: 0 });
    for (const p of [0, 1] as const) {
      const lanes = g.state.players[p].lanes;
      expect(lanes.filter(Boolean).length).toBe(5);
      expect(lanes.every((c) => c !== null && c.defId === "seedling" && c.attack === 1 && c.health === 1)).toBe(true);
    }
  });
});

describe("Primal Surge (Free at L2)", () => {
  it("L2 costs no play and buffs +2/+2", () => {
    const g = gameWith("primal-surge");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.playsLeft).toBe(2);
    expect([hydra.attack, hydra.health]).toEqual([6, 9]);
  });
});

describe("Restless Wanderers (grows when another Wanderer enters)", () => {
  it("the first copy grows when a second is played", () => {
    const g = gameWith("restless-wanderers");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([8, 6]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([5, 3]);
  });
});

describe("Rootforged Avatar (Forge: +1/+1 per Uterra card in hand)", () => {
  it("gets +4/+4 with four Uterra cards left in hand", () => {
    const g = gameWith("rootforged-avatar");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    expect([c.attack, c.health]).toEqual([7, 7]); // 3/3 + 4x +1/+1
  });
});

describe("Runegrove Guardian (grows when you gain a Rank)", () => {
  it("gets +4/+4 on rank-up", () => {
    const g = gameWith("runegrove-guardian");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    passTurns(g, 8); // 4 own endTurns -> rank 2
    const c = g.state.players[0].lanes[0]!;
    expect(g.state.players[0].rank).toBe(2);
    expect([c.attack, c.health]).toEqual([8, 8]);
  });
});

describe("Shardplate Delver (start of your turn: +N/+N)", () => {
  it("grows +2/+2 at the start of its controller's turn", () => {
    const g = gameWith("shardplate-delver");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    passTurns(g, 2);
    const c = g.state.players[0].lanes[0]!;
    expect([c.attack, c.health]).toEqual([6, 6]);
  });
});

describe("Shardplate Mutant (start of your turn: discard down to 2)", () => {
  it("discards its controller's hand down to 2 cards", () => {
    const g = gameWith("shardplate-mutant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" }); // p0 discards 4, draws 5
    applyAction(g, { type: "endTurn" }); // p1 passes; p0 turnStart triggers
    expect(g.state.players[0].hand.length).toBe(2);
  });
});

describe("Soothing Radiance (heal each friendly creature)", () => {
  it("heals 6 damage from each friendly creature", () => {
    const g = gameWith("soothing-radiance");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    ping(g, g.state.players[0].lanes[0]!.uid, 3);
    expect(g.state.players[0].lanes[0]!.damage).toBe(3);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes[0]!.damage).toBe(0);
  });
});

describe("Spring Dryad (grows when a friendly creature enters)", () => {
  it("does not count its own entry but grows off the next friendly creature", () => {
    const g = gameWith("spring-dryad");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([4, 4]);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([5, 5]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([4, 4]);
  });
});

describe("Talisin, Bard of Abundance (extra play each turn)", () => {
  it("offers the active player an additional play at their turn start", () => {
    const g = gameWith("talisin-bard-of-abundance");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" }); // p1's turn start triggers Talisin
    expect(g.state.active).toBe(1);
    expect(g.state.pending!.request.optional).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    expect(g.state.playsLeft).toBe(3);
  });
});

describe("Toxic Spores (give a creature Poison N)", () => {
  it("poisons the target; the poison ticks at its controller's turn start", () => {
    const g = gameWith("toxic-spores");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(keywordValue(hydra, "Poison")).toBe(5);
    applyAction(g, { type: "endTurn" }); // p1 turnStart: poison 5, regen 1
    expect(g.state.players[1].lanes[0]!.damage).toBe(4);
  });
});

describe("Uterra Packmaster (Activate: other friendly Uterra creatures +N/+N)", () => {
  it("buffs other Uterra creatures but not itself or non-Uterra creatures", () => {
    const g = gameWith("uterra-packmaster");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    spawnCreature(g, [], 0, "ashurian-mystic", 1, { lane: 2 }); // Tempys
    passTurns(g, 2);
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([6, 6]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([7, 7]);
    expect([g.state.players[0].lanes[2]!.attack, g.state.players[0].lanes[2]!.health]).toEqual([3, 5]);
  });
});
