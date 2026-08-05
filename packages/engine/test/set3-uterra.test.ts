import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript,
  grantKeyword, hasKeyword, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet;
const set31 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set3, set31, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

function addToDiscard(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].discard.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

/** Deal non-combat damage to a creature and resolve the resulting batch. */
function ping(g: Game, uid: number, amount: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => dealCreatureDamage(g, [], c, amount));
  runBatches(g, [], initial);
}

describe("Set 3/3.1 Uterra script registration", () => {
  it("registers every Set 3 + 3.1 Uterra card in scope", () => {
    const scripted = [
      "aetherphage", "bramblewood-tracker", "dozer-the-dormant", "dysian-sludge",
      "lysian-shard", "metamorphosis", "scatter-the-seeds", "seal-of-deepwood",
      "shardbound-invoker", "tangle", "toorgmai-guardian", "tuskin-sporelord",
      "weirwood-ranger",
    ];
    for (const id of scripted) expect(cards[id], id).toBeTruthy();
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
    // support cards referenced by scripts
    for (const id of ["funguy", "dozer-the-awakened", "feywing-chrysalis"]) {
      expect(cards[id], id).toBeTruthy();
    }
  });
});

describe("Aetherphage (Forge: pluck a spell from the enemy hand)", () => {
  it("L1 offers only level 1 enemy spells; the enemy discards it without leveling", () => {
    const g = gameWith("aetherphage");
    g.state.players[1].hand = [];
    addToHand(g, 1, "cavern-hydra", 1); // creature: not an option
    addToHand(g, 1, "lightning-spark", 1); // legal
    addToHand(g, 1, "lightning-spark", 2); // gated out at L1
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBeFalsy(); // mandatory
    expect(req.options).toEqual([1]);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 1 });
    const p1 = g.state.players[1];
    expect(p1.hand.map((c) => c.defId)).toEqual(["cavern-hydra", "lightning-spark"]);
    expect(p1.discard).toHaveLength(1); // no level-up copy of the discarded spell
    expect([p1.discard[0]!.defId, p1.discard[0]!.level]).toEqual(["lightning-spark", 1]);
  });

  it("no prompt when the enemy hand has no level-legal spell", () => {
    const g = gameWith("aetherphage");
    g.state.players[1].hand = [];
    addToHand(g, 1, "lightning-spark", 2);
    addToHand(g, 1, "cavern-hydra", 1);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].hand).toHaveLength(2);
  });
});

