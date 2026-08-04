import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getStats, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

/** Deal damage to a creature outside of combat, resolving its trigger batch. */
function ping(g: Game, uid: number, amount: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => dealCreatureDamage(g, [], c, amount));
  runBatches(g, [], initial);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

describe("Blight Walker (battle damage to a level-1 creature destroys it)", () => {
  it("destroys the level 1 creature it battles even when it would survive", () => {
    const g = gameWith("blight-walker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // walker 1/5
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]).toBeNull(); // destroyed with 6 health left
    expect(g.state.players[0].lanes[0]!.damage).toBe(4); // walker survives
  });
});

describe("Bonescythe Reaver (Forge: optional destroy of a low-level enemy)", () => {
  it("L2 destroys the chosen level 1 enemy creature when accepted", () => {
    const g = gameWith("bonescythe-reaver");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const hydra = g.state.players[1].lanes[3]!;
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[3]).toBeNull();
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([8, 7]);
  });
});

describe("Corpse Crawler (Forge: destroy a friendly creature)", () => {
  it("must destroy a friendly creature, and may target itself", () => {
    const g = gameWith("corpse-crawler");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const crawler = g.state.players[0].lanes[0]!;
    const fiend = g.state.players[0].lanes[1]!;
    const req = g.state.pending!.request;
    expect(req.options).toEqual([crawler.uid, fiend.uid]); // self is a legal target
    applyChoice(g, { id: req.id, accepted: true, targetUid: fiend.uid });
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[0]!.defId).toBe("corpse-crawler");
  });
});

describe("Darkheart Wanderer (spellPlayed: gains Regenerate)", () => {
  it("gets Regenerate 1 each time you play a spell", () => {
    const g = gameWith("nether-embrace");
    spawnCreature(g, [], 0, "darkheart-wanderer", 1, { lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // untargeted trigger
    expect(keywordValue(c, "Regenerate")).toBe(1);
    applyAction(g, { type: "playCard", handIndex: 0 }); // second spell stacks
    expect(keywordValue(c, "Regenerate")).toBe(2);
  });
});

describe("Darkshaper Savant (cardPlayed: level-gated Nekrium debuff)", () => {
  it("L2 offers -3/-3 to an enemy creature when you play a level 1 Nekrium card", () => {
    const g = gameWith("nether-embrace");
    spawnCreature(g, [], 0, "darkshaper-savant", 2, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 }); // nether-embrace L1 (Nekrium)
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([1, 4]); // 4/7 -> 1/4
  });
});

describe("Doomwing, Dire Drake (Flank: destroy the opposing level-1 creature)", () => {
  it("destroys the opposing creature after moving into its lane", () => {
    const g = gameWith("doomwing-dire-drake");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // doomwing 6/2 Mobility 1
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 hydra in lane 1
    applyAction(g, { type: "endTurn" });
    const drake = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "move", uid: drake.uid, lane: 1 });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[1]!.defId).toBe("doomwing-dire-drake");
  });
});

describe("Dr. Frankenbaum (friendly Abomination destroyed -> 2 to the enemy player)", () => {
  it("pings for Abominations only", () => {
    const g = gameWith("dr-frankenbaum");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "fleshfiend", 1, { lane: 1 }); // Abomination
    spawnCreature(g, [], 0, "zombie-infantry", 1, { lane: 2 }); // Zombie
    destroyCreature(g, [], g.state.players[0].lanes[1]!);
    destroyCreature(g, [], g.state.players[0].lanes[2]!);
    runBatches(g, [], []);
    expect(g.state.players[1].health).toBe(118);
  });
});

