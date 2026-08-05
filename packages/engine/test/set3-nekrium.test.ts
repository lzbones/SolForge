import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, destroyCreature, getCardScript, getStats,
  keywordValue, loadCards, refreshStatics, runBatches, spawnCreature,
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

/** Destroy a creature outside of combat, resolving its trigger batch. */
function slay(g: Game, uid: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => destroyCreature(g, [], c));
  runBatches(g, [], initial);
}

describe("Set 3/3.1 Nekrium script registration", () => {
  it("registers every Set 3 + 3.1 Nekrium card in scope", () => {
    const scripted = [
      "catacomb-spider", "contagion-lord", "contagion-fiend", "dysian-broodqueen",
      "dysian-siphon", "ebonbound-warlord", "fleshreaver", "grimgaunt-doomrider",
      "nefrax-the-soulweaver", "ruthless-wanderers", "seal-of-tarsus", "spiritcleave",
      "suruzal-emissary-of-varna", "tomb-pillager", "xithian-direhound", "zombie-titan",
    ];
    for (const id of scripted) expect(cards[id], id).toBeTruthy();
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
  });
});

describe("Catacomb Spider (Activate: Regenerate N)", () => {
  it("gives a chosen creature Regenerate 2 at L1", () => {
    const g = gameWith("catacomb-spider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const spider = g.state.players[0].lanes[0]!;
    spider.defensive = false;
    applyAction(g, { type: "activate", uid: spider.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: spider.uid });
    expect(keywordValue(spider, "Regenerate")).toBe(2);
  });
});

describe("Contagion Lord (Solbind + Activate)", () => {
  it("Solbind adds two Contagion Fiends to the deck at game start", () => {
    const g = gameWith("contagion-lord");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand].map((c) => c.defId);
    expect(all).toHaveLength(32); // 30 + 2 bound
    expect(all.filter((id) => id === "contagion-fiend")).toHaveLength(2);
  });

  it("Activate destroys a friendly Abomination for an extra play; the Fiend's Vengeance fires", () => {
    const g = gameWith("contagion-lord");
    spawnCreature(g, [], 0, "contagion-lord", 1, { lane: 0 });
    spawnCreature(g, [], 0, "contagion-fiend", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const lord = g.state.players[0].lanes[0]!;
    const fiend = g.state.players[0].lanes[1]!;
    const hydra = g.state.players[1].lanes[2]!;
    lord.defensive = false;
    const playsBefore = g.state.playsLeft;
    applyAction(g, { type: "activate", uid: lord.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([lord.uid, fiend.uid]); // both Abominations
    applyChoice(g, { id: req.id, accepted: true, targetUid: fiend.uid });
    expect(g.state.playsLeft).toBe(playsBefore + 1);
    expect(g.state.players[0].lanes[1]).toBeNull(); // fiend destroyed
    expect([hydra.attack, hydra.health]).toEqual([3, 6]); // fiend Vengeance: -1/-1
  });
});

describe("Contagion Fiend (Vengeance: enemy board -N/-N)", () => {
  it("gives each enemy creature -1/-1 at L1", () => {
    const g = gameWith("contagion-lord");
    spawnCreature(g, [], 0, "contagion-fiend", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    slay(g, g.state.players[0].lanes[0]!.uid);
    expect([g.state.players[1].lanes[1]!.attack, g.state.players[1].lanes[1]!.health]).toEqual([3, 6]);
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([3, 6]);
  });
});

describe("Dysian Broodqueen (Allied Broodfang + Activate chain)", () => {
  it("Allied Uterra: puts a 1/1 Broodfang into an available space", () => {
    const g = gameWith("dysian-broodqueen");
    addToHand(g, 0, "cavern-hydra"); // Uterra card enables the Allied trigger
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const brood = g.state.players[0].lanes.find((c) => c?.defId === "broodfang");
    expect(brood).toBeTruthy();
    expect([brood!.attack, brood!.health]).toEqual([1, 1]);
    expect(brood!.uid).not.toBe(g.state.players[0].lanes[2]!.uid);
  });

  it("no Broodfang without an Uterra card in hand", () => {
    const g = gameWith("dysian-broodqueen");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
  });

  it("Activate chains sacrifice then level-gated enemy destruction", () => {
    const g = gameWith("dysian-broodqueen");
    spawnCreature(g, [], 0, "dysian-broodqueen", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 3 });
    const queen = g.state.players[0].lanes[0]!;
    const sacrifice = g.state.players[0].lanes[1]!;
    const foeL1 = g.state.players[1].lanes[2]!;
    queen.defensive = false;
    applyAction(g, { type: "activate", uid: queen.uid });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([sacrifice.uid]); // "another" friendly creature
    applyChoice(g, { id: req1.id, accepted: true, targetUid: sacrifice.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([foeL1.uid]); // L2 foe gated out at queen L1
    applyChoice(g, { id: req2.id, accepted: true, targetUid: foeL1.uid });
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
  });
});

describe("Dysian Siphon (enemy -N/-N; Allied friendly +N/+N)", () => {
  it("chains the Allied friendly buff after the enemy debuff", () => {
    const g = gameWith("dysian-siphon");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    addToHand(g, 0, "cavern-hydra"); // Uterra card enables Allied
    const friend = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("enemyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: foe.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req2.id, accepted: true, targetUid: friend.uid });
    expect(g.state.pending).toBeNull();
    expect([foe.attack, foe.health]).toEqual([1, 4]); // 4/7 - 3
    expect([friend.attack, friend.health]).toEqual([7, 10]); // 4/7 + 3
  });

  it("without Uterra in hand only the enemy debuff happens", () => {
    const g = gameWith("dysian-siphon");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const friend = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.pending).toBeNull(); // no second prompt
    expect([foe.attack, foe.health]).toEqual([1, 4]);
    expect([friend.attack, friend.health]).toEqual([4, 7]);
  });
});

describe("Ebonbound Warlord (Forge at Rank gate: -N/-N)", () => {
  it("does nothing below the rank gate", () => {
    const g = gameWith("ebonbound-warlord");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // rank 1 < 2
    expect(g.state.pending).toBeNull();
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([4, 7]);
  });

  it("at rank 2 gives a chosen creature -3/-3", () => {
    const g = gameWith("ebonbound-warlord");
    g.state.players[0].rank = 2;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.optional).toBeFalsy(); // mandatory
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([1, 4]);
  });
});

describe("Fleshreaver (Forge: optional enemy destruction)", () => {
  it("L2 may destroy an enemy level 1 creature", () => {
    const g = gameWith("fleshreaver");
    g.state.players[0].hand[0]!.level = 2;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 3 });
    const foeL1 = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([foeL1.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foeL1.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
  });
});

describe("Grimgaunt Doomrider (ride to a dead friendly creature's space)", () => {
  it("debuffs the opposing creature, moves into the space, then buffs itself", () => {
    const g = gameWith("grimgaunt-doomrider");
    spawnCreature(g, [], 0, "grimgaunt-doomrider", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    slay(g, g.state.players[0].lanes[2]!.uid);
    const rider = g.state.players[0].lanes[2];
    expect(rider?.defId).toBe("grimgaunt-doomrider"); // moved into the dead creature's space
    expect([rider!.attack, rider!.health]).toEqual([5, 7]); // 4/6 + 1/+1
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([3, 6]); // -1/-1 first
  });

  it("ignores enemy creature deaths", () => {
    const g = gameWith("grimgaunt-doomrider");
    spawnCreature(g, [], 0, "grimgaunt-doomrider", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    slay(g, g.state.players[1].lanes[2]!.uid);
    const rider = g.state.players[0].lanes[0];
    expect(rider?.defId).toBe("grimgaunt-doomrider"); // stayed put
    expect([rider!.attack, rider!.health]).toEqual([4, 6]); // unbuffed
  });
});

describe("Nefrax, the Soulweaver (Forge sacrifice + Spirit Activate)", () => {
  it("Forge destroys a chosen friendly creature; Activate puts a 5/5 Spirit into play", () => {
    const g = gameWith("nefrax-the-soulweaver");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const nefrax = g.state.players[0].lanes[0]!;
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.optional).toBeFalsy(); // mandatory
    expect(req.options).toEqual([nefrax.uid, hydra.uid]); // may target itself
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[0].lanes[1]).toBeNull();
    nefrax.defensive = false;
    applyAction(g, { type: "activate", uid: nefrax.uid });
    const spirit = g.state.players[0].lanes.find((c) => c?.defId === "spirit-nekrium");
    expect(spirit).toBeTruthy();
    expect([spirit!.attack, spirit!.health]).toEqual([5, 5]);
  });

  it("must destroy itself when it is the only friendly creature", () => {
    const g = gameWith("nefrax-the-soulweaver");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const nefrax = g.state.players[0].lanes[2]!;
    const req = g.state.pending!.request;
    expect(req.options).toEqual([nefrax.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: nefrax.uid });
    expect(g.state.players[0].lanes[2]).toBeNull();
  });
});

describe("Ruthless Wanderers (Spirit Wanderer from hand: opposing -N/-N)", () => {
  it("triggers when another friendly Spirit Wanderer is played from hand", () => {
    const g = gameWith("ruthless-wanderers");
    spawnCreature(g, [], 0, "ruthless-wanderers", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect([hydra.attack, hydra.health]).toEqual([1, 4]); // exactly one -3/-3 (self doesn't trigger)
  });

  it("does not trigger for entries that are not from hand (Advanced Rules errata)", () => {
    const g = gameWith("ruthless-wanderers");
    spawnCreature(g, [], 0, "ruthless-wanderers", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    spawnCreature(g, [], 0, "ruthless-wanderers", 1, { lane: 2 }); // token-style entry
    expect([hydra.attack, hydra.health]).toEqual([4, 7]);
  });
});

describe("Seal of Tarsus (creature -N/-N)", () => {
  it("L2 gives a creature -8/-8, killing a 7-health creature", () => {
    const g = gameWith("seal-of-tarsus");
    g.state.players[0].hand[0]!.level = 2;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull(); // 4/7 - 8/-8 is dead
  });
});

describe("Spiritcleave (highest-health destruction)", () => {
  it("L1 destroys the highest-health creature among levels 2 or lower", () => {
    const g = gameWith("spiritcleave");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 1 }); // 11/15 — gated out
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 }); // 7/10 — highest legal
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[0]).not.toBeNull();
    expect(g.state.players[1].lanes[1]).not.toBeNull();
    expect(g.state.players[1].lanes[2]).toBeNull();
  });

  it("L3 destroys the highest-health creature overall and heals for its health", () => {
    const g = gameWith("spiritcleave");
    g.state.players[0].hand[0]!.level = 3;
    g.state.players[0].health = 100;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 1 }); // 11/15 — highest
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[0]).not.toBeNull();
    expect(g.state.players[0].health).toBe(115); // 100 + 15
  });
});

