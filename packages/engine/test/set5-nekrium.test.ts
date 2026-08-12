import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript, grantKeyword,
  hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set5 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.json", import.meta.url), "utf8")) as ScrapedSet;
const set51 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set52 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set21 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.1.json", import.meta.url), "utf8")) as ScrapedSet; // spirit-torrent
const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet; // oozeling-purple
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet; // technognome
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra
const cards = loadCards(set5, set51, set52, set21, set3, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (leveled plays, tokens, support cards). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "abyssal-maw", "bitterfrost-totem", "brood-horror", "cacklebones", "immortal-echoes",
  "iniog-carrion-demon", "leyline-demon", "necromoeba", "rot-wanderer", "scourge-hydra",
  "torrent-witch", "vigor-leech", "spiritstone-sentry", "xithian-tormentor",
  "varna-immortal-king",
  "spirit-torrent", // Set 2.1 support card scripted for Torrent Witch
];

describe("Set 5 Nekrium registration", () => {
  it("all 15 cards + spirit-torrent have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Abyssal Maw (Forge with another Abomination: enemy creature -N/-N)", () => {
  it("gives an enemy creature -3/-3 when another friendly Abomination is in play", () => {
    const g = gameWith("abyssal-maw");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // first Maw is alone: no trigger
    expect(g.state.pending).toBeNull();
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // second Maw: Abomination present
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(1);
    expect(foe.health).toBe(4);
  });
});

describe("Bitterfrost Totem (creature -N/-N, extra -2/-2 at a Rank threshold)", () => {
  it("gives -4/-4 at Rank 1", () => {
    const g = gameWith("bitterfrost-totem");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(0);
    expect(foe.health).toBe(3);
  });

  it("gives -6/-6 at Rank 2", () => {
    const g = gameWith("bitterfrost-totem");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(-2);
    expect(foe.health).toBe(1);
  });
});

describe("Brood Horror (another friendly entry: it gets +N/+N, this gets -N/-N)", () => {
  it("buffs the entering creature and shrinks itself", () => {
    const g = gameWith("brood-horror");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 5/5
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // second Brood Horror
    const first = g.state.players[0].lanes[0]!;
    const second = g.state.players[0].lanes[1]!;
    expect(second.attack).toBe(6);
    expect(second.health).toBe(6);
    expect(first.attack).toBe(4);
    expect(first.health).toBe(4);
  });
});

describe("Cacklebones (Forge: destroy an enemy level-capped creature; enemy +1 play next turn)", () => {
  it("destroys an enemy level 1 creature and grants the enemy an extra play next turn", () => {
    const g = gameWith("cacklebones");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
    applyAction(g, { type: "endTurn" }); // p1's turn starts -> bonus play kicks in
    expect(g.state.playsLeft).toBe(3); // 2 + Cacklebones bonus
  });

  it("cannot target a creature above its level, and grants no bonus", () => {
    const g = gameWith("cacklebones");
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 0 }); // level 2 > L1 cap
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[0]).not.toBeNull();
    applyAction(g, { type: "endTurn" });
    expect(g.state.playsLeft).toBe(2);
  });
});

describe("Iniog, Carrion Demon (grows Regenerate on deaths; replaces itself at end of turn)", () => {
  it("L1 is a Defender and gains Regenerate 1 when a creature is destroyed", () => {
    const g = gameWith("iniog-carrion-demon");
    const iniog = spawnCreature(g, [], 0, "iniog-carrion-demon", 1, { lane: 0 })!;
    expect(hasKeyword(iniog, "Defender")).toBe(true);
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    const initial = collectInto(() => dealCreatureDamage(g, [], foe, 99));
    runBatches(g, [], initial);
    expect(keywordValue(iniog, "Regenerate")).toBe(1);
  });

  it("L1 replaces itself with a level 2 Iniog at end of turn at Regenerate 5+", () => {
    const g = gameWith("iniog-carrion-demon");
    const iniog = spawnCreature(g, [], 0, "iniog-carrion-demon", 1, { lane: 2 })!;
    grantKeyword([], iniog, { keyword: "Regenerate", value: 5 });
    applyAction(g, { type: "endTurn" });
    const now = g.state.players[0].lanes[2]!;
    expect(now.defId).toBe("iniog-carrion-demon");
    expect(now.level).toBe(2);
    expect(now.attack).toBe(12); // L2 12/7
    expect(now.health).toBe(7);
  });

  it("L2 replaces itself with a level 3 Iniog at Regenerate 10+ (5 inherent + 5 grown)", () => {
    const g = gameWith("iniog-carrion-demon");
    const iniog = spawnCreature(g, [], 0, "iniog-carrion-demon", 2, { lane: 2 })!;
    grantKeyword([], iniog, { keyword: "Regenerate", value: 5 }); // 5 inherent + 5 = 10
    applyAction(g, { type: "endTurn" });
    const now = g.state.players[0].lanes[2]!;
    expect(now.level).toBe(3);
    expect(now.attack).toBe(24); // L3 24/13
  });

  it("L3 Vengeance puts a level 1 Iniog into its space", () => {
    const g = gameWith("iniog-carrion-demon");
    spawnCreature(g, [], 0, "iniog-carrion-demon", 3, { lane: 2 });
    const iniog = g.state.players[0].lanes[2]!;
    const initial = collectInto(() => dealCreatureDamage(g, [], iniog, 99));
    runBatches(g, [], initial);
    const c = g.state.players[0].lanes[2]!;
    expect(c.defId).toBe("iniog-carrion-demon");
    expect(c.level).toBe(1);
  });
});

