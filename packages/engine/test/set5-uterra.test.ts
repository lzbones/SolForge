import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, dealCreatureDamage,
  getCardScript, getStats, healCreature, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set5 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.json", import.meta.url), "utf8")) as ScrapedSet;
const set51 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set52 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // hunting-pack, alloyin-general, cavern-hydra
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet; // spore-torrent
const cards = loadCards(set5, set51, set52, set1, set2);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (leveled plays, support cards). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "ancestral-echoes", "cavern-serpent", "dendrify", "killer-bee", "leyline-golem",
  "shardplate-behemoth", "snowdrift-alpha", "toorgmai-mender", "torrent-soldier",
  "toxic-boon", "ursine-strength",
  "malice-hermit", "stinging-invocation", // Set 5.1
  "everflow-eidolon", // Set 5.2
];

describe("Set 5 Uterra registration", () => {
  it("all 14 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Cavern Serpent (enter play: enemy player gets Poison N)", () => {
  it("gives the enemy player Poison 2 when played, ticking at their turn start", () => {
    const g = gameWith("cavern-serpent");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].poison).toBe(2);
    applyAction(g, { type: "endTurn" }); // p1's turn starts: poison ticks
    expect(g.state.players[1].health).toBe(118);
  });

  it("stacks when a second serpent enters play", () => {
    const g = gameWith("cavern-serpent");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[1].poison).toBe(4);
  });
});

describe("Dendrify (replace a creature with a 7/7 Treefolk)", () => {
  it("replaces an enemy creature with a 7/7 Treefolk under its controller", () => {
    const g = gameWith("dendrify");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    const t = g.state.players[1].lanes[2]!;
    expect(t.defId).toBe("treefolk");
    expect(t.owner).toBe(1);
    expect(t.attack).toBe(7);
    expect(t.health).toBe(7);
    expect(g.state.players[1].discard.some((i) => i.defId === "cavern-hydra")).toBe(true);
  });

  it("L1 cannot target a level 3 creature", () => {
    const g = gameWith("dendrify");
    const big = spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 0 })!;
    const small = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const opts = g.state.pending!.request.options!;
    expect(opts).toContain(small.uid);
    expect(opts).not.toContain(big.uid);
  });

  it("L3 is Free, replaces any creature, and Overloads out of the game", () => {
    const g = gameWith("dendrify");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 0 })!; // level 3: L3 has no cap
    addToHand(g, 0, "dendrify", 3);
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.playsLeft).toBe(2); // Free: no play consumed
    expect(g.state.players[0].removed.some((i) => i.defId === "dendrify" && i.level === 3)).toBe(true);
    expect(g.state.players[1].lanes[0]!.defId).toBe("treefolk");
  });
});

describe("Killer Bee (battle damage poisons the damaged)", () => {
  it("L1 gives a creature it battles Poison 1, even when it dies", () => {
    const g = gameWith("killer-bee");
    const bee = spawnCreature(g, [], 0, "killer-bee", 1, { lane: 0 })!; // 1/1
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7 kills the bee back
    bee.defensive = false;
    applyAction(g, { type: "battle" });
    expect(keywordValue(foe, "Poison")).toBe(1);
  });

  it("L3 gives a player as much Poison as the damage dealt", () => {
    const g = gameWith("killer-bee");
    const bee = spawnCreature(g, [], 0, "killer-bee", 3, { lane: 0 })!; // 5/5
    bee.defensive = false;
    applyAction(g, { type: "battle" }); // empty opposing lane: hits the player for 5
    expect(g.state.players[1].poison).toBe(5);
  });
});

describe("Leyline Golem (Ambush: enemy creature moves)", () => {
  it("ambushes when an enemy creature moves on the enemy's turn", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-golem");
    const bee = spawnCreature(g, [], 0, "killer-bee", 1, { lane: 0 })!; // Mobility 1
    bee.defensive = false;
    applyAction(g, { type: "move", uid: bee.uid, lane: 1 });
    const lanes = g.state.players[1].lanes.filter((l) => l !== null);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.defId).toBe("leyline-golem");
    expect(lanes[0]!.attack).toBe(5); // L1 5/3
    expect(lanes[0]!.health).toBe(3);
    const discard = g.state.players[1].discard;
    expect(discard.some((i) => i.defId === "leyline-golem" && i.level === 1)).toBe(true);
    expect(discard.some((i) => i.defId === "leyline-golem" && i.level === 2)).toBe(true); // leveled copy
  });
});

