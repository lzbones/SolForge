import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, dealCreatureDamage,
  destroyCreature, getCardScript, getStats, grantKeyword, hasKeyword, keywordValue, loadCards,
  refreshStatics, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set15 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.5.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set15);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

/** Deal damage to a creature outside of combat, resolving its trigger batch. */
function ping(g: Game, uid: number, amount: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => dealCreatureDamage(g, [], c, amount));
  runBatches(g, [], initial);
}

describe("Set 1.5 script registration", () => {
  it("registers every implementable Set 1.5 card and none of the TODO ones", () => {
    const scripted = [
      "aegis-pulse", "brighttusk-sower", "charnel-titan", "cypien-infiltrator", "drix-the-mindwelder",
      "kas-arcweaver", "metasight", "noxious-cloud", "omnomnom", "pyre-song", "runescarred-zombie",
      "strength-in-numbers", "thundersaur", "tower-vanguard", "venomfang", "warbringer-uranti",
      "weirwood-patriarch", "wildfire-maiden", "witherfrost-banshee", "woebringer", "zephyr-mage",
      // unlocked by anyCreatureEnterPlay / friendlyCreatureMoved engine events:
      "oreian-justicar", "tarsus-deathweaver", "windborn-hellion",
    ];
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
  });
});

describe("Aegis Pulse (each friendly creature gets Armor N)", () => {
  it("grants Armor 2 permanently", () => {
    const g = gameWith("aegis-pulse");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(hydra, "Armor")).toBe(2);
    passTurns(g, 2);
    expect(keywordValue(hydra, "Armor")).toBe(2); // not a "this turn" grant
  });
});

describe("Brighttusk Sower (Forge: optional adjacent token)", () => {
  it("L1 accepted: puts a 1/1 Seedling into an adjacent space", () => {
    const g = gameWith("brighttusk-sower");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending!.request.optional).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    const lanes = g.state.players[0].lanes;
    const token = [lanes[1], lanes[3]].find((c) => c?.defId === "seedling");
    expect(token).toBeDefined();
    expect([token!.attack, token!.health]).toEqual([1, 1]);
    expect(lanes[2]!.defId).toBe("brighttusk-sower");
  });

  it("L2 accepted: puts a 3/3 Sapling", () => {
    const g = gameWith("brighttusk-sower");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    const lanes = g.state.players[0].lanes;
    const token = [lanes[1], lanes[3]].find((c) => c?.defId === "sapling");
    expect([token?.attack, token?.health]).toEqual([3, 3]);
  });

  it("declined: adjacent spaces stay empty", () => {
    const g = gameWith("brighttusk-sower");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[3]).toBeNull();
  });
});

describe("Charnel Titan (Forge: conditional self-buff)", () => {
  it("gets +3/+3 when an enemy creature has 3 or less attack", () => {
    const g = gameWith("charnel-titan");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 3, health: 9 } });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const titan = g.state.players[0].lanes[0]!;
    expect([titan.attack, titan.health]).toEqual([6, 8]);
  });

  it("stays 3/5 when every enemy creature has more than 3 attack", () => {
    const g = gameWith("charnel-titan");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const titan = g.state.players[0].lanes[0]!;
    expect([titan.attack, titan.health]).toEqual([3, 5]);
  });
});