describe("Dozer, the Dormant (damaged and survives: awaken)", () => {
  it("survives damage: replaced by a same-level Dozer, the Awakened", () => {
    const g = gameWith("dozer-the-dormant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const dozer = g.state.players[0].lanes[2]!;
    expect(hasKeyword(dozer, "Defender")).toBe(true);
    ping(g, dozer.uid, 4); // 0/9 down to 5 health — survives
    const awoken = g.state.players[0].lanes[2]!;
    expect(awoken.defId).toBe("dozer-the-awakened");
    expect([awoken.attack, awoken.health, awoken.damage]).toEqual([9, 9, 0]);
    expect(hasKeyword(awoken, "Aggressive")).toBe(true);
    expect(hasKeyword(awoken, "Breakthrough")).toBe(true);
    expect(g.state.players[0].discard.some((c) => c.defId === "dozer-the-dormant" && c.level === 1)).toBe(true);
  });

  it("does not awaken when the damage is lethal", () => {
    const g = gameWith("dozer-the-dormant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const dozer = g.state.players[0].lanes[2]!;
    ping(g, dozer.uid, 9);
    expect(g.state.players[0].lanes[2]).toBeNull();
    expect(g.state.players.flatMap((p) => p.lanes).some((c) => c?.defId === "dozer-the-awakened")).toBe(false);
  });
});

describe("Dysian Sludge (Forge copy at 100+ health; Allied Nekrium wither)", () => {
  it("over 100 health: may put a copy into another space", () => {
    const g = gameWith("dysian-sludge");
    g.state.players[0].health = 101;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    const sludges = g.state.players[0].lanes.filter((c) => c?.defId === "dysian-sludge");
    expect(sludges).toHaveLength(2);
    expect(g.state.players[0].lanes[2]!.defId).toBe("dysian-sludge"); // original stayed
  });

  it("at exactly 100 health the Forge does not trigger", () => {
    const g = gameWith("dysian-sludge");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
  });

  it("Allied Nekrium: the opposing creature gets -1/-1 on entry", () => {
    const g = gameWith("dysian-sludge");
    g.state.players[0].health = 100; // keep the Forge copy out of this test
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    addToHand(g, 0, "death-seeker"); // Nekrium card enables the Allied trigger
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    expect([hydra.attack, hydra.health]).toEqual([3, 6]); // 4/7 - 1/-1
  });

  it("no Nekrium card in hand: no debuff", () => {
    const g = gameWith("dysian-sludge");
    g.state.players[0].health = 100;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    expect([hydra.attack, hydra.health]).toEqual([4, 7]);
  });
});

describe("Shardbound Invoker (Forge at Rank gate: +N/+N)", () => {
  it("does nothing below the rank gate", () => {
    const g = gameWith("shardbound-invoker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // rank 1 < 2
    expect(g.state.pending).toBeNull();
    const invoker = g.state.players[0].lanes[0]!;
    expect([invoker.attack, invoker.health]).toEqual([4, 5]);
  });

  it("at rank 2 gives a chosen creature +3/+3", () => {
    const g = gameWith("shardbound-invoker");
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const invoker = g.state.players[0].lanes[0]!;
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([invoker.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: invoker.uid });
    expect([invoker.attack, invoker.health]).toEqual([7, 8]);
  });
});

describe("Toorgmai Guardian (Forge: optional Banish a Plant for +N/+N)", () => {
  it("banishing a Plant from the discard pile gives +3/+3", () => {
    const g = gameWith("toorgmai-guardian");
    addToDiscard(g, 0, "seedling", 1); // Plant
    addToDiscard(g, 0, "death-seeker", 1); // not a Plant
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    // the leveled-up copy of the guardian (a Plant) lands in the discard first
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInDiscard");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0, 2]);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.removed.map((c) => c.defId)).toEqual(["seedling"]);
    const guardian = p0.lanes[0]!;
    expect([guardian.attack, guardian.health]).toEqual([7, 7]); // 4/4 + 3/+3
  });

  it("declined: no Banish, no buff", () => {
    const g = gameWith("toorgmai-guardian");
    addToDiscard(g, 0, "seedling", 1);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    const p0 = g.state.players[0];
    expect(p0.removed).toHaveLength(0);
    expect(p0.discard).toHaveLength(2); // seedling + leveled guardian copy
    const guardian = p0.lanes[0]!;
    expect([guardian.attack, guardian.health]).toEqual([4, 4]);
  });
});

describe("Tuskin Sporelord (Solbind Funguy; Activate: copy a friendly Plant)", () => {
  it("Solbind adds one Funguy to the deck at game start", () => {
    const g = gameWith("tuskin-sporelord");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand].map((c) => c.defId);
    expect(all).toHaveLength(31); // 30 + 1 bound
    expect(all.filter((id) => id === "funguy")).toHaveLength(1);
  });

  it("Activate puts a fresh copy of a friendly level 1 Plant into an open space", () => {
    const g = gameWith("tuskin-sporelord");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "funguy", 1, { lane: 1 });
    spawnCreature(g, [], 0, "funguy", 2, { lane: 2 }); // gated out at sporelord L1
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 }); // not a Plant
    const lord = g.state.players[0].lanes[0]!;
    const funguy = g.state.players[0].lanes[1]!;
    lord.defensive = false;
    applyAction(g, { type: "activate", uid: lord.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([funguy.uid]); // L2 Plant and non-Plant excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: funguy.uid });
    const funguys = g.state.players[0].lanes.filter((c) => c?.defId === "funguy" && c.level === 1);
    expect(funguys).toHaveLength(2);
    const copy = funguys.find((c) => c!.uid !== funguy.uid)!;
    expect([copy.attack, copy.health]).toEqual([6, 6]); // fresh copy
  });
});

describe("Weirwood Ranger (Activate: +N/+N)", () => {
  it("gives a chosen creature +1/+1 at L1", () => {
    const g = gameWith("weirwood-ranger");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const ranger = g.state.players[0].lanes[0]!;
    ranger.defensive = false;
    applyAction(g, { type: "activate", uid: ranger.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: ranger.uid });
    expect([ranger.attack, ranger.health]).toEqual([6, 5]); // 5/4 + 1/+1
  });
});

describe("Bramblewood Tracker (Set 3.1; L2+ Forge: an additional Uterra creature)", () => {
  it("L1 is vanilla — no Forge prompt", () => {
    const g = gameWith("bramblewood-tracker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
  });

  it("L2 accepted: grants an extra play this turn", () => {
    const g = gameWith("bramblewood-tracker");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.playsLeft).toBe(1);
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    expect(g.state.playsLeft).toBe(2);
  });

  it("L2 declined: no extra play", () => {
    const g = gameWith("bramblewood-tracker");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.playsLeft).toBe(1);
  });
});