describe("Fell Walker (Vengeance: 3/3 Zombie into this space)", () => {
  it("puts a 3/3 Zombie into its lane when destroyed", () => {
    const g = gameWith("fell-walker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    destroyCreature(g, [], g.state.players[0].lanes[1]!);
    runBatches(g, [], []);
    const t = g.state.players[0].lanes[1]!;
    expect([t.defId, t.attack, t.health, t.lane]).toEqual(["zombie", 3, 3, 1]);
  });
});

describe("Fleshfiend (Vengeance: put a level 1 Fleshfiend into this space)", () => {
  it("L2 respawns as a level 1 copy", () => {
    const g = gameWith("fleshfiend");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const c = g.state.players[0].lanes[2]!;
    c.level = 2; c.attack = 8; c.health = 8; // stand-in for the leveled copy
    destroyCreature(g, [], c);
    runBatches(g, [], []);
    const t = g.state.players[0].lanes[2]!;
    expect([t.defId, t.level, t.attack, t.health]).toEqual(["fleshfiend", 1, 6, 6]);
  });
});

describe("Gloomreaper Witch (Forge: optional destroy of an enemy with <= 1 attack)", () => {
  it("offers only low-attack enemies and destroys the chosen one", () => {
    const g = gameWith("gloomreaper-witch");
    spawnCreature(g, [], 1, "soul-drinker", 1, { lane: 2 }); // 1 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 }); // 4 attack
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const drinker = g.state.players[1].lanes[2]!;
    const req = g.state.pending!.request;
    expect(req.options).toEqual([drinker.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: drinker.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
  });
});

describe("Graveborn Glutton (Vengeance: 1..4 damage to the enemy player)", () => {
  it("deals damage in range when destroyed", () => {
    const g = gameWith("graveborn-glutton");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    destroyCreature(g, [], g.state.players[0].lanes[0]!);
    runBatches(g, [], []);
    expect(g.state.players[1].health).toBeGreaterThanOrEqual(116);
    expect(g.state.players[1].health).toBeLessThan(120);
  });
});

describe("Grimgaunt Predator (opposing creature destroyed -> +2/+2)", () => {
  it("grows when the creature opposite it dies", () => {
    const g = gameWith("grimgaunt-predator");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    destroyCreature(g, [], g.state.players[1].lanes[0]!);
    runBatches(g, [], []);
    const c = g.state.players[0].lanes[0]!;
    expect([c.attack, c.health]).toEqual([7, 7]);
  });
});

describe("Hellforged Avatar (Forge: +1/+1 per Nekrium card in hand)", () => {
  it("gets +4/+4 with four Nekrium cards left in hand", () => {
    const g = gameWith("hellforged-avatar");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    expect([c.attack, c.health]).toEqual([7, 7]); // 3/3 + 4x +1/+1
  });
});

describe("Keeper of the Damned (Activate: grant 'Vengeance: Spawn this' this turn)", () => {
  it("the granted creature respawns a copy of itself when destroyed", () => {
    const g = gameWith("keeper-of-the-damned");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    passTurns(g, 2);
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.grantedAbilities).toEqual(["shared:vengeance-spawn-self", "nekrium:keeper-expire"]);
    destroyCreature(g, [], hydra);
    runBatches(g, [], []);
    const back = g.state.players[0].lanes[1]!;
    expect([back.defId, back.level, back.attack, back.health]).toEqual(["cavern-hydra", 1, 4, 7]);
  });
  it("the grant expires at end of turn", () => {
    const g = gameWith("keeper-of-the-damned");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    passTurns(g, 2);
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    applyAction(g, { type: "endTurn" });
    expect(hydra.grantedAbilities).toEqual([]);
  });
});

describe("Lyria, Muse of Varna (Forge: raise creatures that died this game)", () => {
  it("L2 spawns one random destroyed creature", () => {
    const g = gameWith("lyria-muse-of-varna");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    destroyCreature(g, [], g.state.players[0].lanes[0]!);
    runBatches(g, [], []);
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter(Boolean).length).toBe(2);
    const raised = lanes.find((c) => c && c.defId !== "lyria-muse-of-varna")!;
    // pool = the dead hydra + the leveled Lyria copy that hit the discard
    expect(["cavern-hydra", "lyria-muse-of-varna"]).toContain(raised.defId);
  });
  it("L3 fills every open space with a random destroyed creature", () => {
    const g = gameWith("lyria-muse-of-varna");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    destroyCreature(g, [], g.state.players[0].lanes[0]!);
    runBatches(g, [], []);
    g.state.players[0].hand[0]!.level = 3; // no level-up copy: pool is just the hydra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const lanes = g.state.players[0].lanes;
    expect(lanes.filter(Boolean).length).toBe(5);
    expect(lanes.filter((c) => c!.defId === "cavern-hydra").length).toBe(4);
    expect(lanes.filter((c) => c!.defId === "cavern-hydra").every((c) => c!.attack === 4 && c!.health === 7)).toBe(true);
  });
});

describe("Necroslime (Activate: 3 damage to another friendly creature, +2/+2)", () => {
  it("damages the chosen friendly creature and grows", () => {
    const g = gameWith("necroslime");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/4
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    passTurns(g, 2);
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(3);
    const slime = g.state.players[0].lanes[0]!;
    expect([slime.attack, slime.health]).toEqual([6, 6]);
  });
});

describe("Scourgeflame Sorcerer (Activate with a sacrifice cost)", () => {
  it("L1 prompts for the friendly sacrifice, then the enemy target", () => {
    const g = gameWith("scourgeflame-sorcerer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/5
    spawnCreature(g, [], 0, "zombie-infantry", 1, { lane: 1 }); // 6 attack
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 2 }); // 8 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    passTurns(g, 2);
    const zombie = g.state.players[0].lanes[1]!;
    const fiend = g.state.players[0].lanes[2]!;
    const hydra = g.state.players[1].lanes[3]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([zombie.uid, fiend.uid]); // self excluded
    applyChoice(g, { id: req1.id, accepted: true, targetUid: fiend.uid }); // real choice: the stronger one
    const req2 = g.state.pending!.request; // chained second prompt
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[3]).toBeNull(); // enemy destroyed
    expect(g.state.players[0].lanes[2]).toBeNull(); // the chosen fiend was sacrificed
    expect(g.state.players[0].lanes[1]!.defId).toBe("zombie-infantry"); // the weaker one survives
    expect(g.state.players[0].lanes[0]!.defId).toBe("scourgeflame-sorcerer");
  });
  it("L3 destroys an enemy creature with no sacrifice", () => {
    const g = gameWith("scourgeflame-sorcerer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const c = g.state.players[0].lanes[0]!;
    c.level = 3; c.attack = 8; c.health = 14; // stand-in for the leveled copy
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    passTurns(g, 2);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "activate", uid: c.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[0]).not.toBeNull();
  });
});

