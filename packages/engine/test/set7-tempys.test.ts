import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, destroyCreature, getCardScript, getStats,
  hasKeyword, loadCards, refreshStatics, runBatches, spawnCreature,
  type CreatureState, type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set7 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.json", import.meta.url), "utf8")) as ScrapedSet;
const set71 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set72 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set73 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.3.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra, lightning-wyrm
const cards = loadCards(set7, set71, set72, set73, set1);

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

/** Destroy a creature outside of an action and resolve the resulting batch. */
function kill(g: Game, c: CreatureState): void {
  runBatches(g, [], collectInto(() => destroyCreature(g, [], c)));
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
  "blitzmane-the-destroyer", "cauldron-mystic", "chaos-twister", "dragonkeeper-shaman",
  "fit-of-rage", "iceshard-berserker", "slumbering-shrine", "stampeding-mongosaur",
  "unstable-asir", "uranti-stormshaper", "warhound-raider", "cyclone-rider",
  "nug-fury-fists", "avarice-the-insatiable", "blazing-hostility",
  "quakeasaurus-wrecks", "ritual-of-the-elements",
  // support cards scripted in set7-tempys.ts
  "magmify", "lava-golem", "lightning-titan",
];

describe("Set 7 Tempys registration", () => {
  it("all 17 cards + 3 support cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });

  it("frost-hulk, lightning-wyrm and warhound-courser have data (vanilla/keywords: no script needed)", () => {
    expect(cards["frost-hulk"]).toBeTruthy();
    expect(cards["lightning-wyrm"]).toBeTruthy();
    // parser now tolerates "{{Free}}. <br>{{Aggressive}}" punctuation: Aggressive is inherent
    expect(cards["warhound-courser"]!.levels[0]!.keywords?.some((k) => k.keyword === "Aggressive")).toBe(true);
  });
});

describe("Blitzmane, the Destroyer (Raid: its attack to the opposing creature, else the enemy player)", () => {
  it("deals its attack to the opposing creature on Raid", () => {
    const g = gameWith("blitzmane-the-destroyer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 5/4
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // 9/9, vanilla
    applyAction(g, { type: "endTurn" });
    expect(foe.damage).toBe(5);
    expect(g.state.players[1].health).toBe(120); // the player is untouched
  });

  it("hits the enemy player instead when unopposed", () => {
    const g = gameWith("blitzmane-the-destroyer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].health).toBe(115); // 120 - 5
  });

  it("does nothing when fewer than three friendly creatures battled", () => {
    const g = gameWith("blitzmane-the-destroyer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    for (const c of g.state.players[0].lanes) if (c) c.hasBattled = true; // only two
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!;
    applyAction(g, { type: "endTurn" });
    expect(foe.damage).toBe(0);
    expect(g.state.players[1].health).toBe(120);
  });
});

describe("Cauldron Mystic (friendly creature enters play — itself included: random enemy creature or player burn)", () => {
  it("burns the enemy player on its own entry and on later friendly entries", () => {
    const g = gameWith("cauldron-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // its own entry burns
    expect(g.state.players[1].health).toBe(118); // no enemy creatures: always the player
    spawn(g, 0, "cavern-hydra", 1, 1); // another friendly entry burns again
    expect(g.state.players[1].health).toBe(116);
  });

  it("does not react to enemy entries", () => {
    const g = gameWith("cauldron-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].health).toBe(118);
    spawn(g, 1, "frost-hulk", 1, 0); // enemy entry: no trigger
    expect(g.state.players[1].health).toBe(118);
    expect(g.state.players[0].health).toBe(120);
  });
});

describe("Chaos Twister (N to an enemy creature; adjacent enemies too if it is in Formation)", () => {
  it("splashes onto the adjacent enemy creatures when the target is in Formation", () => {
    const g = gameWith("chaos-twister");
    const a = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 1 })!;
    const mid = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 2 })!;
    const b = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 3 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("enemyCreature");
    chooseTarget(g, mid.uid);
    expect(a.damage).toBe(6);
    expect(mid.damage).toBe(6);
    expect(b.damage).toBe(6);
  });

  it("hits only the target when it is not in Formation", () => {
    const g = gameWith("chaos-twister");
    const edge = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // edge: never Formation
    const other = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, edge.uid);
    expect(edge.damage).toBe(6);
    expect(other.damage).toBe(0);
  });
});

describe("Dragonkeeper Shaman (Raid: N damage to each enemy creature)", () => {
  it("sweeps the enemy board for 3 on Raid", () => {
    const g = gameWith("dragonkeeper-shaman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    const a = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!;
    const b = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 3 })!;
    applyAction(g, { type: "endTurn" });
    expect(a.damage).toBe(3);
    expect(b.damage).toBe(3);
  });
});

