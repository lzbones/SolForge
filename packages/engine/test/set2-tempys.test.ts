import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript,
  getStats, grantKeyword, hasKeyword, loadCards, refreshStatics, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set2, set1);

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

const SCRIPTED = [
  "ashurian-brawler", "binben-lightning-herald", "byzerak-spitemage", "cloudcleaver-titan",
  "conflagrate", "emberwind-evoker", "flame-lance", "flamefury-shaman", "glaceus-tundra-tyrant",
  "glacial-crush", "korok-khan-of-kadras", "stone-brand", "talin-stampede", "thundergale-invoker",
  "turnabout", "umbruk-glider", "uranti-heartseeker", "uranti-icemage", "uranti-warlord",
  "wallbreaker-yeti",
];

describe("Set 2 Tempys script registration", () => {
  it("registers every scripted Set 2 Tempys card", () => {
    for (const id of SCRIPTED) expect(getCardScript(id), id).not.toBeNull();
  });
});

describe("Ashurian Brawler (battle damage to a player -> +N/+N)", () => {
  it("gets +1/+1 after dealing battle damage to the enemy player", () => {
    const g = gameWith("ashurian-brawler");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 7/7
    passTurns(g, 2);
    applyAction(g, { type: "battle" }); // unopposed: 7 to the face
    const brawler = g.state.players[0].lanes[0]!;
    expect([brawler.attack, brawler.health]).toEqual([8, 8]);
    expect(g.state.players[1].health).toBe(120 - 7);
  });
});

describe("Binben, Lightning Herald (spellPlayed -> expiring Lightning Elemental)", () => {
  it("spawns a 4/2 Lightning Elemental that is destroyed at end of your turn", () => {
    const g = gameWith("binben-lightning-herald");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // Binben 6/4
    g.state.players[0].hand.push({ uid: 9001, defId: "ferocious-roar", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: g.state.players[0].hand.length - 1 });
    const token = g.state.players[0].lanes.find((c) => c?.defId === "lightning-elemental");
    expect(token).toBeDefined();
    expect([token!.attack, token!.health]).toEqual([4, 2]);
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].lanes.every((c) => c?.defId !== "lightning-elemental")).toBe(true);
    expect(g.state.players[0].lanes[0]?.defId).toBe("binben-lightning-herald"); // Binben stays
  });

  it("does not trigger off the opponent's spells", () => {
    const g = gameWith("binben-lightning-herald");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" });
    g.state.players[1].hand.push({ uid: 9002, defId: "ferocious-roar", level: 1, owner: 1 });
    applyAction(g, { type: "playCard", handIndex: g.state.players[1].hand.length - 1 });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1); // only Binben
  });
});

describe("Byzerak Spitemage (Allied Nekrium: battle damage destroys low-level creatures)", () => {
  it("with a Nekrium card in hand, destroys a surviving level 1 creature it battled", () => {
    const g = gameWith("byzerak-spitemage");
    g.state.players[0].hand.push({ uid: 9003, defId: "death-seeker", level: 1, owner: 0 }); // Nekrium
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/1 Aggressive
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0, overrideStats: { attack: 0, health: 7 } });
    passTurns(g, 2);
    applyAction(g, { type: "battle" }); // spitemage deals 3 (hydra survives at 4), blight destroys it
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[0]).not.toBeNull(); // 0-attack hydra dealt nothing back
  });

  it("without a Nekrium card in hand, the battled creature survives", () => {
    const g = gameWith("byzerak-spitemage");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0, overrideStats: { attack: 0, health: 7 } });
    passTurns(g, 2);
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]!.damage).toBe(3); // damaged but alive
  });
});

describe("Cloudcleaver Titan (static: +N attack while unopposed)", () => {
  it("has +2 attack only while its lane is unopposed", () => {
    const g = gameWith("cloudcleaver-titan");
    spawnCreature(g, [], 0, "cloudcleaver-titan", 1, { lane: 0 }); // 4/7
    const titan = g.state.players[0].lanes[0]!;
    expect(getStats(g, titan).attack).toBe(6);
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    expect(getStats(g, titan).attack).toBe(4);
  });
});

describe("Conflagrate (deal N damage to two enemy creatures)", () => {
  it("chains two enemy-creature picks for 3 damage each", () => {
    const g = gameWith("conflagrate");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const a = g.state.players[1].lanes[0]!;
    const b = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("enemyCreature");
    expect(req1.options).toEqual([a.uid, b.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: a.uid });
    const req2 = g.state.pending!.request;
    expect(req2.options).toEqual([b.uid]); // first target excluded
    applyChoice(g, { id: req2.id, accepted: true, targetUid: b.uid });
    expect(g.state.pending).toBeNull();
    expect([a.damage, b.damage]).toEqual([3, 3]);
  });

  it("hits the only enemy creature once when no second target exists", () => {
    const g = gameWith("conflagrate");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const a = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: a.uid });
    expect(g.state.pending).toBeNull();
    expect(a.damage).toBe(3);
  });
});