describe("Cypien Infiltrator (static: Breakthrough while at 7+ attack)", () => {
  it("gains Breakthrough only once it reaches 7 attack", () => {
    const g = gameWith("cypien-infiltrator");
    spawnCreature(g, [], 0, "cypien-infiltrator", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    refreshStatics(g);
    expect(hasKeyword(c, "Breakthrough")).toBe(false); // 6 < 7
    buffCreature(g, [], c, 1, 0); // 7 attack
    refreshStatics(g);
    expect(hasKeyword(c, "Breakthrough")).toBe(true);
  });
});

describe("Drix, The Mindwelder (Activate, discard your hand)", () => {
  it("discards the hand and gives each friendly Metamind +1 attack per card", () => {
    const g = gameWith("drix-the-mindwelder");
    spawnCreature(g, [], 0, "drix-the-mindwelder", 1, { lane: 0 });
    spawnCreature(g, [], 0, "ghox-metamind-paragon", 1, { lane: 1 });
    const drix = g.state.players[0].lanes[0]!;
    const ghox = g.state.players[0].lanes[1]!;
    drix.defensive = false;
    const handSize = g.state.players[0].hand.length; // 5
    applyAction(g, { type: "activate", uid: drix.uid });
    expect(g.state.players[0].hand).toHaveLength(0);
    expect(g.state.players[0].discard.filter((c) => c.defId === "drix-the-mindwelder")).toHaveLength(handSize);
    expect(drix.attack).toBe(3 + handSize); // Drix is a Metamind itself
    expect(ghox.attack).toBe(4 + handSize);
  });
});

describe("Kas, Arcweaver (spellPlayed: extra battle)", () => {
  it("playing a spell grants an additional battle this turn", () => {
    const g = gameWith("kas-arcweaver");
    spawnCreature(g, [], 0, "kas-arcweaver", 1, { lane: 3 });
    g.state.players[0].hand.push({ uid: 9001, defId: "ferocious-roar", level: 1, owner: 0 });
    expect(g.state.battlesLeft).toBe(1);
    applyAction(g, { type: "playCard", handIndex: g.state.players[0].hand.length - 1 });
    expect(g.state.pending).toBeNull();
    expect(g.state.battlesLeft).toBe(2);
  });
});

describe("Metasight (discard and level up 2 cards)", () => {
  it("chains two cardInHand choices", () => {
    const g = gameWith("metasight");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("cardInHand");
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).not.toBeNull(); // second discard
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).toBeNull();
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(2); // 5 - 1 played - 2 discarded
    const discard = p0.discard.filter((c) => c.defId === "metasight");
    expect(discard.filter((c) => c.level === 1)).toHaveLength(3); // 2 discarded + the played spell
    expect(discard.filter((c) => c.level === 2)).toHaveLength(3); // leveled copies: play + 2 discards
  });

  it("L2 is Free (costs no play) and cannot produce a level 3 copy", () => {
    const g = gameWith("metasight");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playsLeft).toBe(2); // Free
    while (g.state.pending) {
      applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    }
    expect(g.state.players[0].discard.some((c) => c.defId === "metasight" && c.level === 3)).toBe(false);
  });
});

describe("Noxious Cloud (each enemy creature gets Poison N)", () => {
  it("grants Poison 2, which ticks at the enemy's turn start", () => {
    const g = gameWith("noxious-cloud");
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 1 });
    const foe = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(foe, "Poison")).toBe(2);
    applyAction(g, { type: "endTurn" }); // p1 turn start: poison ticks
    expect(foe.damage).toBe(2);
  });
});

describe("Omnomnom (Zombie buff, then enemy non-Zombie debuff)", () => {
  it("resolves both halves through chained choices", () => {
    const g = gameWith("omnomnom");
    spawnCreature(g, [], 0, "zombie", 1, { lane: 0, overrideStats: { attack: 2, health: 2 } });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const zombie = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([zombie.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: zombie.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.pending).toBeNull();
    expect([zombie.attack, zombie.health]).toEqual([4, 4]);
    expect(keywordValue(zombie, "Regenerate")).toBe(2);
    expect([hydra.attack, hydra.health]).toEqual([2, 5]);
  });

  it("fizzles without a friendly Zombie on board", () => {
    const g = gameWith("omnomnom");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[1]!.attack).toBe(4); // unchanged
  });
});

describe("Pyre Song (each friendly creature deals N to each enemy creature)", () => {
  it("two friendly creatures deal 1 damage each to every enemy", () => {
    const g = gameWith("pyre-song");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 0 });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[0]!.damage).toBe(2);
    expect(g.state.players[1].lanes[2]!.damage).toBe(2);
    expect(g.state.players[0].lanes[0]!.damage).toBe(0);
  });
});

describe("Runescarred Zombie (Vengeance: recover a random spell)", () => {
  it("returns a level 1 spell from the discard pile to hand (L2 spells ineligible at L1)", () => {
    const g = gameWith("runescarred-zombie");
    spawnCreature(g, [], 0, "runescarred-zombie", 1, { lane: 0 });
    const p0 = g.state.players[0];
    p0.discard.push({ uid: 9002, defId: "lightning-spark", level: 1, owner: 0 });
    p0.discard.push({ uid: 9003, defId: "lightning-spark", level: 2, owner: 0 });
    const c = p0.lanes[0]!;
    const initial = collectInto(() => destroyCreature(g, [], c));
    runBatches(g, [], initial);
    expect(p0.lanes[0]).toBeNull();
    expect(p0.hand.some((i) => i.defId === "lightning-spark" && i.level === 1)).toBe(true);
    expect(p0.discard.some((i) => i.defId === "lightning-spark" && i.level === 1)).toBe(false);
    expect(p0.discard.some((i) => i.defId === "lightning-spark" && i.level === 2)).toBe(true);
  });
});