describe("Fit of Rage (Overload; friendly opposed creature gets +attack equal to its opposer this turn)", () => {
  it("grants the opposer's attack and is removed from the game", () => {
    const g = gameWith("fit-of-rage");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 }); // 9/9 opposing
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("friendlyCreature");
    chooseTarget(g, mine.uid);
    expect(getStats(g, mine).attack).toBe(13); // 4 + 9
    expect(g.state.players[0].removed.some((i) => i.defId === "fit-of-rage")).toBe(true); // Overload
  });

  it("fizzles with no opposed friendly creature", () => {
    const g = gameWith("fit-of-rage");
    const mine = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // unopposed
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no legal target: the prompt never appears
    expect(getStats(g, mine).attack).toBe(4);
  });
});

describe("Iceshard Berserker (+N attack while opposed)", () => {
  it("gains +6 attack only while opposed", () => {
    const g = gameWith("iceshard-berserker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/6
    const c = g.state.players[0].lanes[0]!;
    expect(getStats(g, c).attack).toBe(3);
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!;
    expect(getStats(g, c).attack).toBe(9); // opposed
    kill(g, foe);
    expect(getStats(g, c).attack).toBe(3); // unopposed again
  });
});

describe("Slumbering Shrine (Solbind Magmify; your spells may Negate Defender from a friendly creature)", () => {
  it("Solbind shuffles one Magmify into the deck", () => {
    const g = gameWith("slumbering-shrine");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand];
    expect(all.filter((i) => i.defId === "magmify")).toHaveLength(1);
  });

  it("Magmify sets attack to current health, then the Shrine offers the Negate", () => {
    const g = gameWith("slumbering-shrine");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 0/14 Defender
    const shrine = g.state.players[0].lanes[0]!;
    addToHand(g, 0, "magmify");
    playLastAdded(g);
    expect(g.state.pending!.request.kind).toBe("friendlyCreature"); // Magmify's target
    chooseTarget(g, shrine.uid);
    expect(shrine.attack).toBe(14); // attack set to its health
    expect(g.state.pending!.request.kind).toBe("friendlyCreature"); // the Shrine's Negate offer
    expect(g.state.pending!.request.optional).toBe(true);
    chooseTarget(g, shrine.uid);
    expect(hasKeyword(shrine, "Defender")).toBe(false);
  });

  it("declining the Negate keeps Defender", () => {
    const g = gameWith("slumbering-shrine");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const shrine = g.state.players[0].lanes[0]!;
    addToHand(g, 0, "magmify");
    playLastAdded(g);
    chooseTarget(g, shrine.uid); // Magmify
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false }); // decline the Negate
    expect(hasKeyword(shrine, "Defender")).toBe(true);
  });
});

describe("Stampeding Mongosaur (Raid: N damage to the enemy player)", () => {
  it("deals 6 to the enemy player on Raid", () => {
    const g = gameWith("stampeding-mongosaur");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].health).toBe(114); // 120 - 6
  });
});

