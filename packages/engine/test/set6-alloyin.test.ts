import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getCardScript, hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set6 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.json", import.meta.url), "utf8")) as ScrapedSet;
const set61 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set62 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra + forge-guardian-omega
const cards = loadCards(set6, set61, set62, set1);

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

/** Deal damage outside of an action and resolve the resulting batch. */
function ping(g: Game, defId: string, lane: number, amount: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.defId === defId && x.lane === lane)!;
  const initial = collectInto(() => dealCreatureDamage(g, [], c, amount));
  runBatches(g, [], initial);
}

const IDS = [
  "alyssa-strifeborn", "blood-barrier", "darksteel-enforcer", "flowsteel-carrier",
  "forgewatch-sentry", "hermes", "marty-mcgear", "mind-breaker", "pummel-pack",
  "shadowmist-angel", "shadowsmith", "vault-intruder",
  "nexus-bubble", "patron-of-anvillon", "sparky-forge-guard-dog", "wipe-clean",
];

describe("Set 6 Alloyin registration", () => {
  it("all 16 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Alyssa, Strifeborn (takes damage and survives: +X/+1 per damage)", () => {
  it("gains +1 attack and +1 health per damage at L1", () => {
    const g = gameWith("alyssa-strifeborn");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 2/12
    ping(g, "alyssa-strifeborn", 0, 3);
    const a = g.state.players[0].lanes[0]!;
    expect(a.attack).toBe(5); // 2 + 3*1
    expect(a.health).toBe(15); // 12 + 3*1
    expect(a.damage).toBe(3);
  });

  it("gains +2 attack per damage at L2", () => {
    const g = gameWith("alyssa-strifeborn");
    addToHand(g, 0, "alyssa-strifeborn", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 4/16
    ping(g, "alyssa-strifeborn", 0, 4);
    const a = g.state.players[0].lanes[0]!;
    expect(a.attack).toBe(12); // 4 + 4*2
    expect(a.health).toBe(20); // 16 + 4*1
  });

  it("does not trigger when the damage is lethal", () => {
    const g = gameWith("alyssa-strifeborn");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    ping(g, "alyssa-strifeborn", 0, 12);
    expect(g.state.players[0].lanes[0]).toBeNull();
  });
});

describe("Blood Barrier (Armor N, doubled if a creature was destroyed this turn)", () => {
  it("grants Armor 2 with no deaths this turn", () => {
    const g = gameWith("blood-barrier");
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(keywordValue(c, "Armor")).toBe(2);
  });

  it("grants Armor 4 after a creature was destroyed this turn", () => {
    const g = gameWith("blood-barrier");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    destroyCreature(g, [], foe);
    runBatches(g, [], []); // death check -> deathLog
    expect(g.state.deathLog).toHaveLength(1);
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(keywordValue(c, "Armor")).toBe(4);
  });
});

describe("Darksteel Enforcer (Forge: +N attack per friendly Darkforged)", () => {
  it("buffs the chosen friendly creature by N times the Darkforged count (itself included)", () => {
    const g = gameWith("darksteel-enforcer");
    const smith = spawnCreature(g, [], 0, "shadowsmith", 1, { lane: 0 })!; // 3/6 Darkforged
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 4/6 Darkforged
    // the enforcer's entry fires the shadowsmith's recycle prompt first — decline it
    expect(g.state.pending!.request.kind).toBe("cardInHand");
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: smith.uid });
    expect(smith.attack).toBe(7); // 3 + 2*2 Darkforged
    expect(g.state.players[0].lanes[1]!.attack).toBe(4); // enforcer not buffed
  });

  it("does not count enemy or non-Darkforged creatures", () => {
    const g = gameWith("darksteel-enforcer");
    spawnCreature(g, [], 1, "shadowmist-angel", 1, { lane: 0 }); // enemy Darkforged
    spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 }); // friendly Robot, not Darkforged
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const mine = g.state.players[0].lanes[1]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.attack).toBe(6); // 4 + 2*1 (only itself)
  });
});