describe("Malice Hermit (Forge: each other creature gets Poison N; grows when a poisoned creature dies)", () => {
  it("poisons each other creature on Forge and grows when a poisoned creature is destroyed", () => {
    const g = gameWith("malice-hermit");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/4
    const hermit = g.state.players[0].lanes[2]!;
    expect(keywordValue(hermit, "Poison")).toBe(0); // each OTHER creature
    expect(keywordValue(mine, "Poison")).toBe(1);
    expect(keywordValue(foe, "Poison")).toBe(1);
    const initial = collectInto(() => dealCreatureDamage(g, [], foe, 99));
    runBatches(g, [], initial);
    expect(hermit.attack).toBe(5);
    expect(hermit.health).toBe(5);
  });

  it("does not grow when an unpoisoned creature is destroyed", () => {
    const g = gameWith("malice-hermit");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const hermit = g.state.players[0].lanes[2]!;
    const clean = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!; // entered after the Forge
    const initial = collectInto(() => dealCreatureDamage(g, [], clean, 99));
    runBatches(g, [], initial);
    expect(hermit.attack).toBe(4);
    expect(hermit.health).toBe(4);
  });
});

describe("Shardplate Behemoth (static: attack equals its health)", () => {
  it("has attack equal to its health, and damage reduces both", () => {
    const g = gameWith("shardplate-behemoth");
    const b = spawnCreature(g, [], 0, "shardplate-behemoth", 1, { lane: 2 })!; // 0/11
    expect(getStats(g, b).attack).toBe(11);
    dealCreatureDamage(g, [], b, 4);
    expect(getStats(g, b).attack).toBe(7);
  });

  it("ignores one-time attack modifiers but counts health buffs", () => {
    const g = gameWith("shardplate-behemoth");
    const b = spawnCreature(g, [], 0, "shardplate-behemoth", 1, { lane: 2 })!;
    buffCreature(g, [], b, -3, 0); // Electro Net-style: attack is untouched
    expect(getStats(g, b).attack).toBe(11);
    buffCreature(g, [], b, 0, 2); // +health raises the attack
    expect(getStats(g, b).attack).toBe(13);
  });

  it("applies in lane order against other statics (Alloyin General)", () => {
    const g1 = gameWith("shardplate-behemoth");
    const left = spawnCreature(g1, [], 0, "alloyin-general", 1, { lane: 0 })!; // adjacent aura +2 attack
    const rightBehemoth = spawnCreature(g1, [], 0, "shardplate-behemoth", 1, { lane: 1 })!;
    expect(left.attack).toBeGreaterThan(0); // sanity: general on board
    expect(getStats(g1, rightBehemoth).attack).toBe(11); // General first, then Behemoth sets attack
    const g2 = gameWith("shardplate-behemoth");
    const leftBehemoth = spawnCreature(g2, [], 0, "shardplate-behemoth", 1, { lane: 0 })!;
    spawnCreature(g2, [], 0, "alloyin-general", 1, { lane: 1 });
    expect(getStats(g2, leftBehemoth).attack).toBe(13); // Behemoth sets, then General +2
  });
});

describe("Snowdrift Alpha (Activate: put a Hunting Pack into an available space)", () => {
  it("puts a level-matching Hunting Pack into play", () => {
    const g = gameWith("snowdrift-alpha");
    const alpha = spawnCreature(g, [], 0, "snowdrift-alpha", 2, { lane: 0 })!; // L2 12/8
    alpha.defensive = false;
    applyAction(g, { type: "activate", uid: alpha.uid });
    const packs = g.state.players[0].lanes.filter((c) => c?.defId === "hunting-pack");
    expect(packs.length).toBeGreaterThanOrEqual(1); // the Pack's own 50% chain may add more
    expect(packs[0]!.level).toBe(2);
    expect(packs[0]!.attack).toBe(6); // L2 Hunting Pack 6/4
    expect(packs[0]!.health).toBe(4);
  });
});

describe("Toorgmai Mender (Forge: give a creature or player +N health)", () => {
  it("gives a creature +5 health", () => {
    const g = gameWith("toorgmai-mender");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.health).toBe(12);
  });

  it("can give a player +5 health", () => {
    const g = gameWith("toorgmai-mender");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: -1 });
    expect(g.state.players[0].health).toBe(125);
  });
});