describe("Unstable Asir (Vengeance: damage equal to its attack to the enemy player)", () => {
  it("deals its attack to the enemy player when destroyed", () => {
    const g = gameWith("unstable-asir");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/6
    kill(g, g.state.players[0].lanes[0]!);
    expect(g.state.players[1].health).toBe(117); // 120 - 3
  });
});

describe("Uranti Stormshaper (turn start: Spawn Lightning Wyrms)", () => {
  it("L1 Spawns a single level-1 Lightning Wyrm at your turn start", () => {
    const g = gameWith("uranti-stormshaper");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g);
    const wyrms = lanesOf(g, 0, "lightning-wyrm");
    expect(wyrms).toHaveLength(1);
    expect(wyrms[0]!.level).toBe(1);
    expect(hasKeyword(wyrms[0]!, "Aggressive")).toBe(true); // inherent from the Set 1 data
  });

  it("L3 fills every open space with level-3 Lightning Wyrms", () => {
    const g = gameWith("uranti-stormshaper");
    addToHand(g, 0, "uranti-stormshaper", 3);
    playLastAdded(g, 2);
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // one space occupied
    endRound(g);
    const wyrms = lanesOf(g, 0, "lightning-wyrm");
    expect(wyrms).toHaveLength(3); // 5 spaces - the Stormshaper - the hydra
    expect(wyrms.every((w) => w.level === 3)).toBe(true);
    expect(g.state.players[0].lanes.every((c) => !!c)).toBe(true); // board full
  });
});

describe("Warhound Raider (Solbind Warhound Courser; Aggressive while a friendly Courser is in play)", () => {
  it("Solbind shuffles one Warhound Courser into the deck", () => {
    const g = gameWith("warhound-raider");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand];
    expect(all.filter((i) => i.defId === "warhound-courser")).toHaveLength(1);
  });

  it("has Aggressive only while a friendly Warhound Courser is in play", () => {
    const g = gameWith("warhound-raider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const raider = g.state.players[0].lanes[0]!;
    refreshStatics(g);
    expect(hasKeyword(raider, "Aggressive")).toBe(false);
    const courser = spawn(g, 0, "warhound-courser", 1, 1);
    expect(hasKeyword(courser, "Aggressive")).toBe(true); // enterPlay fix-up (unparsed in the data)
    refreshStatics(g);
    expect(hasKeyword(raider, "Aggressive")).toBe(true);
    kill(g, courser);
    refreshStatics(g);
    expect(hasKeyword(raider, "Aggressive")).toBe(false);
  });
});

describe("Cyclone Rider (moves to oppose an enemy creature that enters unopposed)", () => {
  it("moves to the space opposing the unopposed entry", () => {
    const g = gameWith("cyclone-rider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const rider = g.state.players[0].lanes[2]!;
    spawn(g, 1, "frost-hulk", 1, 4); // enters unopposed
    expect(rider.lane).toBe(4);
    expect(g.state.players[0].lanes[2]).toBeNull();
  });

  it("stays put when the enemy creature enters opposed", () => {
    const g = gameWith("cyclone-rider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const rider = g.state.players[0].lanes[2]!;
    spawn(g, 1, "frost-hulk", 1, 0); // opposed by the hydra
    expect(rider.lane).toBe(2);
  });
});

describe("Nug, Fury Fists (turn start: each OTHER friendly creature punches its opposer)", () => {
  it("other friendly creatures deal their attack to their opposers; Nug does not", () => {
    const g = gameWith("nug-fury-fists");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 7/6
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }); // 4/7
    const foeA = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // opposing Nug
    const foeB = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 1 })!; // opposing the hydra
    endRound(g);
    expect(foeA.damage).toBe(0); // "each OTHER": Nug itself never punches
    expect(foeB.damage).toBe(4); // the hydra's attack
  });
});