describe("Soul Drinker (Forge: drain the opposing creature's attack)", () => {
  it("L2 reduces the opposing creature to 0 attack and takes its attack", () => {
    const g = gameWith("soul-drinker");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    const drinker = g.state.players[0].lanes[0]!;
    expect([hydra.attack, drinker.attack, drinker.health]).toEqual([0, 5, 8]); // 1 + 4
  });
});

describe("Vengeful Spirit (Vengeance: opposing creature gets -3/-3)", () => {
  it("drains the creature opposite its death space", () => {
    const g = gameWith("vengeful-spirit");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    destroyCreature(g, [], g.state.players[0].lanes[0]!);
    runBatches(g, [], []);
    const hydra = g.state.players[1].lanes[0]!;
    expect([hydra.attack, hydra.health]).toEqual([1, 4]);
  });
});

describe("Witherfrost Succubus (Activate: -3/-3 this turn)", () => {
  it("the debuff wears off at end of turn", () => {
    const g = gameWith("witherfrost-succubus");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    passTurns(g, 2);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(getStats(g, hydra)).toEqual({ attack: 1, health: 4 });
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, hydra)).toEqual({ attack: 4, health: 7 });
  });
});

describe("Xithian Shambler (Activate: eat an adjacent creature, move and grow)", () => {
  it("destroys the adjacent creature, takes its space and its stats", () => {
    const g = gameWith("xithian-shambler");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 3/4
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }); // 4/7
    passTurns(g, 2);
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[2]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    const shambler = g.state.players[0].lanes[1]!;
    expect([shambler.defId, shambler.attack, shambler.health]).toEqual(["xithian-shambler", 7, 11]);
    expect(g.state.players[0].lanes[2]).toBeNull(); // hydra died in the shambler's old space
    expect(g.state.players[0].discard.some((c) => c.defId === "cavern-hydra")).toBe(true);
  });
});