describe("Torrent Soldier (L2/L3 Forge: put a level-matching Spore Torrent into hand)", () => {
  it("L2 puts a level 2 Spore Torrent into hand", () => {
    const g = gameWith("torrent-soldier");
    addToHand(g, 0, "torrent-soldier", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.players[0].hand.some((i) => i.defId === "spore-torrent" && i.level === 2)).toBe(true);
  });

  it("the Spore Torrent is playable: Free, gives a creature Poison 3", () => {
    const g = gameWith("torrent-soldier");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    addToHand(g, 0, "torrent-soldier", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // Forge: torrent to hand
    const idx = g.state.players[0].hand.findIndex((i) => i.defId === "spore-torrent");
    applyAction(g, { type: "playCard", handIndex: idx });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(3);
    expect(g.state.playsLeft).toBe(1); // the soldier consumed one play; the torrent was Free
  });
});

describe("Toxic Boon (enemy Poison N, or friendly +N/+N by target)", () => {
  it("gives a chosen enemy creature Poison 3", () => {
    const g = gameWith("toxic-boon");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(3);
  });

  it("gives a chosen friendly creature +3/+3", () => {
    const g = gameWith("toxic-boon");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.attack).toBe(7);
    expect(mine.health).toBe(10);
  });
});

describe("Ursine Strength (creature +N/+N, extra +2/+2 at a Rank threshold)", () => {
  it("gives +3/+3 at Rank 1", () => {
    const g = gameWith("ursine-strength");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.attack).toBe(7);
    expect(mine.health).toBe(10);
  });

  it("gives +5/+5 at Rank 2", () => {
    const g = gameWith("ursine-strength");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.attack).toBe(9);
    expect(mine.health).toBe(12);
  });
});

describe("Stinging Invocation (Spawn 1 to 3 Killer Bees)", () => {
  it("spawns 1 to 3 level 1 Killer Bees", () => {
    const g = gameWith("stinging-invocation");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const bees = g.state.players[0].lanes.filter((c) => c?.defId === "killer-bee");
    expect(bees.length).toBeGreaterThanOrEqual(1);
    expect(bees.length).toBeLessThanOrEqual(3);
    expect(bees.every((b) => b!.level === 1 && b!.attack === 1 && b!.health === 1)).toBe(true);
  });

  it("L2 spawns level 2 Killer Bees", () => {
    const g = gameWith("stinging-invocation");
    addToHand(g, 0, "stinging-invocation", 2);
    applyAction(g, { type: "playCard", handIndex: 5 });
    const bees = g.state.players[0].lanes.filter((c) => c?.defId === "killer-bee");
    expect(bees.length).toBeGreaterThanOrEqual(1);
    expect(bees.every((b) => b!.level === 2 && b!.attack === 3 && b!.health === 3)).toBe(true);
  });
});

describe("Everflow Eidolon (when it gains health, you gain that much; L3: 2x)", () => {
  it("healing it gains you that much health", () => {
    const g = gameWith("everflow-eidolon");
    const e = spawnCreature(g, [], 0, "everflow-eidolon", 1, { lane: 0 })!; // 6/6
    dealCreatureDamage(g, [], e, 5);
    g.state.players[0].health = 100;
    const initial = collectInto(() => healCreature(g, [], e, 3));
    runBatches(g, [], initial);
    expect(e.damage).toBe(2);
    expect(g.state.players[0].health).toBe(103);
  });

  it("L3 gains double the healed amount", () => {
    const g = gameWith("everflow-eidolon");
    const e = spawnCreature(g, [], 0, "everflow-eidolon", 3, { lane: 0 })!; // 16/16
    dealCreatureDamage(g, [], e, 5);
    g.state.players[0].health = 100;
    const initial = collectInto(() => healCreature(g, [], e, 3));
    runBatches(g, [], initial);
    expect(g.state.players[0].health).toBe(106);
  });
});

describe("Ancestral Echoes (player effect: deferred end-of-turn team buff)", () => {
  it("L1 gives each friendly creature +1/+2 at this turn end and your next, then expires", () => {
    const g = gameWith("ancestral-echoes");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.playerEffects).toHaveLength(1);
    applyAction(g, { type: "endTurn" }); // p0: +1/+2
    expect(mine.attack).toBe(5);
    expect(mine.health).toBe(9);
    applyAction(g, { type: "endTurn" }); // p1: condition fails, no trigger
    expect(mine.attack).toBe(5);
    expect(mine.health).toBe(9);
    applyAction(g, { type: "endTurn" }); // p0: +1/+2 again, then expires
    expect(mine.attack).toBe(6);
    expect(mine.health).toBe(11);
    expect(g.state.playerEffects).toHaveLength(0);
  });
});