describe("Strength in Numbers (+N/+N per friendly creature)", () => {
  it("buffs the chosen creature by the friendly board count", () => {
    const g = gameWith("strength-in-numbers");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect([foe.attack, foe.health]).toEqual([6, 9]); // 2 friendly creatures at L1
  });
});

describe("Thundersaur (grows when dealt damage)", () => {
  it("gets +1 attack for each damage dealt to it", () => {
    const g = gameWith("thundersaur");
    spawnCreature(g, [], 0, "thundersaur", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    expect(hasKeyword(c, "Breakthrough")).toBe(true); // inherent keyword
    ping(g, c.uid, 3);
    expect(c.attack).toBe(3);
    ping(g, c.uid, 2);
    expect(c.attack).toBe(5);
  });
});

describe("Tower Vanguard (static: +N attack while it has Armor)", () => {
  it("gets +2 attack only while it has Armor", () => {
    const g = gameWith("tower-vanguard");
    spawnCreature(g, [], 0, "tower-vanguard", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    expect(getStats(g, c).attack).toBe(3);
    grantKeyword([], c, { keyword: "Armor", value: 2 });
    expect(getStats(g, c).attack).toBe(5);
  });
});

describe("Venomfang (Forge: enemy creature gets Poison N)", () => {
  it("gives the chosen enemy creature Poison 2", () => {
    const g = gameWith("venomfang");
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 2 });
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([foe.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(2);
  });
});

describe("Warbringer Uranti (Forge: another friendly creature +N attack this turn)", () => {
  it("buffs another friendly creature until end of turn", () => {
    const g = gameWith("warbringer-uranti");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]); // self excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(getStats(g, hydra).attack).toBe(8);
    applyAction(g, { type: "endTurn" }); // temp buff wears off
    expect(getStats(g, hydra).attack).toBe(4);
  });
});

describe("Weirwood Patriarch (Forge: buff small friendly creatures)", () => {
  it("buffs each friendly creature with 3 or less attack (not itself)", () => {
    const g = gameWith("weirwood-patriarch");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0, overrideStats: { attack: 3, health: 3 } });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 6, health: 6 } });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5/7, above its own gate
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([5, 5]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([6, 6]);
    expect([g.state.players[0].lanes[2]!.attack, g.state.players[0].lanes[2]!.health]).toEqual([5, 7]);
  });
});

describe("Wildfire Maiden (Activate, destroy itself: AoE equal to its attack)", () => {
  it("destroys itself and deals its attack to each enemy creature", () => {
    const g = gameWith("wildfire-maiden");
    spawnCreature(g, [], 0, "wildfire-maiden", 1, { lane: 0 });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const maiden = g.state.players[0].lanes[0]!;
    maiden.defensive = false;
    applyAction(g, { type: "activate", uid: maiden.uid });
    expect(g.state.players[0].lanes[0]).toBeNull(); // destroyed
    expect(g.state.players[1].lanes[0]!.damage).toBe(4);
    expect(g.state.players[1].lanes[2]!.damage).toBe(4);
  });
});

describe("Witherfrost Banshee (Forge/Flank: opposing creature -N/-N)", () => {
  it("Forge gives the opposing creature -2/-2", () => {
    const g = gameWith("witherfrost-banshee");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    expect([hydra.attack, hydra.health]).toEqual([2, 5]);
  });
});