describe("Emberwind Evoker (a friendly creature moves -> it gets +N/+N)", () => {
  it("buffs the friendly creature that moved, not itself", () => {
    const deck = [...Array(15).fill("emberwind-evoker"), ...Array(15).fill("brightsteel-gargoyle")];
    const g = createGame(cards, deck, deckOf("cavern-hydra"), 7);
    const evoIdx = g.state.players[0].hand.findIndex((c) => c.defId === "emberwind-evoker");
    const garIdx = g.state.players[0].hand.findIndex((c) => c.defId === "brightsteel-gargoyle");
    applyAction(g, { type: "playCard", handIndex: evoIdx, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: garIdx > evoIdx ? garIdx - 1 : garIdx, lane: 2 });
    passTurns(g, 2);
    const evoker = g.state.players[0].lanes[0]!;
    const gargoyle = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "move", uid: gargoyle.uid, lane: 1 }); // Mobility 1
    expect([gargoyle.attack, gargoyle.health]).toEqual([6, 6]); // 5/5 + 1/+1
    expect([evoker.attack, evoker.health]).toEqual([4, 6]); // unchanged
  });
});

describe("Flame Lance (N to an enemy creature and N to the enemy player)", () => {
  it("deals 5 to the chosen creature and 5 to the enemy player", () => {
    const g = gameWith("flame-lance");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(5);
    expect(g.state.players[1].health).toBe(120 - 5);
  });
});

describe("Flamefury Shaman (Activate: a creature gets +N attack this turn)", () => {
  it("grants +3 attack until end of turn", () => {
    const g = gameWith("flamefury-shaman");
    spawnCreature(g, [], 0, "flamefury-shaman", 1, { lane: 0 }); // 3/8
    const shaman = g.state.players[0].lanes[0]!;
    shaman.defensive = false;
    applyAction(g, { type: "activate", uid: shaman.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: shaman.uid });
    expect(getStats(g, shaman).attack).toBe(6);
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, shaman).attack).toBe(3);
  });
});

describe("Glaceus, Tundra Tyrant (rankGained freeze / L3 turn-start ping)", () => {
  it("rank up gives an enemy level 1 creature 'when dealt damage, destroy it'", () => {
    const g = gameWith("glaceus-tundra-tyrant");
    spawnCreature(g, [], 0, "glaceus-tundra-tyrant", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    g.state.players[0].turnInRank = 4; // next endTurn ranks up
    applyAction(g, { type: "endTurn" });
    expect(hydra.grantedAbilities).toContain("tempys:frozen-solid");
    ping(g, hydra.uid, 1); // any damage now destroys it
    expect(g.state.players[1].lanes[0]).toBeNull();
  });

  it("L3 deals 1 damage to each enemy creature at the start of each turn", () => {
    const g = gameWith("glaceus-tundra-tyrant");
    spawnCreature(g, [], 0, "glaceus-tundra-tyrant", 3, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "endTurn" }); // p1's turn starts: the aura pings
    expect(g.state.players[1].lanes[0]!.damage).toBe(1);
    expect(g.state.players[1].lanes[1]!.damage).toBe(1);
  });
});

describe("Glacial Crush (destroy an enemy creature with Defender)", () => {
  it("L1 destroys the chosen Defender", () => {
    const g = gameWith("glacial-crush");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
  });

  it("L3 also deals the creature's health to the enemy player", () => {
    const g = gameWith("glacial-crush");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    const hydra = g.state.players[1].lanes[0]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].health).toBe(120 - 7);
  });
});

describe("Korok, Khan of Kadras (static Aggressive aura, 4 levels)", () => {
  it("L2 grants Aggressive to friendly level 1 creatures, not level 2", () => {
    const g = gameWith("korok-khan-of-kadras");
    spawnCreature(g, [], 0, "korok-khan-of-kadras", 2, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 2, { lane: 2 });
    refreshStatics(g);
    expect(hasKeyword(g.state.players[0].lanes[1]!, "Aggressive")).toBe(true);
    expect(hasKeyword(g.state.players[0].lanes[2]!, "Aggressive")).toBe(false);
    expect(hasKeyword(g.state.players[0].lanes[0]!, "Aggressive")).toBe(true); // inherent
  });

  it("L1 has no aura", () => {
    const g = gameWith("korok-khan-of-kadras");
    spawnCreature(g, [], 0, "korok-khan-of-kadras", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    refreshStatics(g);
    expect(hasKeyword(g.state.players[0].lanes[1]!, "Aggressive")).toBe(false);
  });
});

describe("Stone Brand (a creature with Defender gets +N/+N and loses Defender)", () => {
  it("buffs +5/+5 and negates Defender", () => {
    const g = gameWith("stone-brand");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    const hydra = g.state.players[1].lanes[0]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([9, 12]);
    expect(hasKeyword(hydra, "Defender")).toBe(false);
  });
});

describe("Talin Stampede (friendly Tempys creatures get +N attack this turn)", () => {
  it("buffs Tempys creatures only, until end of turn", () => {
    const g = gameWith("talin-stampede");
    spawnCreature(g, [], 0, "ashurian-brawler", 1, { lane: 0 }); // 7/7 Tempys
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 }); // 3/3 Alloyin
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(getStats(g, g.state.players[0].lanes[0]!).attack).toBe(12);
    expect(getStats(g, g.state.players[0].lanes[1]!).attack).toBe(3);
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, g.state.players[0].lanes[0]!).attack).toBe(7);
  });
});

