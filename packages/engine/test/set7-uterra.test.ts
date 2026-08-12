import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, dealPlayerDamage,
  getCardScript, getStats, keywordValue, loadCards, refreshStatics, runBatches, spawnCreature,
  type CreatureState, type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set7 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.json", import.meta.url), "utf8")) as ScrapedSet;
const set71 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set72 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set73 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.3.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra, death-seeker
const set5 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.json", import.meta.url), "utf8")) as ScrapedSet; // killer-bee
const cards = loadCards(set7, set71, set72, set73, set1, set5);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand. */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

/** Play the last card of p0's hand (an addToHand'd card). */
function playLastAdded(g: Game, lane?: number): void {
  const handIndex = g.state.players[0].hand.length - 1;
  applyAction(g, { type: "playCard", handIndex, ...(lane !== undefined ? { lane } : {}) });
}

/** Spawn outside of an action and resolve the resulting batch (enterPlay fires). */
function spawn(g: Game, p: PlayerId, defId: string, level: number, lane: number): CreatureState {
  let out!: CreatureState;
  runBatches(g, [], collectInto(() => { out = spawnCreature(g, [], p, defId, level, { lane })!; }));
  return out;
}

/** Answer the pending choice with a target. */
function chooseTarget(g: Game, targetUid: number): void {
  applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid });
}

function lanesOf(g: Game, p: PlayerId, defId: string): CreatureState[] {
  return g.state.players[p].lanes.filter((c): c is CreatureState => !!c && c.defId === defId);
}

/** Flag three of p0's creatures as having initiated battle (Raid enabler). */
function threeBattlers(g: Game): void {
  let flagged = 0;
  for (const c of g.state.players[0].lanes) {
    if (c && flagged < 3) { c.hasBattled = true; flagged++; }
  }
  if (flagged < 3) throw new Error("test setup: fewer than three friendly creatures");
}

const IDS = [
  "demaras-pitguard", "ether-wolves", "harbinger-of-spring", "herd-mother",
  "hive-empress", "lightbringer-council", "living-hive", "lorus-the-unrivaled",
  "relentless-wanderers", "scatterspore-tiller", "victory-rush",
  "leyline-vermin", "shardplate-toxoid", // 7.1
  "bottomless-puncture", "primeval-ancient", // 7.2
  "ramble-eternal-witness", "wegus-embrace", // 7.3
];

describe("Set 7 Uterra registration", () => {
  it("all 17 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });

  it("ether-wolf, killer-bee and the plant tokens have data (spawn targets)", () => {
    expect(cards["ether-wolf"]).toBeTruthy();
    expect(cards["killer-bee"]).toBeTruthy();
    expect(cards["seedling"]).toBeTruthy();
    expect(cards["sapling"]).toBeTruthy();
    expect(cards["treefolk"]).toBeTruthy();
  });
});

describe("Demara's Pitguard (the opposing creature has Poison N)", () => {
  it("grants Poison 2 to the enemy creature in its lane only", () => {
    const g = gameWith("demaras-pitguard");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const opposed = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    const other = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    refreshStatics(g); // staticKeywords refresh on the legalActions/batch path
    expect(keywordValue(opposed, "Poison")).toBe(2);
    expect(keywordValue(other, "Poison")).toBe(0);
  });

  it("the granted Poison ticks at the enemy turn start", () => {
    const g = gameWith("demaras-pitguard");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const opposed = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // vanilla 9/9
    const other = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 1 })!;
    refreshStatics(g);
    applyAction(g, { type: "endTurn" }); // p1's startOfTurn ticks its creatures
    expect(opposed.damage).toBe(2);
    expect(other.damage).toBe(0);
  });
});

describe("Ether Wolves (Overload: Spawn two Ether Wolves)", () => {
  it("spawns two 5/6 Ether Wolves and is removed from the game", () => {
    const g = gameWith("ether-wolves");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const wolves = lanesOf(g, 0, "ether-wolf");
    expect(wolves).toHaveLength(2);
    for (const w of wolves) expect([w.attack, w.health, w.level]).toEqual([5, 6, 1]);
    expect(g.state.players[0].removed.some((i) => i.defId === "ether-wolves")).toBe(true);
    expect(g.state.players[0].discard.some((i) => i.defId === "ether-wolves")).toBe(false);
  });
});