describe("Lysian Shard (Overload buff)", () => {
  it("gives a creature +6/+6 and is removed from the game instead of discarded", () => {
    const g = gameWith("lysian-shard");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([10, 13]); // 4/7 + 6/+6
    const p0 = g.state.players[0];
    expect(p0.removed.map((c) => c.defId)).toEqual(["lysian-shard"]); // Overload
    expect(p0.discard).toHaveLength(0);
  });
});

describe("Metamorphosis (replace with Feywing Chrysalis)", () => {
  it("L1 replaces an enemy level 1 creature; level 2 creatures are gated out", () => {
    const g = gameWith("metamorphosis");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 });
    const hydraL1 = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([hydraL1.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydraL1.uid });
    const chrysalis = g.state.players[1].lanes[1]!;
    expect(chrysalis.defId).toBe("feywing-chrysalis"); // stays on the enemy's side
    expect([chrysalis.attack, chrysalis.health, chrysalis.level]).toEqual([0, 3, 1]);
    expect(hasKeyword(chrysalis, "Defender")).toBe(true);
    expect(g.state.players[1].lanes[2]!.defId).toBe("cavern-hydra"); // untouched
    expect(g.state.players[1].discard.some((c) => c.defId === "cavern-hydra" && c.level === 1)).toBe(true);
  });
});

describe("Scatter the Seeds (three Plant tokens)", () => {
  it("L1 Spawns three 1/1 Seedlings", () => {
    const g = gameWith("scatter-the-seeds");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const seedlings = g.state.players[0].lanes.filter((c) => c?.defId === "seedling");
    expect(seedlings).toHaveLength(3);
    for (const s of seedlings) expect([s!.attack, s!.health]).toEqual([1, 1]);
  });

  it("L3 Spawns three 5/5 Treefolk", () => {
    const g = gameWith("scatter-the-seeds");
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const treefolk = g.state.players[0].lanes.filter((c) => c?.defId === "treefolk");
    expect(treefolk).toHaveLength(3);
    for (const t of treefolk) expect([t!.attack, t!.health]).toEqual([5, 5]);
  });
});

describe("Seal of Deepwood (creature +N/+N)", () => {
  it("L2 gives a creature +6/+6", () => {
    const g = gameWith("seal-of-deepwood");
    g.state.players[0].hand[0]!.level = 2;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([10, 13]); // 4/7 + 6/+6
  });
});

describe("Tangle (destroy a Mobility creature)", () => {
  it("L1 destroys a level 1 creature with Mobility; level 3 and non-Mobility are gated out", () => {
    const g = gameWith("tangle");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    const mobile = g.state.players[1].lanes[1]!;
    const mobileL3 = g.state.players[1].lanes[2]!;
    grantKeyword([], mobile, { keyword: "Mobility", value: 1 });
    grantKeyword([], mobileL3, { keyword: "Mobility", value: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([mobile.uid]); // L3 and non-Mobility excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: mobile.uid });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[2]).not.toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
  });

  it("L3 also gains health equal to the destroyed creature's attack", () => {
    const g = gameWith("tangle");
    g.state.players[0].hand[0]!.level = 3;
    g.state.players[0].health = 100;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4 attack
    const mobile = g.state.players[1].lanes[1]!;
    grantKeyword([], mobile, { keyword: "Mobility", value: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mobile.uid });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[0].health).toBe(104); // 100 + 4
  });
});
