import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript, grantKeyword,
  hasKeyword, healPlayer, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set5 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.json", import.meta.url), "utf8")) as ScrapedSet;
const set51 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set52 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set22 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.2.json", import.meta.url), "utf8")) as ScrapedSet; // ice-torrent
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet; // technognome
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra
const cards = loadCards(set5, set51, set52, set22, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (leveled plays, tokens, support cards). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "ash-maiden", "blizzard-shaman", "draconic-echoes", "everflame-aura", "flame-jet",
  "leyline-tyrant", "shatterbolt", "smolderscale-dragon", "sparkstone-elemental",
  "torrent-valkyrie", "zarox-the-raging", "primordial-invoker", "windspark-elemental",
  "dragonwake",
  "ice-torrent", // Set 2.2 support card scripted for Torrent Valkyrie
];

describe("Set 5 Tempys registration", () => {
  it("all 14 cards + ice-torrent have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Ash Maiden (friendly battle damage to a player -> that creature +N/+N)", () => {
  it("buffs itself and other friendly creatures that hit a player", () => {
    const g = gameWith("ash-maiden");
    const maiden = spawnCreature(g, [], 0, "ash-maiden", 1, { lane: 4 })!; // 3/6
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 })!; // 4/7
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "endTurn" }); // p0 turn start: both offensive
    applyAction(g, { type: "battle" }); // both hit face: 3 + 4
    expect(g.state.players[1].health).toBe(120 - 7);
    expect(maiden.attack).toBe(4); // 3 + 1 (its own trigger)
    expect(maiden.health).toBe(7);
    expect(hydra.attack).toBe(5); // 4 + 1 (Maiden's watcher)
    expect(hydra.health).toBe(8);
  });
});

describe("Blizzard Shaman (Forge: move a random other friendly creature to a random open space)", () => {
  it("moves exactly one other friendly creature into an open space", () => {
    const g = gameWith("blizzard-shaman");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter((c) => c !== null)).toHaveLength(3);
    expect(lanes[2]!.defId).toBe("blizzard-shaman");
    // one of the original lanes was vacated, one previously-open lane is filled
    expect([lanes[0], lanes[1]].filter((c) => c !== null)).toHaveLength(1);
    expect([lanes[3], lanes[4]].filter((c) => c !== null)).toHaveLength(1);
    expect([lanes[3], lanes[4]].find((c) => c !== null)!.defId).toBe("cavern-hydra");
  });
});

describe("Everflame Aura (N to an enemy creature, or Mobility M to a friendly)", () => {
  it("deals 7 to a chosen enemy creature", () => {
    const g = gameWith("everflame-aura");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(7);
  });

  it("gives a chosen friendly creature Mobility 1", () => {
    const g = gameWith("everflame-aura");
    const mine = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(keywordValue(mine, "Mobility")).toBe(1);
  });
});

describe("Flame Jet (N to a creature, +3 more at a Rank threshold)", () => {
  it("deals 3 at Rank 1", () => {
    const g = gameWith("flame-jet");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(3);
  });

  it("deals 6 at Rank 2", () => {
    const g = gameWith("flame-jet");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(6);
  });
});

describe("Leyline Tyrant (Ambush: enemy heal on their turn)", () => {
  it("ambushes when the enemy player gains health on their turn", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-tyrant");
    const initial = collectInto(() => healPlayer(g, [], 0, 5)); // p0 (active) heals
    runBatches(g, [], initial);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // any action runs the ambush check
    const lanes = g.state.players[1].lanes.filter((l) => l !== null);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.defId).toBe("leyline-tyrant");
    expect(lanes[0]!.attack).toBe(6); // L1 6/4
    expect(lanes[0]!.health).toBe(4);
    expect(g.state.players[1].hand).toHaveLength(5); // tyrant left the hand
    const discard = g.state.players[1].discard;
    expect(discard.some((i) => i.defId === "leyline-tyrant" && i.level === 1)).toBe(true);
    expect(discard.some((i) => i.defId === "leyline-tyrant" && i.level === 2)).toBe(true); // leveled copy
  });

  it("does not ambush without an enemy heal", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-tyrant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].lanes.every((l) => l === null)).toBe(true);
  });
});

