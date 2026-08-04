import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, destroyCreature, getCardScript,
  grantKeyword, hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
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

const SCRIPTED = [
  "brambleaxe-warrior", "branchweaver-druid", "chistlehearth-hunter", "dissolve", "dryads-boon",
  "esperian-wartusk", "glowhive-siren", "mending-spring", "mimicleaf", "nuada-faiths-flourish",
  "oros-deepwoods-chosen", "poisoncoil", "solstice-reveler", "spore-torrent", "stouthide-stegadon",
  "twinstrength", "umbruk-lasher", "uterradon-mauler", "uterradon-rex", "venomous-netherscale",
  "verdant-grace",
];

describe("Set 2 Uterra script registration", () => {
  it("registers every scripted Set 2 Uterra card", () => {
    for (const id of SCRIPTED) expect(getCardScript(id), id).not.toBeNull();
  });

  it("does not register the TODO card (runebark-guardian: no heal trigger in the engine)", () => {
    expect(getCardScript("runebark-guardian")).toBeNull();
  });
});

describe("Brambleaxe Warrior (Forge: creature gets Breakthrough this turn)", () => {
  it("gives the chosen creature Breakthrough until end of turn", () => {
    const g = gameWith("brambleaxe-warrior");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Breakthrough")).toBe(true);
    applyAction(g, { type: "endTurn" });
    expect(hasKeyword(hydra, "Breakthrough")).toBe(false); // temp grant wears off
  });
});

describe("Branchweaver Druid (Forge: optional Treefolk in another space)", () => {
  it("accepted: puts a 5/5 Treefolk into a space other than its own", () => {
    const g = gameWith("branchweaver-druid");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending!.request.optional).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true });
    const token = g.state.players[0].lanes.find((c) => c?.defId === "treefolk");
    expect(token).toBeDefined();
    expect([token!.attack, token!.health]).toEqual([5, 5]);
    expect(token!.lane).not.toBe(2);
  });

  it("declined: no token", () => {
    const g = gameWith("branchweaver-druid");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
  });
});

describe("Chistlehearth Hunter (Forge: +1 attack per other friendly creature)", () => {
  it("gets +2 attack with two other friendly creatures on board", () => {
    const g = gameWith("chistlehearth-hunter");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const hunter = g.state.players[0].lanes[2]!;
    expect([hunter.attack, hunter.health]).toEqual([4, 8]); // 2/8 + 2 attack
  });
});