describe("Xrath, Dreadknight of Varna (other friendly Zombies get Regenerate 2)", () => {
  it("grants turn-start healing to the other friendly Zombies", () => {
    const g = gameWith("xrath-dreadknight-of-varna");
    spawnCreature(g, [], 0, "zombie-infantry", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // aura-enter grants to the zombie
    const zombie = g.state.players[0].lanes[1]!;
    expect(zombie.grantedAbilities).toEqual(["nekrium:xrath-regen-2"]);
    ping(g, zombie.uid, 3);
    passTurns(g, 2);
    expect(zombie.damage).toBe(1); // healed 2 at its controller's turn start
  });
  it("grants the heal to a Zombie played after it", () => {
    const g = gameWith("xrath-dreadknight-of-varna");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // second Xrath is itself a Zombie
    const second = g.state.players[0].lanes[1]!;
    expect(second.grantedAbilities).toEqual(["nekrium:xrath-regen-2"]);
  });
  it("removes the granted heal when Xrath is destroyed", () => {
    const g = gameWith("xrath-dreadknight-of-varna");
    spawnCreature(g, [], 0, "zombie-infantry", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const xrath = g.state.players[0].lanes[0]!;
    const zombie = g.state.players[0].lanes[1]!;
    destroyCreature(g, [], xrath);
    runBatches(g, [], []);
    expect(zombie.grantedAbilities).toEqual([]);
  });
});

describe("Zimus, the Undying (Vengeance: spawn Zimus, the Returned)", () => {
  it("L2 puts a 10/5 Zimus, the Returned into its space", () => {
    const g = gameWith("zimus-the-undying");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const c = g.state.players[0].lanes[1]!;
    c.level = 2; c.attack = 10; c.health = 5; // stand-in for the leveled copy
    destroyCreature(g, [], c);
    runBatches(g, [], []);
    const t = g.state.players[0].lanes[1]!;
    expect([t.defId, t.level, t.attack, t.health]).toEqual(["zimus-the-returned", 2, 10, 5]);
  });
});

describe("Contagion Surge (Free at L2)", () => {
  it("L2 costs no play and gives -2/-2", () => {
    const g = gameWith("contagion-surge");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.playsLeft).toBe(2);
    expect([hydra.attack, hydra.health]).toEqual([2, 5]);
  });
});

describe("Cull the Weak (destroy a creature with <= 4 attack)", () => {
  it("offers only creatures with 4 or less attack", () => {
    const g = gameWith("cull-the-weak");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack
    spawnCreature(g, [], 1, "marrow-fiend", 1, { lane: 1 }); // 8 attack
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[1]).not.toBeNull();
  });
});

describe("Dreadbolt (destroy a level 1 creature)", () => {
  it("cannot target a level 2 creature", () => {
    const g = gameWith("dreadbolt");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "marrow-fiend", 1, { lane: 1 });
    g.state.players[1].lanes[1]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    const req = g.state.pending!.request;
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
  });
});

describe("Epidemic (each enemy creature gets -2/-2)", () => {
  it("debuffs every enemy creature without a prompt", () => {
    const g = gameWith("epidemic");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 }); // friendly: unaffected
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "zombie-infantry", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect([g.state.players[1].lanes[0]!.attack, g.state.players[1].lanes[0]!.health]).toEqual([2, 5]);
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([4, 3]);
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([8, 1]);
  });
});

describe("Explosive Demise (destroy a friendly creature, burn the enemy player)", () => {
  it("L3 also gains that much health", () => {
    const g = gameWith("explosive-demise");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    g.state.players[0].hand[0]!.level = 3;
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[1].health).toBe(116); // 120 - 4
    expect(g.state.players[0].health).toBe(104);
  });
});