describe("Flowsteel Carrier (Vengeance: random friendly Robot gets Armor N)", () => {
  it("gives the only friendly Robot Armor 3 when destroyed", () => {
    const g = gameWith("flowsteel-carrier");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const robot = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 1 })!;
    const carrier = g.state.players[0].lanes[0]!;
    destroyCreature(g, [], carrier);
    runBatches(g, [], []);
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(keywordValue(robot, "Armor")).toBe(3);
  });

  it("does nothing with no friendly Robot in play", () => {
    const g = gameWith("flowsteel-carrier");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const human = spawnCreature(g, [], 0, "alyssa-strifeborn", 1, { lane: 1 })!;
    destroyCreature(g, [], g.state.players[0].lanes[0]!);
    runBatches(g, [], []);
    expect(keywordValue(human, "Armor")).toBe(0);
  });
});

describe("Forgewatch Sentry (Armor 6; destroyed when dealt damage)", () => {
  it("survives damage fully absorbed by Armor, dies to any damage that gets through", () => {
    const g = gameWith("forgewatch-sentry");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 6/6 Armor 6
    ping(g, "forgewatch-sentry", 0, 3); // fully absorbed -> no trigger
    expect(g.state.players[0].lanes[0]).not.toBeNull();
    ping(g, "forgewatch-sentry", 0, 8); // 2 gets through -> destroyed
    expect(g.state.players[0].lanes[0]).toBeNull();
  });
});

describe("H.E.R.M.E.S (end of your turn: others get Defender + Armor N until end of next turn)", () => {
  it("grants Defender + Armor 1 at your turn end; they expire at the enemy turn end", () => {
    const g = gameWith("hermes");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 1 })!;
    const hermes = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "endTurn" }); // p0's turn ends: grant
    expect(hasKeyword(c, "Defender")).toBe(true);
    expect(keywordValue(c, "Armor")).toBe(1);
    expect(hasKeyword(hermes, "Defender")).toBe(false); // itself excluded
    expect(keywordValue(hermes, "Armor")).toBe(0);
    // the grant survives the temp-keyword wipe and is live during the enemy turn
    applyAction(g, { type: "endTurn" }); // p1's turn ends: expire
    expect(hasKeyword(c, "Defender")).toBe(false);
    expect(keywordValue(c, "Armor")).toBe(0);
  });

  it("grants again on later turns (steady state: exactly one grant)", () => {
    const g = gameWith("hermes");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 1 })!;
    endRound(g);
    endRound(g); // two full rounds: grant, expire, grant, expire
    expect(keywordValue(c, "Armor")).toBe(0);
    applyAction(g, { type: "endTurn" }); // p0 turn end: grant again
    expect(keywordValue(c, "Armor")).toBe(1); // not stacked
  });
});

describe("Marty McGear (Activate: Spawn a copy of a random Robot from deck, +N/Armor N)", () => {
  it("spawns a level-1 Robot copy with +1 attack and Armor 1", () => {
    const g = gameWith("vault-intruder"); // 30 L1 Robots in the deck
    addToHand(g, 0, "marty-mcgear");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    endRound(g);
    const marty = g.state.players[0].lanes[0]!;
    const deckBefore = g.state.players[0].deck.length;
    applyAction(g, { type: "activate", uid: marty.uid });
    const bots = g.state.players[0].lanes.filter((c) => c?.defId === "vault-intruder");
    expect(bots).toHaveLength(1);
    expect(bots[0]!.attack).toBe(8); // 7 + 1
    expect(keywordValue(bots[0]!, "Armor")).toBe(1);
    expect(g.state.players[0].deck).toHaveLength(deckBefore); // a copy: deck untouched
  });

  it("cannot activate when the deck has no eligible Robot", () => {
    const g = gameWith("marty-mcgear"); // Gnomes, not Robots
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    const marty = g.state.players[0].lanes[0]!;
    expect(() => applyAction(g, { type: "activate", uid: marty.uid })).toThrow();
  });
});

describe("Mind Breaker (Forge: draw a card for each friendly Metamind)", () => {
  it("draws for itself plus each other friendly Metamind", () => {
    const g = gameWith("mind-breaker");
    spawnCreature(g, [], 0, "mind-breaker", 1, { lane: 0 }); // the other Metamind
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[0].hand).toHaveLength(6); // 4 left + 2 drawn
  });

  it("draws just one when it is the only Metamind", () => {
    const g = gameWith("mind-breaker");
    spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 }); // Robot, not a Metamind
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[0].hand).toHaveLength(5); // 4 left + 1 drawn
  });
});