describe("Dissolve (double Poison)", () => {
  it("L1 doubles the Poison on the chosen enemy creature", () => {
    const g = gameWith("dissolve");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const foe = g.state.players[1].lanes[1]!;
    grantKeyword([], foe, { keyword: "Poison", value: 3 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(6);
  });

  it("L3 is Free and doubles the Poison on every enemy creature", () => {
    const g = gameWith("dissolve");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    grantKeyword([], g.state.players[1].lanes[0]!, { keyword: "Poison", value: 2 });
    grantKeyword([], g.state.players[1].lanes[2]!, { keyword: "Poison", value: 5 });
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playsLeft).toBe(2); // Free: costs no play
    expect(keywordValue(g.state.players[1].lanes[0]!, "Poison")).toBe(4);
    expect(keywordValue(g.state.players[1].lanes[2]!, "Poison")).toBe(10);
  });
});

describe("Dryad's Boon (buff + granted friendly-entry growth)", () => {
  it("buffs the target and grows it again when another friendly creature enters play", () => {
    const g = gameWith("dryads-boon");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([5, 8]); // 4/7 + 1/+1
    const initial = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect([hydra.attack, hydra.health]).toEqual([6, 9]); // granted ability fired
    expect(g.state.players[0].lanes[1]!.attack).toBe(4); // the newcomer is unaffected
  });
});

describe("Esperian Wartusk (Allied Alloyin: Armor N)", () => {
  it("gains Armor 1 with an Alloyin card in hand", () => {
    const g = gameWith("esperian-wartusk");
    g.state.players[0].hand.push({ uid: 9001, defId: "aegis-conscript", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(1);
  });

  it("gets no Armor without an Alloyin card in hand", () => {
    const g = gameWith("esperian-wartusk");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(0);
  });
});

describe("Glowhive Siren (Vengeance: gain 1-4 health)", () => {
  it("heals its controller for 1 to 4 when destroyed", () => {
    const g = createGame(cards, deckOf("glowhive-siren"), deckOf("cavern-hydra"), 7, { startingHealth: 100 });
    spawnCreature(g, [], 0, "glowhive-siren", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => destroyCreature(g, [], c));
    runBatches(g, [], initial);
    const hp = g.state.players[0].health;
    expect(hp).toBeGreaterThanOrEqual(101);
    expect(hp).toBeLessThanOrEqual(104);
  });
});

describe("Mending Spring (gain 1..N health)", () => {
  it("L3 heals between 1 and 40", () => {
    const g = createGame(cards, deckOf("mending-spring"), deckOf("cavern-hydra"), 7, { startingHealth: 50 });
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hp = g.state.players[0].health;
    expect(hp).toBeGreaterThanOrEqual(51);
    expect(hp).toBeLessThanOrEqual(90);
  });
});

describe("Mimicleaf (Activate: same-level copy into an adjacent space)", () => {
  it("puts another level 1 Mimicleaf into an adjacent space", () => {
    const g = gameWith("mimicleaf");
    spawnCreature(g, [], 0, "mimicleaf", 1, { lane: 2 });
    const c = g.state.players[0].lanes[2]!;
    c.defensive = false;
    applyAction(g, { type: "activate", uid: c.uid });
    const copy = [g.state.players[0].lanes[1], g.state.players[0].lanes[3]]
      .find((x) => x?.defId === "mimicleaf");
    expect(copy).toBeDefined();
    expect([copy!.attack, copy!.health, copy!.level]).toEqual([2, 2, 1]);
  });

  it("fizzles when both adjacent spaces are occupied", () => {
    const g = gameWith("mimicleaf");
    spawnCreature(g, [], 0, "mimicleaf", 1, { lane: 2 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 });
    const c = g.state.players[0].lanes[2]!;
    c.defensive = false;
    applyAction(g, { type: "activate", uid: c.uid });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(3); // unchanged
  });
});

describe("Nuada, Faith's Flourish (Activate: replace a friendly Plant with a Treefolk)", () => {
  it("replaces the chosen Plant with a 9/9 Treefolk (no destruction)", () => {
    const g = gameWith("nuada-faiths-flourish");
    spawnCreature(g, [], 0, "nuada-faiths-flourish", 1, { lane: 0 });
    spawnCreature(g, [], 0, "seedling", 1, { lane: 1, overrideStats: { attack: 1, health: 1 } });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 }); // not a Plant
    const nuada = g.state.players[0].lanes[0]!;
    const seedling = g.state.players[0].lanes[1]!;
    nuada.defensive = false;
    applyAction(g, { type: "activate", uid: nuada.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([seedling.uid]); // only the Plant is a legal target
    applyChoice(g, { id: req.id, accepted: true, targetUid: seedling.uid });
    const tree = g.state.players[0].lanes[1]!;
    expect(tree.defId).toBe("treefolk");
    expect([tree.attack, tree.health]).toEqual([9, 9]);
    expect(g.state.players[0].discard.some((i) => i.defId === "seedling")).toBe(true); // replaced
  });
});

describe("Oros, Deepwood's Chosen (battle damage to a player gains that much health)", () => {
  it("heals its controller for the battle damage dealt", () => {
    const g = createGame(cards, deckOf("oros-deepwoods-chosen"), deckOf("cavern-hydra"), 7,
      { startingHealth: [100, 120] });
    spawnCreature(g, [], 0, "oros-deepwoods-chosen", 1, { lane: 0 });
    const oros = g.state.players[0].lanes[0]!;
    oros.defensive = false;
    applyAction(g, { type: "battle" }); // unopposed: 7 to the enemy player
    expect(g.state.players[1].health).toBe(113); // 120 - 7
    expect(g.state.players[0].health).toBe(107); // 100 + 7
  });
});

describe("Poisoncoil (Activate: another creature gets Poison N)", () => {
  it("gives the chosen creature Poison 1 (self excluded)", () => {
    const g = gameWith("poisoncoil");
    spawnCreature(g, [], 0, "poisoncoil", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const coil = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    coil.defensive = false;
    applyAction(g, { type: "activate", uid: coil.uid });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(keywordValue(hydra, "Poison")).toBe(1);
  });
});

describe("Solstice Reveler (rankGained: friendly board buff)", () => {
  it("gives each friendly creature +2/+2 on rank-up", () => {
    const g = gameWith("solstice-reveler");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    passTurns(g, 8); // 4 own endTurns -> rank 2
    expect(g.state.players[0].rank).toBe(2);
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([6, 6]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([6, 9]);
  });

  it("L3 also grants Breakthrough", () => {
    const g = gameWith("solstice-reveler");
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    passTurns(g, 8);
    const rev = g.state.players[0].lanes[0]!;
    expect([rev.attack, rev.health]).toEqual([24, 24]); // 16/16 + 8/+8
    expect(hasKeyword(rev, "Breakthrough")).toBe(true);
  });
});

describe("Spore Torrent (give a creature Poison N)", () => {
  it("gives the chosen creature Poison 2", () => {
    const g = gameWith("spore-torrent");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const foe = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(2);
  });

  it("L2 is Free and gives Poison 3", () => {
    const g = gameWith("spore-torrent");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const foe = g.state.players[1].lanes[1]!;
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playsLeft).toBe(2); // Free
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(keywordValue(foe, "Poison")).toBe(3);
  });
});

describe("Stouthide Stegadon (rankGained: heal itself)", () => {
  it("heals 10 damage from itself on rank-up", () => {
    const g = gameWith("stouthide-stegadon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    c.damage = 6;
    passTurns(g, 8); // 4 own endTurns -> rank 2
    expect(g.state.players[0].rank).toBe(2);
    expect(c.damage).toBe(0); // healed 10, capped at the 6 marked
  });
});

describe("Twinstrength (two friendly creatures get +N/+N)", () => {
  it("chains two friendly-creature picks and buffs both", () => {
    const g = gameWith("twinstrength");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const a = g.state.players[0].lanes[0]!;
    const b = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: a.uid });
    expect([a.attack, a.health]).toEqual([7, 10]); // 4/7 + 3/+3
    const req2 = g.state.pending!.request;
    expect(req2.options).toEqual([b.uid]); // first pick excluded
    applyChoice(g, { id: req2.id, accepted: true, targetUid: b.uid });
    expect(g.state.pending).toBeNull();
    expect([b.attack, b.health]).toEqual([7, 10]);
  });

  it("with a single friendly creature there is no second pick", () => {
    const g = gameWith("twinstrength");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const a = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: a.uid });
    expect(g.state.pending).toBeNull();
    expect([a.attack, a.health]).toEqual([7, 10]);
  });
});

describe("Umbruk Lasher (Allied Tempys: battle damage strike)", () => {
  it("with a Tempys card in hand, may deal its player damage to an enemy creature", () => {
    const g = gameWith("umbruk-lasher");
    g.state.players[0].hand.push({ uid: 9001, defId: "lightning-spark", level: 1, owner: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const lasher = g.state.players[0].lanes[0]!;
    lasher.defensive = false;
    applyAction(g, { type: "battle" }); // lasher hits the enemy player for 7
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(7);
    expect(g.state.players[1].health).toBe(120 - 7);
  });

  it("without a Tempys card in hand there is no strike", () => {
    const g = gameWith("umbruk-lasher");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const lasher = g.state.players[0].lanes[0]!;
    lasher.defensive = false;
    applyAction(g, { type: "battle" });
    expect(g.state.pending).toBeNull();
    expect(foe.damage).toBe(0);
  });
});

describe("Uterradon Mauler (Forge: buffed while opposed)", () => {
  it("gets +2/+2 when played into an opposed lane", () => {
    const g = gameWith("uterradon-mauler");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect([g.state.players[0].lanes[2]!.attack, g.state.players[0].lanes[2]!.health]).toEqual([6, 6]);
  });

  it("gets nothing when unopposed", () => {
    const g = gameWith("uterradon-mauler");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([4, 4]);
  });
});

describe("Uterradon Rex (friendly Dinosaur entry gets +N/+N)", () => {
  it("buffs another friendly Dinosaur as it enters play", () => {
    const g = gameWith("uterradon-rex");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // rex #1
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // rex #2 (a Dinosaur)
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([5, 8]);
    expect(g.state.players[0].lanes[0]!.attack).toBe(4); // rex #1 unchanged
  });

  it("ignores non-Dinosaur entries", () => {
    const g = gameWith("uterradon-rex");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const initial = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect(g.state.players[0].lanes[1]!.attack).toBe(4); // hydra is not a Dinosaur
  });
});

describe("Venomous Netherscale (Forge: double enemy Poison)", () => {
  it("doubles the Poison on each enemy creature", () => {
    const g = gameWith("venomous-netherscale");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    grantKeyword([], g.state.players[1].lanes[0]!, { keyword: "Poison", value: 2 });
    grantKeyword([], g.state.players[1].lanes[1]!, { keyword: "Poison", value: 3 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[1].lanes[0]!, "Poison")).toBe(4);
    expect(keywordValue(g.state.players[1].lanes[1]!, "Poison")).toBe(6);
  });

  it("L3 also doubles the enemy player's Poison", () => {
    const g = gameWith("venomous-netherscale");
    g.state.players[1].poison = 5;
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].poison).toBe(10);
  });
});

describe("Verdant Grace (heal one friendly N, each other M)", () => {
  it("heals the chosen creature 10 and each other friendly creature 2", () => {
    const g = gameWith("verdant-grace");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const a = g.state.players[0].lanes[0]!;
    const b = g.state.players[0].lanes[1]!;
    a.damage = 6;
    b.damage = 3;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: a.uid });
    expect(a.damage).toBe(0); // healed 10 (capped at 6)
    expect(b.damage).toBe(1); // healed 2
  });
});