describe("Harbinger of Spring (un-Forged friendly entry: +N/+N)", () => {
  it("grows when a friendly creature enters un-Forged, not when Forged", () => {
    const g = gameWith("harbinger-of-spring");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 5/5
    const harb = g.state.players[0].lanes[0]!;
    spawn(g, 0, "cavern-hydra", 1, 1); // un-Forged entry
    expect([harb.attack, harb.health]).toEqual([7, 7]);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // a Forged harbinger
    expect([harb.attack, harb.health]).toEqual([7, 7]); // unchanged
  });
});

describe("Herd Mother (Raid: +N/+N)", () => {
  it("gets +3/+3 on Raid", () => {
    const g = gameWith("herd-mother");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" });
    const mother = g.state.players[0].lanes[0]!;
    expect([mother.attack, mother.health]).toEqual([8, 8]);
  });

  it("does nothing with fewer than three battlers", () => {
    const g = gameWith("herd-mother");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    // only the two hydras battled — one short of Raid
    g.state.players[0].lanes[1]!.hasBattled = true;
    g.state.players[0].lanes[2]!.hasBattled = true;
    applyAction(g, { type: "endTurn" });
    const mother = g.state.players[0].lanes[0]!;
    expect([mother.attack, mother.health]).toEqual([5, 5]);
  });
});

describe("Hive Empress (Raid: give the enemy player Poison N)", () => {
  it("poisons the enemy player on Raid; the Poison ticks at their turn start", () => {
    const g = gameWith("hive-empress");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" }); // Raid fires, then p1's startOfTurn ticks the Poison
    expect(g.state.players[1].poison).toBe(2);
    expect(g.state.players[1].health).toBe(118);
  });

  it("does nothing with fewer than three battlers", () => {
    const g = gameWith("hive-empress");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].poison).toBe(0);
    expect(g.state.players[1].health).toBe(120);
  });
});

describe("Lightbringer Council (friendly Uterra battle damage to the enemy player: gain N)", () => {
  it("gains 4 when another friendly Uterra creature hits the enemy player", () => {
    const g = gameWith("lightbringer-council");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const mother = spawnCreature(g, [], 0, "herd-mother", 1, { lane: 1 })!; // Uterra
    g.state.players[0].health = 100;
    runBatches(g, [], collectInto(() => dealPlayerDamage(g, [], 1, 5, mother, true)));
    expect(g.state.players[0].health).toBe(104);
    expect(g.state.players[1].health).toBe(115);
  });

  it("gains 4 on its own hit, and nothing for a non-Uterra ally", () => {
    const g = gameWith("lightbringer-council");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const council = g.state.players[0].lanes[0]!;
    const seeker = spawnCreature(g, [], 0, "death-seeker", 1, { lane: 1 })!; // Nekrium
    g.state.players[0].health = 100;
    runBatches(g, [], collectInto(() => dealPlayerDamage(g, [], 1, 4, council, true)));
    expect(g.state.players[0].health).toBe(104);
    runBatches(g, [], collectInto(() => dealPlayerDamage(g, [], 1, 3, seeker, true)));
    expect(g.state.players[0].health).toBe(104); // unchanged
  });
});

describe("Living Hive (when dealt damage, Spawn a Killer Bee; L3 poison-fueled)", () => {
  it("spawns a level 1 Killer Bee when dealt damage", () => {
    const g = gameWith("living-hive");
    const hive = spawn(g, 0, "living-hive", 1, 0); // 0/8 Defender
    runBatches(g, [], collectInto(() => dealCreatureDamage(g, [], hive, 3)));
    expect(hive.damage).toBe(3);
    const bees = lanesOf(g, 0, "killer-bee");
    expect(bees).toHaveLength(1);
    expect([bees[0]!.attack, bees[0]!.health, bees[0]!.level]).toEqual([1, 1, 1]);
  });

  it("L3 has +attack/+health equal to the enemy player's Poison", () => {
    const g = gameWith("living-hive");
    const hive = spawn(g, 0, "living-hive", 3, 0); // 10/15 Breakthrough
    g.state.players[1].poison = 5;
    expect(getStats(g, hive)).toEqual({ attack: 15, health: 20 });
  });
});