describe("Ghastly Touch (give a creature -3/-3)", () => {
  it("shrinks the target", () => {
    const g = gameWith("ghastly-touch");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([1, 4]);
  });
});

describe("Grave Pact (two-step: sacrifice a friendly creature, destroy an enemy)", () => {
  it("prompts for the friendly sacrifice, then the enemy target", () => {
    const g = gameWith("grave-pact");
    spawnCreature(g, [], 0, "zombie-infantry", 1, { lane: 0 }); // 6 attack
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 1 }); // 8 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fiend = g.state.players[0].lanes[1]!;
    const hydra = g.state.players[1].lanes[2]!;
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([g.state.players[0].lanes[0]!.uid, fiend.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: fiend.uid }); // real choice: the stronger one
    const req2 = g.state.pending!.request; // chained second prompt
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[0].lanes[1]).toBeNull(); // the chosen fiend was sacrificed
    expect(g.state.players[0].lanes[0]!.defId).toBe("zombie-infantry"); // the weaker one survives
  });
});

describe("Hungering Strike (two-step: friendly +3 attack, enemy -3 attack)", () => {
  it("prompts for the friendly buff, then the enemy debuff", () => {
    const g = gameWith("hungering-strike");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 }); // 8/1
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack
    spawnCreature(g, [], 1, "zombie-infantry", 1, { lane: 1 }); // 6 attack
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fiend = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[0]!;
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([fiend.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: fiend.uid });
    expect([fiend.attack, fiend.health]).toEqual([11, 1]); // step 1 applies immediately
    const req2 = g.state.pending!.request; // chained second prompt
    expect(req2.kind).toBe("enemyCreature");
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid }); // real choice: the weaker one
    expect([hydra.attack, hydra.health]).toEqual([1, 7]);
    expect([g.state.players[1].lanes[1]!.attack, g.state.players[1].lanes[1]!.health]).toEqual([6, 5]); // strongest untouched
  });
});

describe("Necrovive (give a creature Regenerate 3)", () => {
  it("grants Regenerate to the chosen creature", () => {
    const g = gameWith("necrovive");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 }); // no inherent Regenerate
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fiend = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: fiend.uid });
    expect(keywordValue(fiend, "Regenerate")).toBe(3);
  });
});

describe("Nether Embrace (deal 4 to the enemy player, gain 4)", () => {
  it("drains the opponent", () => {
    const g = gameWith("nether-embrace");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].health).toBe(116);
    expect(g.state.players[0].health).toBe(104);
  });
});

describe("Rite of the Grimgaunt (grant 'when a creature is destroyed, +1/+1')", () => {
  it("the enchanted creature grows when another creature dies", () => {
    const g = gameWith("rite-of-the-grimgaunt");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fiend = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: fiend.uid });
    expect(fiend.grantedAbilities).toEqual(["nekrium:rite-1"]);
    destroyCreature(g, [], g.state.players[1].lanes[2]!);
    runBatches(g, [], []);
    expect([fiend.attack, fiend.health]).toEqual([9, 2]);
  });
});

describe("Soul Harvest (destroy a friendly creature for an extra play)", () => {
  it("refunds the play it cost", () => {
    const g = gameWith("soul-harvest");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fiend = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: fiend.uid });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.playsLeft).toBe(2); // 2 - 1 (spell) + 1 (harvest)
  });
});

describe("Touch of Blight (grant 'battle damage to a level-1 creature destroys it')", () => {
  it("the granted ability destroys a level 1 creature in battle", () => {
    // vs a 0-attack wall so the 1-health fiend survives the battle
    const g = gameWith("touch-of-blight", "heart-tree");
    spawnCreature(g, [], 0, "marrow-fiend", 1, { lane: 0 }); // 8/1
    applyAction(g, { type: "playCard", handIndex: 0 }); // touch of blight
    const fiend = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: fiend.uid });
    expect(fiend.grantedAbilities).toEqual(["nekrium:blight-1"]);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 heart tree 0/10
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // fiend deals 8 (tree has 2 left), blight finishes it
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[0]).not.toBeNull();
  });
});
