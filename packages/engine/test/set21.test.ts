import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, getCardScript, hasKeyword, keywordValue, loadCards,
  spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set21 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set22 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.2.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set2, set21, set22);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

describe("Set 2.1 script registration", () => {
  it("registers every Set 2.1 card with non-trivial text", () => {
    const scripted = [
      "aegis-knight", "aether-root", "aetherforge-oracle", "borean-mystic",
      "chistlehearth-archer", "cypien-battlesuit", "everflame-mystic", "nyrali-symbiote",
      "oreian-fieldmarshal", "savage-oath", "scatterspore-eidolon", "spiritbloom-dryad",
      "spitesower-acolyte", "tarsian-pact", "tremorcharge", "vyric-ebonskull", "war-merchant",
    ];
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
    // avalanche-guardian / flowstone-primordial are keyword-only/vanilla: no script
  });

  it("spirit-torrent stays registered from set5-nekrium.ts (skipped in set21.ts)", () => {
    expect(cards["spirit-torrent"]).toBeTruthy();
    expect(getCardScript("spirit-torrent")).not.toBeNull();
  });
});

describe("Aegis Knight (Forge: each friendly creature deals its Armor to the opposing creature)", () => {
  it("deals each Armored friendly creature's Armor to the creature opposing it", () => {
    const g = gameWith("aegis-knight");
    spawnCreature(g, [], 0, "aegis-knight", 1, { lane: 3 }); // no Forge on spawn
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // no Armor: no damage
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5/5 Armor 1
    expect(g.state.players[1].lanes[2]!.damage).toBe(1); // played knight's Armor 1
    expect(g.state.players[1].lanes[3]!.damage).toBe(1); // other knight's Armor 1
    expect(g.state.players[1].lanes[0]!.damage).toBe(0); // opposing creature has no Armor
    expect(g.state.players[0].lanes[2]!.damage).toBe(0); // friendly side unharmed
  });
});

describe("Aether Root (Uterra spellPlayed: +N/+N)", () => {
  it("grows on your Uterra spells, ignores other factions", () => {
    const g = gameWith("ferocious-roar");
    spawnCreature(g, [], 0, "aether-root", 1, { lane: 1 }); // 3/3
    applyAction(g, { type: "playCard", handIndex: 0 }); // Ferocious Roar (Uterra): +2/+2 spell + +2/+2 trigger
    const root = g.state.players[0].lanes[1]!;
    expect([root.attack, root.health]).toEqual([7, 7]);
    g.state.players[0].hand.push({ uid: 9001, defId: "energy-surge", level: 1, owner: 0 }); // Alloyin
    applyAction(g, { type: "playCard", handIndex: g.state.players[0].hand.length - 1 });
    expect([root.attack, root.health]).toEqual([7, 7]); // unchanged
  });
});

describe("Aetherforge Oracle (Forge: you may discard and level up a spell)", () => {
  it("offers only spells, discards and levels the chosen spell", () => {
    const g = gameWith("aetherforge-oracle");
    g.state.players[0].hand.push({ uid: 9002, defId: "energy-surge", level: 1, owner: 0 }); // the only spell
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([g.state.players[0].hand.length - 1]); // creatures filtered out
    applyChoice(g, { id: req.id, accepted: true, handIndex: g.state.players[0].hand.length - 1 });
    const leveled = g.state.players[0].discard.filter((c) => c.defId === "energy-surge").map((c) => c.level);
    expect(leveled).toEqual([1, 2]); // discarded original + leveled copy
  });

  it("declined: hand untouched", () => {
    const g = gameWith("aetherforge-oracle");
    g.state.players[0].hand.push({ uid: 9003, defId: "energy-surge", level: 1, owner: 0 });
    const handSize = g.state.players[0].hand.length;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].hand).toHaveLength(handSize - 1); // only the oracle left hand
    expect(g.state.players[0].discard.some((c) => c.defId === "energy-surge")).toBe(false);
  });
});