describe("Lorus, the Unrivaled (Raid: replace with next level / L3 rally)", () => {
  it("L1 replaces itself with a level 2 Lorus on Raid", () => {
    const g = gameWith("lorus-the-unrivaled");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" });
    const lorus = g.state.players[0].lanes[0]!;
    expect([lorus.defId, lorus.level, lorus.attack, lorus.health])
      .toEqual(["lorus-the-unrivaled", 2, 6, 11]);
    expect(g.state.players[0].discard.some((i) => i.defId === "lorus-the-unrivaled" && i.level === 1)).toBe(true);
  });

  it("L3 gives each friendly creature +3/+3 on Raid", () => {
    const g = gameWith("lorus-the-unrivaled");
    const lorus = spawn(g, 0, "lorus-the-unrivaled", 3, 0); // 12/17
    const hydra = spawn(g, 0, "cavern-hydra", 1, 1);
    spawn(g, 0, "cavern-hydra", 1, 2);
    threeBattlers(g);
    const before = { a: hydra.attack, h: hydra.health };
    applyAction(g, { type: "endTurn" });
    expect([lorus.attack, lorus.health]).toEqual([15, 20]);
    expect([hydra.attack, hydra.health]).toEqual([before.a + 3, before.h + 3]);
  });
});

describe("Relentless Wanderers (Raid: Spawn a Relentless Wanderers)", () => {
  it("spawns a same-level copy on Raid", () => {
    const g = gameWith("relentless-wanderers");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" });
    const wanderers = lanesOf(g, 0, "relentless-wanderers");
    expect(wanderers).toHaveLength(2);
    expect(wanderers.every((c) => c.level === 1)).toBe(true);
  });
});

describe("Scatterspore Tiller (Activate: Spawn a plant token)", () => {
  it("L1 spawns a 1/1 Seedling", () => {
    const g = gameWith("scatterspore-tiller");
    const tiller = spawn(g, 0, "scatterspore-tiller", 1, 0);
    tiller.defensive = false;
    applyAction(g, { type: "activate", uid: tiller.uid });
    const tokens = lanesOf(g, 0, "seedling");
    expect(tokens).toHaveLength(1);
    expect([tokens[0]!.attack, tokens[0]!.health]).toEqual([1, 1]);
  });

  it("L3 spawns a 5/5 Treefolk", () => {
    const g = gameWith("scatterspore-tiller");
    const tiller = spawn(g, 0, "scatterspore-tiller", 3, 0);
    tiller.defensive = false;
    applyAction(g, { type: "activate", uid: tiller.uid });
    const tokens = lanesOf(g, 0, "treefolk");
    expect(tokens).toHaveLength(1);
    expect([tokens[0]!.attack, tokens[0]!.health]).toEqual([5, 5]);
  });
});

describe("Victory Rush (+N/+N; doubled if three friendly creatures battled)", () => {
  it("gives +4/+4 with fewer than three battlers", () => {
    const g = gameWith("victory-rush");
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("friendlyCreature");
    chooseTarget(g, hydra.uid);
    expect([hydra.attack, hydra.health]).toEqual([8, 11]); // 4/7 + 4/4
  });

  it("gives +8/+8 when three friendly creatures initiated battle", () => {
    const g = gameWith("victory-rush");
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, hydra.uid);
    expect([hydra.attack, hydra.health]).toEqual([12, 15]); // 4/7 + 8/8
  });
});