describe("Leyline Demon (Ambush: enemy's third card of the turn)", () => {
  it("ambushes when the enemy plays their third card of the turn", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-demon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[1].lanes.every((l) => l === null)).toBe(true); // not yet
    g.state.playsLeft = 1; // a third play for p0 this turn
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // third card -> ambush
    const lanes = g.state.players[1].lanes.filter((l) => l !== null);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.defId).toBe("leyline-demon");
    expect(lanes[0]!.attack).toBe(4); // L1 4/6
    expect(lanes[0]!.health).toBe(6);
    const discard = g.state.players[1].discard;
    expect(discard.some((i) => i.defId === "leyline-demon" && i.level === 1)).toBe(true);
    expect(discard.some((i) => i.defId === "leyline-demon" && i.level === 2)).toBe(true); // leveled copy
  });
});

describe("Necromoeba (when dealt damage, Spawn an N/N Oozeling)", () => {
  it("spawns a 1/1 purple Oozeling when dealt damage", () => {
    const g = gameWith("necromoeba");
    const moeba = spawnCreature(g, [], 0, "necromoeba", 1, { lane: 0 })!; // 4/7
    const initial = collectInto(() => dealCreatureDamage(g, [], moeba, 2));
    runBatches(g, [], initial);
    expect(moeba.damage).toBe(2); // survives
    const ooze = g.state.players[0].lanes.find((c) => c?.defId === "oozeling-purple");
    expect(ooze).toBeTruthy();
    expect(ooze!.attack).toBe(1);
    expect(ooze!.health).toBe(1);
  });
});

describe("Rot Wanderer (Forge: destroy an enemy creature with cap or less attack)", () => {
  it("destroys an enemy creature with 3 or less attack", () => {
    const g = gameWith("rot-wanderer");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!; // 3/3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
  });

  it("finds no target against a 4-attack creature", () => {
    const g = gameWith("rot-wanderer");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack > 3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[0]).not.toBeNull();
  });
});

describe("Scourge Hydra (Forge: deal 3 damage to a friendly creature)", () => {
  it("deals 3 damage to the chosen friendly creature", () => {
    const g = gameWith("scourge-hydra");
    const friend = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: friend.uid });
    expect(friend.damage).toBe(3);
  });
});

describe("Spiritstone Sentry (Vengeance: respawn if it was in a side space)", () => {
  it("respawns when destroyed in a side space", () => {
    const g = gameWith("spiritstone-sentry");
    spawnCreature(g, [], 0, "spiritstone-sentry", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => dealCreatureDamage(g, [], c, 99));
    runBatches(g, [], initial);
    const back = g.state.players[0].lanes.filter((x) => x !== null);
    expect(back).toHaveLength(1);
    expect(back[0]!.defId).toBe("spiritstone-sentry");
    expect(back[0]!.level).toBe(1);
  });

  it("does not respawn from a center space", () => {
    const g = gameWith("spiritstone-sentry");
    spawnCreature(g, [], 0, "spiritstone-sentry", 1, { lane: 2 });
    const c = g.state.players[0].lanes[2]!;
    const initial = collectInto(() => dealCreatureDamage(g, [], c, 99));
    runBatches(g, [], initial);
    expect(g.state.players[0].lanes.every((x) => x === null)).toBe(true);
  });
});