describe("Borean Mystic (Activate: move a friendly creature adjacent to it)", () => {
  it("moves the chosen creature to a space adjacent to Borean Mystic", () => {
    const g = gameWith("borean-mystic");
    spawnCreature(g, [], 0, "borean-mystic", 1, { lane: 2 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const mystic = g.state.players[0].lanes[2]!;
    const hydra = g.state.players[0].lanes[0]!;
    mystic.defensive = false;
    applyAction(g, { type: "activate", uid: mystic.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([1, 3]).toContain(hydra.lane); // adjacent to the mystic (random when both open)
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[hydra.lane]!.uid).toBe(hydra.uid);
  });

  it("cannot activate without another friendly creature", () => {
    const g = gameWith("borean-mystic");
    spawnCreature(g, [], 0, "borean-mystic", 1, { lane: 2 });
    const mystic = g.state.players[0].lanes[2]!;
    mystic.defensive = false;
    expect(() => applyAction(g, { type: "activate", uid: mystic.uid })).toThrow();
  });
});

describe("Chistlehearth Archer (Forge: damage + Negate Mobility)", () => {
  it("deals 4 to an enemy creature with Mobility and negates Mobility", () => {
    const g = gameWith("chistlehearth-archer");
    spawnCreature(g, [], 1, "avalanche-guardian", 1, { lane: 1 }); // 5/8, Mobility 1
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 }); // no Mobility
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[1].lanes[1]!.uid]); // only the Mobility creature
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[1].lanes[1]!.uid });
    const guardian = g.state.players[1].lanes[1]!;
    expect(guardian.damage).toBe(4);
    expect(keywordValue(guardian, "Mobility")).toBe(0);
  });

  it("fizzles when no enemy creature has Mobility", () => {
    const g = gameWith("chistlehearth-archer");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[1]!.damage).toBe(0);
  });
});

describe("Cypien Battlesuit (Alloyin creature +N attack and Armor)", () => {
  it("gives an Alloyin creature +5 attack and Armor 1", () => {
    const g = gameWith("cypien-battlesuit");
    spawnCreature(g, [], 0, "aegis-knight", 1, { lane: 0 }); // Alloyin 5/5 Armor 1
    spawnCreature(g, [], 0, "aether-root", 1, { lane: 1 }); // Uterra: ineligible
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([g.state.players[0].lanes[0]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    const knight = g.state.players[0].lanes[0]!;
    expect(knight.attack).toBe(10);
    expect(keywordValue(knight, "Armor")).toBe(2); // 1 inherent + 1 granted
  });
});

describe("Everflame Mystic (battle damage to a player on your turn: additional spells)", () => {
  it("grants an additional play after it hits the enemy player", () => {
    const g = gameWith("everflame-mystic");
    spawnCreature(g, [], 0, "everflame-mystic", 1, { lane: 2 }); // 5/6
    passTurns(g, 2); // offensive
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(115);
    expect(g.state.playsLeft).toBe(3); // 2 + 1 additional spell
  });
});

describe("Nyrali Symbiote (Forge: Regenerate N if opposed)", () => {
  it("gains Regenerate 2 when opposed, nothing when unopposed", () => {
    const g = gameWith("nyrali-symbiote");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // opposed
    expect(keywordValue(g.state.players[0].lanes[1]!, "Regenerate")).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 }); // unopposed
    expect(keywordValue(g.state.players[0].lanes[3]!, "Regenerate")).toBe(0);
  });
});

describe("Oreian Fieldmarshal (Forge: other friendly creatures get +N attack)", () => {
  it("buffs the others, not itself", () => {
    const g = gameWith("oreian-fieldmarshal");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // 4 attack
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 5/3
    expect(g.state.players[0].lanes[0]!.attack).toBe(5);
    expect(g.state.players[0].lanes[1]!.attack).toBe(5); // unchanged 5
  });
});

describe("Savage Oath (Uterra creature +N/+N and Breakthrough)", () => {
  it("gives an Uterra creature +2/+2 and Breakthrough", () => {
    const g = gameWith("savage-oath");
    spawnCreature(g, [], 0, "spiritbloom-dryad", 1, { lane: 0 }); // Uterra 6/7
    spawnCreature(g, [], 0, "aegis-knight", 1, { lane: 1 }); // Alloyin: ineligible
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[0].lanes[0]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    const dryad = g.state.players[0].lanes[0]!;
    expect([dryad.attack, dryad.health]).toEqual([8, 9]);
    expect(hasKeyword(dryad, "Breakthrough")).toBe(true);
  });
});

describe("Scatterspore Eidolon (start of your turn: Spawn a token)", () => {
  it("spawns a 3/3 Seedling at the start of your turn only", () => {
    const g = gameWith("scatterspore-eidolon");
    spawnCreature(g, [], 0, "scatterspore-eidolon", 1, { lane: 2 });
    applyAction(g, { type: "endTurn" }); // p1's turn starts: no spawn
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
    applyAction(g, { type: "endTurn" }); // p0's turn starts: spawn
    const token = g.state.players[0].lanes.find((c) => c?.defId === "seedling");
    expect(token).toBeDefined();
    expect([token?.attack, token?.health]).toEqual([3, 3]);
  });
});