describe("Pummel Pack (+N attack and Armor N, doubled when it is the only friendly creature)", () => {
  it("doubles up on a lone creature", () => {
    const g = gameWith("pummel-pack");
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!; // 7/5
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(c.attack).toBe(11); // 7 + 2 + 2
    expect(keywordValue(c, "Armor")).toBe(4); // 2 + 2
  });

  it("grants the base amount when another friendly creature is in play", () => {
    const g = gameWith("pummel-pack");
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!;
    spawnCreature(g, [], 0, "hermes", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(c.attack).toBe(9); // 7 + 2
    expect(keywordValue(c, "Armor")).toBe(2);
  });
});

describe("Shadowmist Angel (another friendly Darkforged enters: +N/+N)", () => {
  it("grows when another friendly Darkforged enters play", () => {
    const g = gameWith("shadowmist-angel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 6/3
    const angel = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => spawnCreature(g, [], 0, "darksteel-enforcer", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect(angel.attack).toBe(7);
    expect(angel.health).toBe(4);
  });

  it("ignores non-Darkforged and enemy entries", () => {
    const g = gameWith("shadowmist-angel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const angel = g.state.players[0].lanes[0]!;
    const a = collectInto(() => spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 1 })); // Robot
    runBatches(g, [], a);
    const b = collectInto(() => spawnCreature(g, [], 1, "darksteel-enforcer", 1, { lane: 0 })); // enemy
    runBatches(g, [], b);
    expect(angel.attack).toBe(6);
    expect(angel.health).toBe(3);
  });
});

describe("Shadowsmith (a friendly Darkforged enters: you may discard and level up)", () => {
  it("offers the recycle when it enters play itself", () => {
    const g = gameWith("shadowsmith");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(3); // 4 left - 1 discarded
    const discard = g.state.players[0].discard;
    expect(discard.filter((i) => i.defId === "shadowsmith" && i.level === 2)).toHaveLength(2);
    expect(discard.some((i) => i.defId === "shadowsmith" && i.level === 1)).toBe(true);
  });

  it("offers the recycle when another friendly Darkforged enters; declining does nothing", () => {
    const g = gameWith("shadowsmith");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false }); // decline self-entry
    expect(g.state.players[0].hand).toHaveLength(4);
    const initial = collectInto(() => spawnCreature(g, [], 0, "darksteel-enforcer", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect(g.state.pending!.request.kind).toBe("cardInHand");
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].hand).toHaveLength(4);
  });
});

describe("Vault Intruder (Forge: look at the enemy hand — no engine effect)", () => {
  it("enters play cleanly with no pending choice", () => {
    const g = gameWith("vault-intruder");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    const c = g.state.players[0].lanes[0]!;
    expect(c.attack).toBe(7);
    expect(c.health).toBe(5);
  });
});

describe("Patron of Anvillon (Forge with 3+ Alloyin cards in hand: creature gets 2x attack)", () => {
  it("doubles a level-1 creature's attack", () => {
    const g = gameWith("patron-of-anvillon");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7 level 1
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(8); // 4 doubled, permanent
  });

  it("does not trigger with fewer than 3 Alloyin cards in hand", () => {
    const g = gameWith("cavern-hydra"); // non-Alloyin hand
    addToHand(g, 0, "patron-of-anvillon");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.pending).toBeNull();
  });

  it("L1 cannot target a level-2 creature", () => {
    const g = gameWith("patron-of-anvillon");
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 0 }); // level 2
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toHaveLength(1); // only the patron itself is level 1
  });
});