describe("Suruzal, Emissary of Varna (destroy and respawn a copy)", () => {
  it("destroys another friendly level 1 creature and Spawns a fresh copy", () => {
    const g = gameWith("suruzal-emissary-of-varna");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([hydra.uid]); // "another" friendly creature
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    const lanes = g.state.players[0].lanes;
    expect(lanes[0]!.defId).toBe("suruzal-emissary-of-varna");
    expect(lanes[1]).toBeNull(); // original destroyed (copy lands in an open lane)
    const copy = lanes.find((c) => c?.defId === "cavern-hydra");
    expect(copy).toBeTruthy();
    expect([copy!.attack, copy!.health, copy!.damage]).toEqual([4, 7, 0]); // fresh copy
    expect(g.state.players[0].discard.some((c) => c.defId === "cavern-hydra")).toBe(true);
  });

  it("declined: nothing happens", () => {
    const g = gameWith("suruzal-emissary-of-varna");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(2);
  });
});

describe("Tomb Pillager (Forge: optional Banish from discard)", () => {
  it("banishes a chosen Nekrium card from the discard pile", () => {
    const g = gameWith("tomb-pillager");
    addToDiscard(g, 0, "zombie-titan", 1); // Nekrium
    addToDiscard(g, 0, "cavern-hydra", 1); // Uterra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    // the leveled-up copy of the pillager lands in the discard before the Forge resolves
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInDiscard");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0, 2]); // Nekrium cards only
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.removed.map((c) => c.defId)).toEqual(["zombie-titan"]);
    expect(p0.discard.map((c) => c.defId)).toEqual(["cavern-hydra", "tomb-pillager"]);
  });
});