describe("Shatterbolt (Negate Armor this turn, then N damage to that creature or player)", () => {
  it("punches through creature Armor, and Armor returns next turn", () => {
    const g = gameWith("shatterbolt");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!; // 3/3
    foe.health = 10; // survives the bolt for the armor-returns check
    grantKeyword([], foe, { keyword: "Armor", value: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(5); // Armor negated: nothing absorbed
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" }); // p0 turn start: armorUsed resets
    const initial = collectInto(() => dealCreatureDamage(g, [], foe, 2));
    runBatches(g, [], initial);
    expect(foe.damage).toBe(5); // Armor 2 absorbs the 2 again
  });

  it("negates player Armor and damages the player", () => {
    const g = gameWith("shatterbolt");
    g.state.players[1].armor = 4;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: -2 });
    expect(g.state.players[1].health).toBe(120 - 5);
  });
});

describe("Smolderscale Dragon (end of your turn: N to each enemy creature)", () => {
  it("deals 1 to each enemy creature at the end of your turn only", () => {
    const g = gameWith("smolderscale-dragon");
    const dragon = spawnCreature(g, [], 0, "smolderscale-dragon", 1, { lane: 2 })!;
    expect(hasKeyword(dragon, "Defender")).toBe(true); // inherent at L1
    const a = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    const b = spawnCreature(g, [], 1, "technognome", 1, { lane: 1 })!;
    applyAction(g, { type: "endTurn" }); // p0's turn ends: burn
    expect(a.damage).toBe(1);
    expect(b.damage).toBe(1);
    applyAction(g, { type: "endTurn" }); // p1's turn ends: no burn
    expect(a.damage).toBe(1);
    expect(b.damage).toBe(1);
  });
});