describe("Spiritbloom Dryad (Forge: each player gains N health)", () => {
  it("heals both players for 4", () => {
    const g = gameWith("spiritbloom-dryad");
    g.state.players[0].health = 100;
    g.state.players[1].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].health).toBe(104);
    expect(g.state.players[1].health).toBe(104);
  });
});

describe("Spitesower Acolyte (Activate, 2 damage to itself: -2/-2)", () => {
  it("deals 2 to itself and gives a creature -2/-2", () => {
    const g = gameWith("spitesower-acolyte");
    spawnCreature(g, [], 0, "spitesower-acolyte", 1, { lane: 0 }); // 2/8
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    const acolyte = g.state.players[0].lanes[0]!;
    acolyte.defensive = false;
    applyAction(g, { type: "activate", uid: acolyte.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: g.state.players[1].lanes[1]!.uid });
    expect(acolyte.damage).toBe(2);
    expect([g.state.players[1].lanes[1]!.attack, g.state.players[1].lanes[1]!.health]).toEqual([2, 5]);
  });
});

describe("Tarsian Pact (Nekrium creature +A/+H and Regenerate)", () => {
  it("L3 gives +5 attack, +2 health and Regenerate 5", () => {
    const g = gameWith("tarsian-pact");
    g.state.players[0].hand[0]!.level = 3;
    spawnCreature(g, [], 0, "xithian-host", 1, { lane: 0 }); // Nekrium 3/1
    spawnCreature(g, [], 0, "aether-root", 1, { lane: 1 }); // Uterra: ineligible
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[0].lanes[0]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    const host = g.state.players[0].lanes[0]!;
    expect([host.attack, host.health]).toEqual([8, 3]);
    expect(keywordValue(host, "Regenerate")).toBe(5);
  });
});

describe("Tremorcharge (Tempys creature +N health and Mobility)", () => {
  it("gives a Tempys creature +4 health and Mobility 1", () => {
    const g = gameWith("tremorcharge");
    spawnCreature(g, [], 0, "avalanche-guardian", 1, { lane: 0 }); // Tempys 5/8, Mobility 1
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[0].lanes[0]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    const guardian = g.state.players[0].lanes[0]!;
    expect([guardian.attack, guardian.health]).toEqual([5, 12]);
    expect(keywordValue(guardian, "Mobility")).toBe(2); // 1 inherent + 1 granted
  });
});

describe("Vyric Ebonskull (battle damage to a player: destroy a random enemy creature)", () => {
  it("L1 destroys only level 1 creatures", () => {
    const g = gameWith("vyric-ebonskull");
    spawnCreature(g, [], 0, "vyric-ebonskull", 1, { lane: 2 }); // 3/7
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 1 }); // level 2: too high
    passTurns(g, 2);
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]).toBeNull(); // level 1 destroyed
    expect(g.state.players[1].lanes[1]).not.toBeNull(); // level 2 spared
    expect(g.state.players[0].lanes.some((c) => c?.defId === "cavern-hydra")).toBe(false); // no copy at L1
  });

  it("L3 destroys any enemy creature and Spawns a copy of it", () => {
    const g = gameWith("vyric-ebonskull");
    spawnCreature(g, [], 0, "vyric-ebonskull", 3, { lane: 2 }); // 13/17
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    passTurns(g, 2);
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]).toBeNull();
    const raised = g.state.players[0].lanes.find((c) => c?.defId === "cavern-hydra");
    expect(raised).toBeDefined();
    expect(raised?.owner).toBe(0);
    expect(raised?.level).toBe(1);
    expect([raised?.attack, raised?.health]).toEqual([4, 7]); // base-stats copy
  });
});

describe("War Merchant (Activate: center-space creature gets +N attack)", () => {
  it("gives the center creature +4 attack despite its own Defender", () => {
    const g = gameWith("war-merchant");
    spawnCreature(g, [], 0, "war-merchant", 1, { lane: 0 }); // 4/4 Defender
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // center
    const merchant = g.state.players[0].lanes[0]!;
    merchant.defensive = false;
    applyAction(g, { type: "activate", uid: merchant.uid });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[1].lanes[2]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[1].lanes[2]!.uid });
    expect(g.state.players[1].lanes[2]!.attack).toBe(8); // 4 + 4
  });

  it("cannot activate with an empty center space", () => {
    const g = gameWith("war-merchant");
    spawnCreature(g, [], 0, "war-merchant", 1, { lane: 0 });
    const merchant = g.state.players[0].lanes[0]!;
    merchant.defensive = false;
    expect(() => applyAction(g, { type: "activate", uid: merchant.uid })).toThrow();
  });
});