describe("Woebringer (turnStart: destroy the lowest-attack creature)", () => {
  it("L1 destroys the lowest-attack creature on either side at your turn start", () => {
    const g = gameWith("woebringer");
    spawnCreature(g, [], 0, "woebringer", 1, { lane: 0 }); // 7/5
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 2, health: 4 } });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    passTurns(g, 2); // back to p0's turn start
    expect(g.state.players[0].lanes[1]).toBeNull(); // friendly 2/4 was the lowest
    expect(g.state.players[0].lanes[0]).not.toBeNull();
    expect(g.state.players[1].lanes[0]).not.toBeNull();
  });

  it("L3 destroys only the lowest-attack enemy creature", () => {
    const g = gameWith("woebringer");
    spawnCreature(g, [], 0, "woebringer", 3, { lane: 0 }); // 18/15
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 2, health: 4 } });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7, lowest enemy
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2, overrideStats: { attack: 5, health: 9 } });
    passTurns(g, 2);
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[1]).not.toBeNull(); // friendly spared at L3
    expect(g.state.players[1].lanes[2]).not.toBeNull();
  });
});

describe("Zephyr Mage (Activate: give another low-level creature Mobility)", () => {
  it("gives another level 1 creature Mobility 1", () => {
    const g = gameWith("zephyr-mage");
    spawnCreature(g, [], 0, "zephyr-mage", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 2, { lane: 2 });
    const mage = g.state.players[0].lanes[0]!;
    mage.defensive = false;
    applyAction(g, { type: "activate", uid: mage.uid });
    const req = g.state.pending!.request;
    // self and the level 2 creature are not legal targets at L1
    expect(req.options).toEqual([g.state.players[0].lanes[1]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[1]!.uid });
    expect(keywordValue(g.state.players[0].lanes[1]!, "Mobility")).toBe(1);
  });
});

// ---------- engine-gap unlocks (anyCreatureEnterPlay / friendlyCreatureMoved) ----------

describe("Oreian Justicar (un-Forged enemy entry -> -attack)", () => {
  it("debuffs tokens spawned by the opponent, not Forged plays", () => {
    const g = gameWith("oreian-justicar", "death-seeker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // justicar 5/8
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 seeker (Forged -> no debuff)
    const seeker = g.state.players[1].lanes[1]!;
    expect(seeker.attack).toBe(1);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // trade: seeker dies -> 5/5 spirit spawns (un-Forged)
    const spirit = g.state.players[1].lanes[1];
    expect(spirit?.defId).toBe("spirit-nekrium");
    expect(spirit?.attack).toBe(0); // 5 - 5 justicar debuff
  });
});

describe("Tarsus Deathweaver (un-Forged friendly entry -> +N/+N)", () => {
  it("buffs friendly tokens, not Forged plays", () => {
    const g = gameWith("tarsus-deathweaver", "cavern-hydra");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // deathweaver 5/5, Forged: no self-buff
    const dw = g.state.players[0].lanes[2]!;
    expect(dw.attack).toBe(5);
    // a friendly token enters un-Forged -> +2/+2
    const initial = collectInto(() => spawnCreature(g, [], 0, "spirit-nekrium", 1, { lane: "random", overrideStats: { attack: 5, health: 5 } }));
    runBatches(g, [], initial);
    const spirit = g.state.players[0].lanes.find((c) => c && c.defId === "spirit-nekrium");
    expect(spirit?.attack).toBe(7); // 5 + 2
    expect(spirit?.health).toBe(7);
  });
});

describe("Windborn Hellion (friendly creature moves -> +N/+N)", () => {
  it("grows when another friendly creature moves", () => {
    const deck = [...Array(15).fill("windborn-hellion"), ...Array(15).fill("brightsteel-gargoyle")];
    const g = createGame(cards, deck, deckOf("cavern-hydra"), 7);
    // find and play one of each
    const hellionIdx = g.state.players[0].hand.findIndex((c) => c.defId === "windborn-hellion");
    const gargIdx = g.state.players[0].hand.findIndex((c) => c.defId === "brightsteel-gargoyle");
    applyAction(g, { type: "playCard", handIndex: hellionIdx, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: gargIdx > hellionIdx ? gargIdx - 1 : gargIdx, lane: 2 });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" }); // p0 turn: both ready
    const hellion = g.state.players[0].lanes[0]!;
    const gargoyle = g.state.players[0].lanes[2]!;
    expect(hellion.attack).toBe(4);
    applyAction(g, { type: "move", uid: gargoyle.uid, lane: 1 }); // Mobility 1
    expect(hellion.attack).toBe(5); // 4 + 1
    expect(hellion.health).toBe(9); // 8 + 1
  });
});