describe("Sparkstone Elemental (continuous: creatures cannot have Defender)", () => {
  it("strips Defender on entry and restores it when destroyed", () => {
    const g = gameWith("sparkstone-elemental");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    grantKeyword([], foe, { keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // sparkstone enters
    expect(hasKeyword(foe, "Defender")).toBe(false);
    const spark = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => dealCreatureDamage(g, [], spark, 99));
    runBatches(g, [], initial);
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(hasKeyword(foe, "Defender")).toBe(true); // leaves play -> Defender returns
  });

  it("strips Defender from creatures entering later", () => {
    const g = gameWith("sparkstone-elemental");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    let iniog!: ReturnType<typeof spawnCreature>;
    const initial = collectInto(() => {
      iniog = spawnCreature(g, [], 1, "iniog-carrion-demon", 1, { lane: 0 }); // inherent Defender
    });
    runBatches(g, [], initial);
    expect(hasKeyword(iniog!, "Defender")).toBe(false);
  });
});

describe("Torrent Valkyrie (L2 Forge: put a level 2 Ice Torrent into hand)", () => {
  it("puts a level 2 Ice Torrent into hand", () => {
    const g = gameWith("torrent-valkyrie");
    addToHand(g, 0, "torrent-valkyrie", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.players[0].hand.some((i) => i.defId === "ice-torrent" && i.level === 2)).toBe(true);
  });

  it("Ice Torrent (support card) is Free at L2 and deals 3 to the enemy player", () => {
    const g = gameWith("torrent-valkyrie");
    addToHand(g, 0, "ice-torrent", 2);
    applyAction(g, { type: "playCard", handIndex: 5 });
    expect(g.state.players[1].health).toBe(120 - 3);
    expect(g.state.playsLeft).toBe(2); // Free: no play consumed
  });
});

describe("Zarox, the Raging (battle strike + Allied Nekrium growth)", () => {
  it("may deal its battle damage to an enemy creature on your turn", () => {
    const g = gameWith("zarox-the-raging");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!; // 3/3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 }); // 2/8
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" }); // p0: zarox offensive
    applyAction(g, { type: "battle" }); // hits face for 2 -> prompt
    expect(g.state.players[1].health).toBe(120 - 2);
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(2);
  });

  it("does nothing when the strike is declined", () => {
    const g = gameWith("zarox-the-raging");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(foe.damage).toBe(0);
  });

  it("Allied Nekrium: gets +1 attack when a creature is destroyed with Nekrium in hand", () => {
    const g = gameWith("zarox-the-raging");
    const zarox = spawnCreature(g, [], 0, "zarox-the-raging", 1, { lane: 4 })!;
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    addToHand(g, 0, "cacklebones"); // Nekrium card -> Allied active
    const initial = collectInto(() => dealCreatureDamage(g, [], foe, 99));
    runBatches(g, [], initial);
    expect(zarox.attack).toBe(3); // 2 + 1
  });

  it("stays put without a Nekrium card in hand", () => {
    const g = gameWith("zarox-the-raging");
    const zarox = spawnCreature(g, [], 0, "zarox-the-raging", 1, { lane: 4 })!;
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!;
    const initial = collectInto(() => dealCreatureDamage(g, [], foe, 99));
    runBatches(g, [], initial);
    expect(zarox.attack).toBe(2);
  });
});

describe("Primordial Invoker (Forge: N damage split at random among enemies and their player)", () => {
  it("deals all 4 to the enemy player when they control no creatures", () => {
    const g = gameWith("primordial-invoker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].health).toBe(120 - 4);
  });

  it("splits exactly 4 damage between the enemy creature and player", () => {
    const g = gameWith("primordial-invoker");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!; // 3/3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(foe.damage + (120 - g.state.players[1].health)).toBe(4);
  });
});

describe("Dragonwake (Spawn a copy of a Dragon from your deck; L1/L2 copies expire)", () => {
  it("L1 spawns an Aggressive dragon copy and destroys it at end of your turn", () => {
    const g = gameWith("smolderscale-dragon"); // deck full of Dragons
    addToHand(g, 0, "dragonwake", 1);
    applyAction(g, { type: "playCard", handIndex: 5 });
    const copy = g.state.players[0].lanes.find((c) => c?.defId === "smolderscale-dragon");
    expect(copy).toBeTruthy();
    expect(copy!.level).toBe(1);
    expect(hasKeyword(copy!, "Aggressive")).toBe(true);
    expect(copy!.grantedAbilities).toContain("tempys:set2-binben-expire");
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].lanes.every((c) => c === null)).toBe(true); // expired
  });

  it("L3 copy keeps Aggressive and does not expire", () => {
    const g = gameWith("smolderscale-dragon");
    addToHand(g, 0, "dragonwake", 3);
    applyAction(g, { type: "playCard", handIndex: 5 });
    const copy = g.state.players[0].lanes.find((c) => c?.defId === "smolderscale-dragon");
    expect(copy).toBeTruthy();
    expect(hasKeyword(copy!, "Aggressive")).toBe(true);
    expect(copy!.grantedAbilities).toHaveLength(0);
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].lanes.some((c) => c?.defId === "smolderscale-dragon")).toBe(true);
  });
});

describe("Draconic Echoes (player effect: deferred end-of-turn burn)", () => {
  it("L1 deals 1-10 to the enemy player at this turn end and your next, then expires", () => {
    const g = gameWith("draconic-echoes");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playerEffects).toHaveLength(1);
    applyAction(g, { type: "endTurn" }); // p0: first burn
    const after1 = g.state.players[1].health;
    expect(120 - after1).toBeGreaterThanOrEqual(1);
    expect(120 - after1).toBeLessThanOrEqual(10);
    applyAction(g, { type: "endTurn" }); // p1: condition fails, no trigger
    expect(g.state.players[1].health).toBe(after1);
    applyAction(g, { type: "endTurn" }); // p0: second burn, then expires
    const total = 120 - g.state.players[1].health;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(20);
    expect(g.state.playerEffects).toHaveLength(0);
  });

  it("L3 burns 1-20 at the end of each of your turns (permanent)", () => {
    const g = gameWith("draconic-echoes");
    addToHand(g, 0, "draconic-echoes", 3);
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyAction(g, { type: "endTurn" }); // p0: first burn
    applyAction(g, { type: "endTurn" }); // p1: no trigger
    const before = g.state.players[1].health;
    applyAction(g, { type: "endTurn" }); // p0: burns again
    const dealt = before - g.state.players[1].health;
    expect(dealt).toBeGreaterThanOrEqual(1);
    expect(dealt).toBeLessThanOrEqual(20);
    expect(g.state.playerEffects).toHaveLength(1); // never expires
  });
});