describe("Thundergale Invoker (Forge: adjacent creatures move one space away)", () => {
  it("pushes adjacent creatures outward when the far space is open", () => {
    const g = gameWith("thundergale-invoker");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 4 }); // blocks lane 3's escape
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes[0]?.defId).toBe("cavern-hydra"); // 1 -> 0
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[2]?.defId).toBe("thundergale-invoker");
    expect(g.state.players[0].lanes[3]?.defId).toBe("cavern-hydra"); // 3 -> 4 impossible: stays
    expect(g.state.players[0].lanes[4]?.defId).toBe("cavern-hydra");
  });
});

describe("Turnabout (each creature gets +N attack and -N health this turn)", () => {
  it("applies to both sides and can be lethal", () => {
    const g = gameWith("turnabout");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // 4/7
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2, overrideStats: { attack: 1, health: 2 } });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(getStats(g, g.state.players[0].lanes[0]!)).toEqual({ attack: 6, health: 5 });
    expect(getStats(g, g.state.players[1].lanes[1]!)).toEqual({ attack: 6, health: 5 });
    expect(g.state.players[1].lanes[2]).toBeNull(); // 2 - 2 health: destroyed at batch end
  });
});

describe("Umbruk Glider (Allied Uterra: gets Breakthrough)", () => {
  it("gains Breakthrough with an Uterra card in hand", () => {
    const g = gameWith("umbruk-glider");
    g.state.players[0].hand.push({ uid: 9004, defId: "cavern-hydra", level: 1, owner: 0 }); // Uterra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(hasKeyword(g.state.players[0].lanes[0]!, "Breakthrough")).toBe(true);
  });

  it("does not gain Breakthrough without an Uterra card in hand", () => {
    const g = gameWith("umbruk-glider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(hasKeyword(g.state.players[0].lanes[0]!, "Breakthrough")).toBe(false);
  });
});

describe("Uranti Heartseeker (Activate: 4 damage to an enemy with exactly N health)", () => {
  it("targets only exact-health enemies and deals 4", () => {
    const g = gameWith("uranti-heartseeker");
    spawnCreature(g, [], 0, "uranti-heartseeker", 1, { lane: 0 }); // 4/4 Defender
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 1, health: 4 } });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // 7 health: not a target
    const seeker = g.state.players[0].lanes[0]!;
    const target = g.state.players[1].lanes[1]!;
    seeker.defensive = false;
    applyAction(g, { type: "activate", uid: seeker.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    expect(req.options).toEqual([target.uid]); // 7-health hydra and 120-health player excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: target.uid });
    expect(g.state.players[1].lanes[1]).toBeNull(); // 4 damage kills the 4-health creature
    expect(g.state.players[1].lanes[2]).not.toBeNull();
  });
});

describe("Uranti Icemage (Activate: Negate Defender from a creature this turn)", () => {
  it("removes Defender immediately and restores it at end of turn", () => {
    const g = gameWith("uranti-icemage");
    spawnCreature(g, [], 0, "uranti-icemage", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const icemage = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    icemage.defensive = false;
    applyAction(g, { type: "activate", uid: icemage.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Defender")).toBe(false);
    applyAction(g, { type: "endTurn" });
    expect(hasKeyword(hydra, "Defender")).toBe(true); // "this turn" expires
  });
});

describe("Uranti Warlord (Forge: each friendly Yeti deals N to the opposing creature)", () => {
  it("every friendly Yeti (including Earth Yetis and itself) deals 3", () => {
    const g = gameWith("uranti-warlord");
    spawnCreature(g, [], 0, "wallbreaker-yeti", 1, { lane: 2 }); // "Earth Yeti" counts as a Yeti
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // warlord is a Yeti itself
    expect(g.state.players[1].lanes[0]!.damage).toBe(3);
    expect(g.state.players[1].lanes[2]!.damage).toBe(3);
  });
});

describe("Wallbreaker Yeti (Forge: you may destroy an enemy low-level Defender)", () => {
  it("accepted: destroys an enemy level 1 creature with Defender", () => {
    const g = gameWith("wallbreaker-yeti");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
  });

  it("declined or no Defender: the creature survives", () => {
    const g = gameWith("wallbreaker-yeti");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    grantKeyword([], hydra, { keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[1].lanes[0]).not.toBeNull();
  });

  it("offers no choice when no enemy Defender is on board", () => {
    const g = gameWith("wallbreaker-yeti");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // no Defender
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[0]).not.toBeNull();
  });
});
