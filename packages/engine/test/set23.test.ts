import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, destroyCreature, getCardScript, getStats, hasKeyword,
  keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set23 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.3.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set2, set23);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

/** Inject an extra card into a hand (Allied fodder, high-level plays). */
function addToHand(g: Game, defId: string, level = 1): void {
  g.state.players[0].hand.push({ uid: g.state.nextUid++, defId, level, owner: 0 });
}

describe("Set 2.3 script registration", () => {
  it("registers every Set 2.3 card with non-trivial text", () => {
    const scripted = [
      "byzerak-frostmaiden", "cindersmoke-wyvern", "esperian-steelplate", "frostshatter-strike",
      "ironmind-acolyte", "legion-titan", "nethershriek", "onyxium-allomancer",
      "sonic-burst", "sorrow-harvester", "stranglevine-hydra", "umbruk-icecrusher",
      "uranti-warstoker", "uterradon-ridgeback",
      "netherdrake", // Token support card for Nethershriek
    ];
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
    // fangwood-bear is vanilla: no script
  });

  it("power-torrent stays registered from set5-alloyin.ts (skipped in set23.ts)", () => {
    expect(cards["power-torrent"]).toBeTruthy();
    expect(getCardScript("power-torrent")).not.toBeNull();
  });
});

describe("Byzerak Frostmaiden (Forge/Flank: opposed drain; Allied Tempys: Mobility)", () => {
  it("Forge opposed: the opposing creature gets -2 attack and this gets +2 attack", () => {
    const g = gameWith("byzerak-frostmaiden");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 1/9
    expect(g.state.players[1].lanes[1]!.attack).toBe(2); // 4 - 2
    expect(g.state.players[0].lanes[1]!.attack).toBe(3); // 1 + 2
  });

  it("Flank: the drain fires again when it moves into an opposed space", () => {
    const g = gameWith("byzerak-frostmaiden");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // unopposed: no drain
    const maiden = g.state.players[0].lanes[0]!;
    expect(maiden.attack).toBe(1);
    const hydra = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    maiden.keywords.push({ keyword: "Mobility", value: 1 });
    maiden.defensive = false;
    applyAction(g, { type: "move", uid: maiden.uid, lane: 1 });
    expect(hydra.attack).toBe(2);
    expect(maiden.attack).toBe(3);
  });

  it("Allied Tempys: gets Mobility 1 with a Tempys card in hand", () => {
    const g = gameWith("byzerak-frostmaiden");
    addToHand(g, "frostshatter-strike"); // Tempys
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Mobility")).toBe(1);
  });

  it("no Allied without a Tempys card in hand", () => {
    const g = gameWith("byzerak-frostmaiden"); // deck is all Nekrium
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Mobility")).toBe(0);
  });
});

describe("Cindersmoke Wyvern (Flank: its attack to the opposing creature, else the enemy player)", () => {
  it("deals its attack to the opposing creature when it moves into an opposed space", () => {
    const g = gameWith("cindersmoke-wyvern");
    const wyvern = spawnCreature(g, [], 0, "cindersmoke-wyvern", 1, { lane: 0 })!; // 3/7, Mobility 1
    const hydra = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!; // 4/7
    wyvern.defensive = false;
    applyAction(g, { type: "move", uid: wyvern.uid, lane: 1 });
    expect(hydra.damage).toBe(3);
    expect(g.state.players[1].health).toBe(120);
  });

  it("deals its attack to the enemy player when the space is unopposed", () => {
    const g = gameWith("cindersmoke-wyvern");
    const wyvern = spawnCreature(g, [], 0, "cindersmoke-wyvern", 1, { lane: 0 })!;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // not opposing lane 1
    wyvern.defensive = false;
    applyAction(g, { type: "move", uid: wyvern.uid, lane: 1 });
    expect(g.state.players[1].health).toBe(117);
    expect(g.state.players[1].lanes[2]!.damage).toBe(0);
  });
});

describe("Esperian Steelplate (Activate: heal N from each friendly creature; Allied Alloyin: Armor)", () => {
  it("Activate heals 3 damage from every friendly creature", () => {
    const g = gameWith("esperian-steelplate");
    const plate = spawnCreature(g, [], 0, "esperian-steelplate", 1, { lane: 0 })!; // 3/6
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    plate.damage = 2;
    hydra.damage = 4;
    plate.defensive = false;
    applyAction(g, { type: "activate", uid: plate.uid });
    expect(plate.damage).toBe(0); // healed 2 (capped at damage taken)
    expect(hydra.damage).toBe(1); // 4 - 3
  });

  it("Allied Alloyin: gets Armor 2 with an Alloyin card in hand", () => {
    const g = gameWith("esperian-steelplate");
    addToHand(g, "sonic-burst"); // Alloyin
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Armor")).toBe(2);
  });
});