describe("Torrent Witch (L2 Forge: put a level 2 Spirit Torrent into hand)", () => {
  it("puts a level 2 Spirit Torrent into hand", () => {
    const g = gameWith("torrent-witch");
    addToHand(g, 0, "torrent-witch", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.players[0].hand.some((i) => i.defId === "spirit-torrent" && i.level === 2)).toBe(true);
  });

  it("Spirit Torrent (support card) is Free at L2 and grants Regenerate 3", () => {
    const g = gameWith("torrent-witch");
    const c = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!; // no inherent Regenerate
    addToHand(g, 0, "spirit-torrent", 2);
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(keywordValue(c, "Regenerate")).toBe(3);
    expect(g.state.playsLeft).toBe(2); // Free: no play consumed
  });
});

describe("Vigor Leech (enemy -N/-N, or friendly Regenerate N)", () => {
  it("gives a chosen enemy creature -3/-3", () => {
    const g = gameWith("vigor-leech");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(1);
    expect(foe.health).toBe(4);
  });

  it("gives a chosen friendly creature Regenerate 3", () => {
    const g = gameWith("vigor-leech");
    const mine = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!; // no inherent Regenerate
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(keywordValue(mine, "Regenerate")).toBe(3);
  });
});

describe("Xithian Tormentor (Forge: destroy each other friendly creature)", () => {
  it("destroys every other friendly creature on Forge", () => {
    const g = gameWith("xithian-tormentor");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[2]!.defId).toBe("xithian-tormentor");
  });
});

describe("Varna, Immortal King (Forge: respawn a friendly creature destroyed this turn)", () => {
  it("spawns a copy of a friendly creature destroyed earlier this turn", () => {
    const g = gameWith("varna-immortal-king");
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const initial = collectInto(() => dealCreatureDamage(g, [], hydra, 99));
    runBatches(g, [], initial);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const copies = g.state.players[0].lanes.filter((c) => c?.defId === "cavern-hydra");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.owner).toBe(0);
    expect(copies[0]!.level).toBe(1);
  });

  it("does nothing when no friendly creature was destroyed this turn", () => {
    const g = gameWith("varna-immortal-king");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes.filter((c) => c !== null)).toHaveLength(1); // just Varna
  });

  it("L4 destroys each other creature, then respawns a destroyed friendly", () => {
    const g = gameWith("varna-immortal-king");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    addToHand(g, 0, "varna-immortal-king", 4);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    expect(g.state.players[1].lanes.every((c) => c === null)).toBe(true); // enemy wiped
    const mine = g.state.players[0].lanes.filter((c) => c !== null);
    expect(mine).toHaveLength(2); // Varna + one respawned friendly
    expect(mine.some((c) => c!.defId === "varna-immortal-king" && c!.level === 4)).toBe(true);
    expect(mine.some((c) => c!.defId === "cavern-hydra" || c!.defId === "technognome")).toBe(true);
  });
});

describe("Immortal Echoes (player effect: deferred end-of-turn Spawn)", () => {
  it("L1 Spawns a level 2-or-lower creature from the discard at both of your turn ends, then expires", () => {
    const g = gameWith("immortal-echoes");
    g.state.players[0].discard.push({ uid: g.state.nextUid++, defId: "xithian-tormentor", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playerEffects).toHaveLength(1);
    applyAction(g, { type: "endTurn" }); // p0: Spawn #1 (un-Forged, so its Forge does not fire)
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
    expect(g.state.players[0].lanes.some((c) => c?.defId === "xithian-tormentor" && c?.level === 1)).toBe(true);
    applyAction(g, { type: "endTurn" }); // p1: condition fails, no trigger
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
    applyAction(g, { type: "endTurn" }); // p0: Spawn #2, then expires
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(2);
    expect(g.state.playerEffects).toHaveLength(0);
    // the pool is not consumed (Varna convention)
    expect(g.state.players[0].discard.some((i) => i.defId === "xithian-tormentor")).toBe(true);
  });

  it("L1 skips creatures above level 2 in the pool", () => {
    const g = gameWith("immortal-echoes");
    g.state.players[0].discard.push({ uid: g.state.nextUid++, defId: "xithian-tormentor", level: 3, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].lanes.every((c) => c === null)).toBe(true);
  });
});