describe("Xithian Direhound (Forge: optional enemy -4/-4)", () => {
  it("accepted: gives the enemy creature -4/-4", () => {
    const g = gameWith("xithian-direhound");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([0, 3]);
  });

  it("declined: no debuff", () => {
    const g = gameWith("xithian-direhound");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect([g.state.players[1].lanes[1]!.attack, g.state.players[1].lanes[1]!.health]).toEqual([4, 7]);
  });
});

describe("Zombie Titan (side-space static: +N/+N and Regenerate)", () => {
  it("gets +2/+2 and Regenerate 1 in a side space only", () => {
    const g = gameWith("zombie-titan");
    spawnCreature(g, [], 0, "zombie-titan", 1, { lane: 0 }); // side
    spawnCreature(g, [], 0, "zombie-titan", 1, { lane: 2 }); // center
    spawnCreature(g, [], 0, "zombie-titan", 1, { lane: 4 }); // side
    const left = g.state.players[0].lanes[0]!;
    const mid = g.state.players[0].lanes[2]!;
    const right = g.state.players[0].lanes[4]!;
    expect([getStats(g, left).attack, getStats(g, left).health]).toEqual([6, 6]);
    expect([getStats(g, mid).attack, getStats(g, mid).health]).toEqual([4, 4]);
    expect([getStats(g, right).attack, getStats(g, right).health]).toEqual([6, 6]);
    refreshStatics(g);
    expect(keywordValue(left, "Regenerate")).toBe(1);
    expect(keywordValue(mid, "Regenerate")).toBe(0);
    expect(keywordValue(right, "Regenerate")).toBe(1);
  });
});