describe("Ironmind Acolyte (Forge: five or more cards in hand -> additional play)", () => {
  it("grants the additional play when 5 cards remain after playing it", () => {
    const g = gameWith("ironmind-acolyte");
    addToHand(g, "sonic-burst"); // 6 cards in hand
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5 remain
    expect(g.state.playsLeft).toBe(2); // 2 - 1 (the play) + 1 (the Forge)
  });

  it("does nothing with fewer than 5 cards in hand", () => {
    const g = gameWith("ironmind-acolyte"); // 5 cards in hand
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4 remain
    expect(g.state.playsLeft).toBe(1);
  });
});

describe("Legion Titan (Forge: +N/+N per enemy creature with cap-or-less attack)", () => {
  it("L2 counts both 4-attack enemy creatures (cap 5)", () => {
    const g = gameWith("legion-titan");
    g.state.players[0].hand[0]!.level = 2; // 8/8
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4 attack
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const titan = g.state.players[0].lanes[2]!;
    expect([titan.attack, titan.health]).toEqual([12, 12]); // +2/+2 x2
  });

  it("L1 ignores creatures above 3 attack", () => {
    const g = gameWith("legion-titan");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack > 3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/4
    const titan = g.state.players[0].lanes[2]!;
    expect([titan.attack, titan.health]).toEqual([4, 4]);
  });
});

describe("Nethershriek (Spawn a Netherdrake; the drake destroys the opposing creature)", () => {
  it("spawns a 4/4 Netherdrake that destroys the opposing level 1 creature", () => {
    const g = gameWith("nethershriek");
    // only lane 2 is open, so the random Spawn lands there
    for (const lane of [0, 1, 3, 4]) spawnCreature(g, [], 0, "cavern-hydra", 1, { lane });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const drake = g.state.players[0].lanes[2]!;
    expect(drake.defId).toBe("netherdrake");
    expect([drake.attack, drake.health]).toEqual([4, 4]);
    expect(g.state.players[1].lanes[2]).toBeNull(); // destroyed on entry
  });

  it("L1 Netherdrake spares a level 2 opposing creature", () => {
    const g = gameWith("nethershriek");
    for (const lane of [0, 1, 3, 4]) spawnCreature(g, [], 0, "cavern-hydra", 1, { lane });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 }); // level 2 > cap 1
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes[2]!.defId).toBe("netherdrake");
    expect(g.state.players[1].lanes[2]).not.toBeNull(); // too high a level
  });
});

describe("Onyxium Allomancer (Allied Nekrium: Regenerate; Activate: discard and level up)", () => {
  it("Activate discards a card and levels it up", () => {
    const g = gameWith("onyxium-allomancer");
    const allomancer = spawnCreature(g, [], 0, "onyxium-allomancer", 1, { lane: 0 })!;
    const handSize = g.state.players[0].hand.length;
    allomancer.defensive = false;
    applyAction(g, { type: "activate", uid: allomancer.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(handSize - 1);
    const levels = g.state.players[0].discard.map((c) => c.level);
    expect(levels).toEqual([1, 2]); // discarded original + leveled copy
  });

  it("Allied Nekrium: gets Regenerate 3 with a Nekrium card in hand", () => {
    const g = gameWith("onyxium-allomancer");
    addToHand(g, "sorrow-harvester"); // Nekrium
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Regenerate")).toBe(3);
  });
});

describe("Sonic Burst (give a creature -N attack)", () => {
  it("gives the chosen creature -8 attack", () => {
    const g = gameWith("sonic-burst");
    const hydra = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!; // 4 attack
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(-4); // 4 - 8
  });
});

describe("Sorrow Harvester (friendly Abomination destroyed on your turn: draw)", () => {
  it("draws a card when a friendly Abomination is destroyed on your turn", () => {
    const g = gameWith("sorrow-harvester");
    spawnCreature(g, [], 0, "sorrow-harvester", 1, { lane: 0 });
    const crawler = spawnCreature(g, [], 0, "corpse-crawler", 1, { lane: 1 })!; // Abomination
    destroyCreature(g, [], crawler);
    runBatches(g, [], []);
    expect(g.state.players[0].hand).toHaveLength(6); // 5 + 1 drawn
  });

  it("ignores non-Abomination deaths and deaths on the enemy turn", () => {
    const g = gameWith("sorrow-harvester");
    spawnCreature(g, [], 0, "sorrow-harvester", 1, { lane: 0 });
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // Hydra, not Abomination
    destroyCreature(g, [], hydra);
    runBatches(g, [], []);
    expect(g.state.players[0].hand).toHaveLength(5);
    const crawler = spawnCreature(g, [], 0, "corpse-crawler", 1, { lane: 1 })!;
    applyAction(g, { type: "endTurn" }); // now the enemy's turn
    destroyCreature(g, [], crawler);
    runBatches(g, [], []);
    expect(g.state.players[0].hand).toHaveLength(5); // not your turn: no draw
  });
});

describe("Stranglevine Hydra (battle damage to a player: gets Regenerate N)", () => {
  it("gains Regenerate 1 after hitting the enemy player", () => {
    const g = gameWith("stranglevine-hydra");
    const hydra = spawnCreature(g, [], 0, "stranglevine-hydra", 1, { lane: 2 })!; // 5/6
    passTurns(g, 2); // offensive
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(115);
    expect(keywordValue(hydra, "Regenerate")).toBe(1);
  });
});

describe("Umbruk Icecrusher (battle damage to a player: deal that much again; Allied Uterra)", () => {
  it("deals its battle damage to the player twice", () => {
    const g = gameWith("umbruk-icecrusher");
    spawnCreature(g, [], 0, "umbruk-icecrusher", 1, { lane: 2 }); // 6/2
    passTurns(g, 2); // offensive
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(108); // 120 - 6 - 6
  });

  it("Allied Uterra: gets +2/+2 and Breakthrough with an Uterra card in hand", () => {
    const g = gameWith("umbruk-icecrusher");
    addToHand(g, "uterradon-ridgeback"); // Uterra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const crusher = g.state.players[0].lanes[2]!;
    expect([crusher.attack, crusher.health]).toEqual([8, 4]);
    expect(hasKeyword(crusher, "Breakthrough")).toBe(true);
  });
});

describe("Uranti Warstoker (Forge: each other friendly Yeti gets +N attack this turn)", () => {
  it("buffs other friendly Yetis this turn, not itself", () => {
    const g = gameWith("uranti-warstoker");
    const icemage = spawnCreature(g, [], 0, "uranti-icemage", 1, { lane: 0 })!; // 2/8 Yeti
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 4 })!; // not a Yeti
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 6/5
    expect(getStats(g, icemage).attack).toBe(5); // 2 + 3 (temp)
    expect(icemage.attack).toBe(2); // this turn only
    expect(getStats(g, hydra).attack).toBe(4); // unchanged
    const warstoker = g.state.players[0].lanes[1]!;
    expect(getStats(g, warstoker).attack).toBe(6); // itself unchanged
  });
});