describe("Avarice, the Insatiable (Forge: discard down to one at random; an additional spell this turn)", () => {
  it("L1 discards down to one card and grants an extra play", () => {
    const g = gameWith("avarice-the-insatiable");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[0].hand).toHaveLength(1);
    // 3 random discards + the level-2 copy of the played Avarice
    expect(g.state.players[0].discard).toHaveLength(4);
    expect(g.state.playsLeft).toBe(2); // 2 - 1 (the Forge) + 1 (the additional spell)
  });

  it("L3 grants the extra play without discarding", () => {
    const g = gameWith("avarice-the-insatiable");
    addToHand(g, 0, "avarice-the-insatiable", 3);
    playLastAdded(g, 0);
    expect(g.state.players[0].hand).toHaveLength(5); // untouched
    expect(g.state.players[0].discard).toHaveLength(0); // L3 is max level: no level-up copy either
    expect(g.state.playsLeft).toBe(2);
  });
});

describe("Blazing Hostility (N to an enemy creature; N to the enemy player too if it is Nekrium)", () => {
  it("burns the enemy player as well when the target is Nekrium", () => {
    const g = gameWith("blazing-hostility");
    const foe = spawnCreature(g, [], 1, "bride-of-frankenbaum", 1, { lane: 0 })!; // Nekrium
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(foe.damage).toBe(6);
    expect(g.state.players[1].health).toBe(114); // 120 - 6
  });

  it("only hits the creature when it is not Nekrium", () => {
    const g = gameWith("blazing-hostility");
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 0 })!; // Tempys token
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(foe.damage).toBe(6);
    expect(g.state.players[1].health).toBe(120);
  });
});

describe("Quakeasaurus Wrecks (Raid: mult x friendly Dinosaurs to a random enemy creature and the enemy player)", () => {
  it("deals 2x the Dinosaur count to both on Raid", () => {
    const g = gameWith("quakeasaurus-wrecks");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // Dinosaur #1
    spawnCreature(g, [], 0, "stampeding-mongosaur", 1, { lane: 1 }); // Dinosaur #2
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    threeBattlers(g);
    const foe = spawnCreature(g, [], 1, "frost-hulk", 1, { lane: 3 })!;
    applyAction(g, { type: "endTurn" });
    expect(foe.damage).toBe(4); // 2 dinos x 2 (only enemy creature: the random pick is forced)
    // 120 - 4 (Quakeasaurus) - 6 (the Mongosaur's own Raid also fired: 3 battlers)
    expect(g.state.players[1].health).toBe(110);
  });
});

describe("Ritual of the Elements (Spawn a Lava Golem, Frost Hulk, or Lightning Titan at random)", () => {
  it("Spawns exactly one of the three tokens", () => {
    const pool = new Set(["lava-golem", "frost-hulk", "lightning-titan"]);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const g = createGame(cards, deckOf("ritual-of-the-elements"), deckOf("cavern-hydra"), seed);
      applyAction(g, { type: "playCard", handIndex: 0 });
      const mine = g.state.players[0].lanes.filter((c): c is CreatureState => !!c);
      expect(mine).toHaveLength(1);
      expect(pool.has(mine[0]!.defId)).toBe(true);
      expect(mine[0]!.level).toBe(1);
      seen.add(mine[0]!.defId);
    }
    expect(seen.size).toBe(3); // all three outcomes reachable
  });

  it("Lava Golem's +4 attack aura includes itself and other friendly creatures", () => {
    const g = gameWith("ritual-of-the-elements");
    const golem = spawn(g, 0, "lava-golem", 1, 0);
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    expect(getStats(g, golem).attack).toBe(8); // 4 + 4
    expect(getStats(g, hydra).attack).toBe(8); // 4 + 4
  });

  it("Lightning Titan grants Aggressive to friendly creatures including itself", () => {
    const g = gameWith("ritual-of-the-elements");
    const titan = spawn(g, 0, "lightning-titan", 1, 0);
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    refreshStatics(g);
    expect(hasKeyword(titan, "Aggressive")).toBe(true);
    expect(hasKeyword(hydra, "Aggressive")).toBe(true);
  });
});