describe("Shardplate Toxoid (Forge Poison N; enemy turn end: each enemy creature Poison M)", () => {
  it("Forge gives the chosen enemy creature Poison 2", () => {
    const g = gameWith("shardplate-toxoid");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending!.request.kind).toBe("enemyCreature");
    chooseTarget(g, foe.uid);
    expect(keywordValue(foe, "Poison")).toBe(2);
  });

  it("each enemy creature gets Poison 1 at the end of the enemy turn (stacking)", () => {
    const g = gameWith("shardplate-toxoid");
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // vanilla 9/9
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    chooseTarget(g, foe.uid); // Poison 2
    const toxoid = g.state.players[0].lanes[0]!;
    endRound(g); // p1 start: foe ticks 2; p1 end: each p1 creature +Poison 1
    expect(keywordValue(foe, "Poison")).toBe(3);
    expect(foe.damage).toBe(2); // only the first tick has landed
    expect(keywordValue(toxoid, "Poison")).toBe(0); // own side untouched
  });
});

describe("Bottomless Puncture (enemy creature Poison N; Tempys: enemy player Poison M)", () => {
  it("poisons a non-Tempys creature only", () => {
    const g = gameWith("bottomless-puncture");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // Uterra
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(keywordValue(foe, "Poison")).toBe(3);
    expect(g.state.players[1].poison).toBe(0);
  });

  it("also poisons the enemy player when the target is Tempys", () => {
    const g = gameWith("bottomless-puncture");
    const foe = spawnCreature(g, [], 1, "lightning-wyrm", 1, { lane: 0 })!; // Tempys
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(keywordValue(foe, "Poison")).toBe(3);
    expect(g.state.players[1].poison).toBe(1);
  });
});

describe("Primeval Ancient (end of your turn: gain N; Forge: copy if no enemies)", () => {
  it("spawns a copy when there are no enemy creatures", () => {
    const g = gameWith("primeval-ancient");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const ancients = lanesOf(g, 0, "primeval-ancient");
    expect(ancients).toHaveLength(2);
    expect(ancients.every((c) => c.level === 1)).toBe(true);
  });

  it("spawns no copy with an enemy in play, and gains 3 at end of turn", () => {
    const g = gameWith("primeval-ancient");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(lanesOf(g, 0, "primeval-ancient")).toHaveLength(1);
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].health).toBe(123);
  });
});

describe("Ramble, Eternal Witness (Forge: shuffle next level into deck / L3 Spawn from deck)", () => {
  it("L1 shuffles a level 2 Ramble into the deck", () => {
    const g = gameWith("ramble-eternal-witness");
    expect(g.state.players[0].deck).toHaveLength(25);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const deck = g.state.players[0].deck;
    expect(deck).toHaveLength(26);
    expect(deck.some((i) => i.defId === "ramble-eternal-witness" && i.level === 2)).toBe(true);
  });

  it("L3 spawns a copy of a random deck creature (deck untouched)", () => {
    const g = gameWith("ramble-eternal-witness");
    addToHand(g, 0, "ramble-eternal-witness", 3);
    playLastAdded(g, 0);
    const rambles = lanesOf(g, 0, "ramble-eternal-witness");
    expect(rambles).toHaveLength(2);
    expect(rambles.map((c) => c.level).sort()).toEqual([1, 3]);
    expect(g.state.players[0].deck).toHaveLength(25); // the Spawn is a copy
  });
});

describe("Wegu's Embrace (+N/+N and this-turn battle-damage drain)", () => {
  it("buffs and drains on battle damage to the enemy player, expiring at end of turn", () => {
    const g = gameWith("wegus-embrace");
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, hydra.uid);
    expect([hydra.attack, hydra.health]).toEqual([7, 10]);
    expect(hydra.grantedAbilities).toContain("uterra:wegus-drain");
    g.state.players[0].health = 100;
    runBatches(g, [], collectInto(() => dealPlayerDamage(g, [], 1, 4, hydra, true)));
    expect(g.state.players[0].health).toBe(104); // drained the 4 dealt
    expect(g.state.players[1].health).toBe(116);
    applyAction(g, { type: "endTurn" }); // "this turn" expires
    expect(hydra.grantedAbilities).toHaveLength(0);
    runBatches(g, [], collectInto(() => dealPlayerDamage(g, [], 1, 4, hydra, true)));
    expect(g.state.players[0].health).toBe(104); // no more drain
  });
});