describe("Uterradon Ridgeback (battle damage to a player on your turn: friendly +N/+N)", () => {
  it("L1: each friendly creature gets +1/+1 after it hits the enemy player", () => {
    const g = gameWith("uterradon-ridgeback");
    const ridgeback = spawnCreature(g, [], 0, "uterradon-ridgeback", 1, { lane: 2 })!; // 7/4
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    passTurns(g, 2); // offensive
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(109); // 120 - 7 (ridgeback) - 4 (hydra)
    expect([ridgeback.attack, ridgeback.health]).toEqual([8, 5]);
    expect([hydra.attack, hydra.health]).toEqual([5, 8]);
    expect(hasKeyword(hydra, "Breakthrough")).toBe(false); // L1 grants no Breakthrough
  });

  it("L3: each friendly creature also gets Breakthrough", () => {
    const g = gameWith("uterradon-ridgeback");
    spawnCreature(g, [], 0, "uterradon-ridgeback", 3, { lane: 2 }); // 17/13
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    passTurns(g, 2);
    applyAction(g, { type: "battle" });
    expect([hydra.attack, hydra.health]).toEqual([8, 11]); // +4/+4
    expect(hasKeyword(hydra, "Breakthrough")).toBe(true);
  });
});

describe("Frostshatter Strike (N to an enemy creature; a friendly creature gets +N attack this turn)", () => {
  it("chains both targets: damage to the enemy, temp buff to the friendly", () => {
    const g = gameWith("frostshatter-strike");
    const friendly = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    const enemy = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("enemyCreature");
    expect(req1.options).toEqual([enemy.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: enemy.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("friendlyCreature");
    expect(req2.options).toEqual([friendly.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: friendly.uid });
    expect(enemy.damage).toBe(4);
    expect(getStats(g, friendly).attack).toBe(8); // 4 + 4 (temp)
    expect(friendly.attack).toBe(4); // this turn only
    expect(g.state.pending).toBeNull();
  });

  it("still offers the friendly buff when no enemy creature is in play", () => {
    const g = gameWith("frostshatter-strike");
    const friendly = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request; // enemy step fizzled, straight to the buff
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: friendly.uid });
    expect(getStats(g, friendly).attack).toBe(8);
  });

  it("deals the damage and stops when no friendly creature is in play", () => {
    const g = gameWith("frostshatter-strike");
    const enemy = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: enemy.uid });
    expect(enemy.damage).toBe(4);
    expect(g.state.pending).toBeNull(); // no second leg
  });
});