describe("Sparky, Forge Guard Dog (Activate: destroy two Sparkies, Spawn the next one)", () => {
  it("L1: destroys itself and another Sparky, spawns a level 2 Sparky", () => {
    const g = gameWith("sparky-forge-guard-dog");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const other = spawnCreature(g, [], 0, "sparky-forge-guard-dog", 1, { lane: 1 })!;
    endRound(g);
    const sparky = g.state.players[0].lanes[0]!;
    const discardBefore = g.state.players[0].discard.length;
    applyAction(g, { type: "activate", uid: sparky.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([other.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: other.uid });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[1]).toBeNull();
    const grown = g.state.players[0].lanes.find((c) => c?.defId === "sparky-forge-guard-dog" && c.level === 2);
    expect(grown).toBeTruthy();
    expect(grown!.attack).toBe(10); // L2 10/11
    // the two destroyed L1 Sparkies hit the discard
    expect(g.state.players[0].discard.length).toBe(discardBefore + 2);
  });

  it("L3: destroys two level 3 Sparkies, spawns a 20/20 Forge Guardian Omega", () => {
    const g = gameWith("cavern-hydra");
    const a = spawnCreature(g, [], 0, "sparky-forge-guard-dog", 3, { lane: 0 })!;
    const b = spawnCreature(g, [], 0, "sparky-forge-guard-dog", 3, { lane: 1 })!;
    endRound(g);
    applyAction(g, { type: "activate", uid: a.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: b.uid });
    const omega = g.state.players[0].lanes.find((c) => c?.defId === "forge-guardian-omega");
    expect(omega).toBeTruthy();
    expect(omega!.attack).toBe(20);
    expect(omega!.health).toBe(20);
    expect(g.state.players[0].discard.filter((i) => i.defId === "sparky-forge-guard-dog" && i.level === 3)).toHaveLength(2);
  });

  it("L3 requires another LEVEL 3 Sparky", () => {
    const g = gameWith("cavern-hydra");
    const a = spawnCreature(g, [], 0, "sparky-forge-guard-dog", 3, { lane: 0 })!;
    spawnCreature(g, [], 0, "sparky-forge-guard-dog", 1, { lane: 1 }); // only level 1
    endRound(g);
    expect(() => applyAction(g, { type: "activate", uid: a.uid })).toThrow();
  });
});

describe("Wipe Clean (Overload: remove all abilities from each creature)", () => {
  it("strips keywords and silences triggers", () => {
    const g = gameWith("wipe-clean");
    const sentry = spawnCreature(g, [], 0, "forgewatch-sentry", 1, { lane: 0 })!; // Armor 6
    const alyssa = spawnCreature(g, [], 1, "alyssa-strifeborn", 1, { lane: 0 })!; // 2/12
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(sentry, "Armor")).toBe(0);
    expect(sentry.silenced).toBe(true);
    expect(alyssa.silenced).toBe(true);
    // Overload: the spell is removed from the game
    expect(g.state.players[0].removed.some((i) => i.defId === "wipe-clean")).toBe(true);
    // stripped + silenced: damage lands in full and no triggers fire
    ping(g, "forgewatch-sentry", 0, 3);
    expect(g.state.players[0].lanes[0]).not.toBeNull(); // no self-destruct trigger
    expect(sentry.damage).toBe(3);
    ping(g, "alyssa-strifeborn", 0, 3);
    expect(alyssa.attack).toBe(2); // no pain-growth
    expect(alyssa.health).toBe(12);
  });
});

describe("Nexus Bubble (player aura: friendly Alloyin creatures in the center space get Armor 3)", () => {
  it("grants Armor 3 on cast and tops up later entries at each turn start (see header for corners)", () => {
    const g = gameWith("nexus-bubble");
    const side = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!; // side space
    applyAction(g, { type: "playCard", handIndex: 0 }); // sweep: nothing qualifies yet
    expect(g.state.pending).toBeNull();
    expect(keywordValue(side, "Armor")).toBe(0);
    // mid-turn entry into the center waits for the next turn start
    const center = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 2 })!; // 7/5 Alloyin
    expect(keywordValue(center, "Armor")).toBe(0);
    applyAction(g, { type: "endTurn" }); // p1's turn start sweep
    expect(keywordValue(center, "Armor")).toBe(3);
    expect(keywordValue(side, "Armor")).toBe(0); // side space excluded
    applyAction(g, { type: "endTurn" }); // p0's turn start sweep — the census dedups
    expect(keywordValue(center, "Armor")).toBe(3); // still exactly one grant
    // enemy creatures are never swept (the aura belongs to p0)
    const foe = spawnCreature(g, [], 1, "vault-intruder", 1, { lane: 2 })!;
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(foe, "Armor")).toBe(0);
    // Overload: the spell is removed from the game
    expect(g.state.players[0].removed.some((i) => i.defId === "nexus-bubble")).toBe(true);
  });
});
