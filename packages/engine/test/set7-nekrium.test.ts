import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, destroyCreature, getCardScript,
  keywordValue, loadCards, runBatches, spawnCreature,
  type CreatureState, type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set7 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.json", import.meta.url), "utf8")) as ScrapedSet;
const set71 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set72 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set73 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.3.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra
const cards = loadCards(set7, set71, set72, set73, set1);

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

/** Play the last card of p0's hand (an addToHand'd card). */
function playLastAdded(g: Game, lane?: number): void {
  const handIndex = g.state.players[0].hand.length - 1;
  applyAction(g, { type: "playCard", handIndex, ...(lane !== undefined ? { lane } : {}) });
}

/** Destroy a creature outside of an action and resolve the resulting batch. */
function kill(g: Game, c: CreatureState): void {
  runBatches(g, [], collectInto(() => destroyCreature(g, [], c)));
}

/** Spawn outside of an action and resolve the resulting batch (enterPlay fires). */
function spawn(g: Game, p: PlayerId, defId: string, level: number, lane: number): CreatureState {
  let out!: CreatureState;
  runBatches(g, [], collectInto(() => { out = spawnCreature(g, [], p, defId, level, { lane })!; }));
  return out;
}

/** Answer the pending choice with a target. */
function chooseTarget(g: Game, targetUid: number): void {
  applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid });
}

function lanesOf(g: Game, p: PlayerId, defId: string): CreatureState[] {
  return g.state.players[p].lanes.filter((c): c is CreatureState => !!c && c.defId === defId);
}

const IDS = [
  "bride-of-frankenbaum", "crypt-wail", "disciple-of-vyric", "dread",
  "ebonskull-diabolist", "festering-slime", "indomitable-fiend", "necroplasm",
  "rite-of-undeath", "scourge-knights", "spectral-rider", "undying-legacy",
  "ceaseless-grimgaunt", "lichmane-dragon", "deaths-possession", "murderous-necromancer",
  "cercees-call", "cyrus-the-merciless",
];

describe("Set 7 Nekrium registration", () => {
  it("all 18 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Bride of Frankenbaum (friendly Abomination destroyed: you gain N health)", () => {
  it("gains 2 health when another friendly Abomination is destroyed", () => {
    const g = gameWith("bride-of-frankenbaum");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const bride2 = spawnCreature(g, [], 0, "bride-of-frankenbaum", 1, { lane: 1 })!; // Abomination
    g.state.players[0].health = 100;
    kill(g, bride2);
    expect(g.state.players[0].health).toBe(102);
  });

  it("does nothing when a non-Abomination friendly creature is destroyed", () => {
    const g = gameWith("bride-of-frankenbaum");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    g.state.players[0].health = 100;
    kill(g, hydra);
    expect(g.state.players[0].health).toBe(100);
  });
});

describe("Crypt Wail (drain the enemy player; doubled if 3+ enemy creatures battled)", () => {
  it("deals 5 and gains 5 with fewer than three enemy battlers", () => {
    const g = gameWith("crypt-wail");
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].health).toBe(115); // 120 - 5
    expect(g.state.players[0].health).toBe(105);
  });

  it("deals 10 and gains 10 when three enemy creatures initiated battle", () => {
    const g = gameWith("crypt-wail");
    for (let lane = 0; lane < 3; lane++) {
      spawnCreature(g, [], 1, "cavern-hydra", 1, { lane })!.hasBattled = true;
    }
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].health).toBe(110); // 120 - 10
    expect(g.state.players[0].health).toBe(110);
  });
});

describe("Disciple of Vyric (Formation: drain N from the enemy player)", () => {
  it("deals 4 and gains 4 in Formation", () => {
    const g = gameWith("disciple-of-vyric");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[1].health).toBe(116); // 120 - 4
    expect(g.state.players[0].health).toBe(104);
  });

  it("does nothing without Formation", () => {
    const g = gameWith("disciple-of-vyric");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // edge lane: never Formation
    expect(g.state.players[1].health).toBe(120);
    expect(g.state.players[0].health).toBe(100);
  });
});

describe("Dread (on entry: 50% chance to get 'Vengeance: Spawn a level N Dread')", () => {
  it("gets the granted Vengeance on some entries but not others", () => {
    let withAbility = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const g = createGame(cards, deckOf("dread"), deckOf("cavern-hydra"), seed);
      applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
      if (g.state.players[0].lanes[0]!.grantedAbilities.includes("nekrium:dread-vengeance-1")) withAbility++;
    }
    expect(withAbility).toBeGreaterThan(0);
    expect(withAbility).toBeLessThan(20);
  });

  it("with the ability, Vengeance Spawns a fresh level-1 Dread", () => {
    const g = gameWith("dread");
    const d = spawn(g, 0, "dread", 1, 0);
    d.grantedAbilities = ["nekrium:dread-vengeance-1"]; // force the roll outcome
    kill(g, d);
    const dreads = lanesOf(g, 0, "dread");
    expect(dreads).toHaveLength(1);
    expect(dreads[0]!.level).toBe(1);
    expect(dreads[0]!.uid).not.toBe(d.uid);
  });

  it("without the ability, no Dread comes back", () => {
    const g = gameWith("dread");
    const d = spawn(g, 0, "dread", 1, 0);
    d.grantedAbilities = []; // force the roll outcome
    kill(g, d);
    expect(lanesOf(g, 0, "dread")).toHaveLength(0);
  });
});

describe("Ebonskull Diabolist (Forge: extra play at the start of your next turn if in play)", () => {
  it("grants a third play on the next turn only", () => {
    const g = gameWith("ebonskull-diabolist");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    expect(g.state.active).toBe(0);
    expect(g.state.playsLeft).toBe(3); // 2 + 1
    endRound(g);
    expect(g.state.playsLeft).toBe(2); // one-shot: the granted ability removed itself
  });

  it("grants nothing if it leaves play before your next turn", () => {
    const g = gameWith("ebonskull-diabolist");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    kill(g, g.state.players[0].lanes[0]!);
    endRound(g);
    expect(g.state.playsLeft).toBe(2);
  });
});

describe("Festering Slime (battle damage to a creature: it gets -N/-N)", () => {
  it("debuffs the creature it battles", () => {
    const g = gameWith("festering-slime");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 1/6
    const slime = g.state.players[0].lanes[0]!;
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    endRound(g); // the slime sheds its defensive stance
    applyAction(g, { type: "battle" });
    expect(foe.attack).toBe(1); // 4 - 3
    expect(foe.health).toBe(4); // 7 - 3
    expect(foe.damage).toBe(1); // the slime's battle damage still landed
    expect(slime.damage).toBe(4); // the hydra hit back
  });
});

describe("Indomitable Fiend (un-Forged entry: +5/+5 per player rank)", () => {
  it("grows by rank when Spawned, not when Forged", () => {
    const g = gameWith("indomitable-fiend");
    const a = spawn(g, 0, "indomitable-fiend", 1, 0);
    expect(a.attack).toBe(7); // 2 + 5 * rank 1
    expect(a.health).toBe(7);
    g.state.players[0].rank = 3;
    const b = spawn(g, 0, "indomitable-fiend", 1, 1);
    expect(b.attack).toBe(17); // 2 + 5 * rank 3
    expect(b.health).toBe(17);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // Forged: no growth
    const forged = g.state.players[0].lanes[2]!;
    expect(forged.attack).toBe(2);
    expect(forged.health).toBe(2);
  });
});

describe("Necroplasm (Formation: the enemy player discards a card at random)", () => {
  it("makes the enemy discard a random card in Formation", () => {
    const g = gameWith("necroplasm");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[1].hand).toHaveLength(4);
    expect(g.state.players[1].discard.filter((i) => i.defId === "cavern-hydra" && i.level === 1)).toHaveLength(1);
  });

  it("does nothing without Formation", () => {
    const g = gameWith("necroplasm");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].hand).toHaveLength(5);
  });
});

describe("Rite of Undeath (each friendly creature gets Regenerate N)", () => {
  it("grants Regenerate 4 to every friendly creature", () => {
    const g = gameWith("rite-of-undeath");
    const a = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // inherent Regenerate 1
    const b = spawnCreature(g, [], 0, "gsf-commando", 1, { lane: 1 })!; // no Regenerate
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(a, "Regenerate")).toBe(5); // 1 inherent + 4
    expect(keywordValue(b, "Regenerate")).toBe(4);
  });
});

describe("Scourge Knights (Formation: give an enemy creature -N/-N)", () => {
  it("offers the enemy-creature debuff in Formation", () => {
    const g = gameWith("scourge-knights");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.pending!.request.kind).toBe("enemyCreature");
    chooseTarget(g, foe.uid);
    expect(foe.attack).toBe(2); // 4 - 2
    expect(foe.health).toBe(5); // 7 - 2
  });

  it("no prompt without Formation", () => {
    const g = gameWith("scourge-knights");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Spectral Rider (friendly creature destroyed: +1/+1)", () => {
  it("grows off friendly deaths but not enemy deaths", () => {
    const g = gameWith("spectral-rider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 6/5
    const rider = g.state.players[0].lanes[0]!;
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!;
    kill(g, foe);
    expect(rider.attack).toBe(6); // enemy deaths don't count
    kill(g, ally);
    expect(rider.attack).toBe(7);
    expect(rider.health).toBe(6);
  });
});

describe("Undying Legacy (Overload; friendly creature gets 'Vengeance: Spawn a copy of this')", () => {
  it("grants the Vengeance; a copy Spawns when the creature is destroyed; the spell is removed", () => {
    const g = gameWith("undying-legacy");
    const c = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("friendlyCreature");
    chooseTarget(g, c.uid);
    expect(c.grantedAbilities).toContain("nekrium:undying-legacy");
    expect(g.state.players[0].removed.some((i) => i.defId === "undying-legacy")).toBe(true); // Overload
    kill(g, c);
    const copies = lanesOf(g, 0, "cavern-hydra");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.level).toBe(1);
    expect(copies[0]!.uid).not.toBe(c.uid);
  });
});

describe("Ceaseless Grimgaunt (Vengeance: if alone, Spawn a copy)", () => {
  it("Spawns a copy of itself when it dies as the only friendly creature", () => {
    const g = gameWith("ceaseless-grimgaunt");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const first = g.state.players[0].lanes[2]!;
    kill(g, first);
    const copies = lanesOf(g, 0, "ceaseless-grimgaunt");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.level).toBe(1);
    expect(copies[0]!.uid).not.toBe(first.uid);
  });

  it("does not respawn while another friendly creature is in play", () => {
    const g = gameWith("ceaseless-grimgaunt");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    kill(g, g.state.players[0].lanes[2]!);
    expect(lanesOf(g, 0, "ceaseless-grimgaunt")).toHaveLength(0);
    expect(g.state.players[0].lanes[0]?.defId).toBe("cavern-hydra");
  });
});

describe("Lichmane Dragon (Mobility 1; Formation: Spawn an enemy creature destroyed this game)", () => {
  it("raises a destroyed enemy creature onto your side in Formation", () => {
    const g = gameWith("lichmane-dragon");
    kill(g, spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!); // enemy discard: hydra L1
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const dragon = g.state.players[0].lanes[1]!;
    expect(keywordValue(dragon, "Mobility")).toBe(1); // inherent
    expect(lanesOf(g, 0, "cavern-hydra")).toHaveLength(3); // 2 setup + 1 raised copy
  });

  it("does nothing without Formation", () => {
    const g = gameWith("lichmane-dragon");
    kill(g, spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // edge lane
    expect(lanesOf(g, 0, "cavern-hydra")).toHaveLength(0);
  });
});

describe("Death's Possession (destroy an enemy creature with cap or less attack; Alloyin: Spawn a copy)", () => {
  it("destroys an Alloyin creature and Spawns a copy of it", () => {
    const g = gameWith("deaths-possession");
    const foe = spawnCreature(g, [], 1, "gsf-commando", 1, { lane: 0 })!; // Alloyin, 3 attack
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toContain(foe.uid);
    chooseTarget(g, foe.uid);
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].discard.some((i) => i.defId === "gsf-commando")).toBe(true);
    expect(lanesOf(g, 0, "gsf-commando")).toHaveLength(1); // the copy
  });

  it("destroys a non-Alloyin creature without Spawning", () => {
    const g = gameWith("deaths-possession");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // Uterra, 4 attack
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes.every((c) => !c)).toBe(true);
  });

  it("cannot target a creature above the cap", () => {
    const g = gameWith("deaths-possession");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    buffCreature(g, [], foe, 5, 0); // 9 attack > 4
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no legal target: the prompt fizzles
    expect(g.state.players[1].lanes[0]?.uid).toBe(foe.uid);
  });
});

describe("Murderous Necromancer (turn start: Spawn a random destroyed creature; L3 kills its opposer)", () => {
  it("L1: raises a level-1 creature destroyed this game at your turn start", () => {
    const g = gameWith("murderous-necromancer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    kill(g, spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!);
    // keep the raise pool clean: the played copy's level-up + the end-of-turn hand dump
    g.state.players[0].hand = [];
    g.state.players[0].discard = [];
    endRound(g);
    expect(lanesOf(g, 0, "cavern-hydra").length).toBeGreaterThanOrEqual(1);
  });

  it("L3: the raised creature destroys the creature opposing it", () => {
    const g = gameWith("murderous-necromancer");
    addToHand(g, 0, "murderous-necromancer", 3);
    playLastAdded(g, 0); // L3 necromancer at lane 0
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }); // fill my board except lane 2
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 4 });
    kill(g, spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!); // raise pool
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // the opposer-to-be
    g.state.players[0].hand = [];
    g.state.players[0].discard = [];
    endRound(g);
    expect(g.state.players[0].lanes[2]?.defId).toBe("cavern-hydra"); // only open space
    expect(g.state.players[1].lanes[2]).toBeNull(); // the opposer was destroyed
  });
});

describe("Cercee's Call (Spawn a copy of a friendly Zombie destroyed this turn; L2 Free)", () => {
  it("raises a friendly Zombie destroyed this turn", () => {
    const g = gameWith("cercees-call");
    addToHand(g, 0, "scourge-knights"); // a Zombie
    playLastAdded(g, 0);
    const knight = g.state.players[0].lanes[0]!;
    kill(g, knight); // destroyed this turn
    applyAction(g, { type: "playCard", handIndex: 0 }); // a Call from the starting hand
    const copies = lanesOf(g, 0, "scourge-knights");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.level).toBe(1);
    expect(copies[0]!.uid).not.toBe(knight.uid);
  });

  it("fizzles when no friendly Zombie was destroyed this turn", () => {
    const g = gameWith("cercees-call");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.every((c) => !c)).toBe(true);
  });

  it("L2 is Free", () => {
    const g = gameWith("cercees-call");
    addToHand(g, 0, "cercees-call", 2);
    playLastAdded(g);
    expect(g.state.playsLeft).toBe(2);
  });
});

describe("Cyrus, the Merciless (Formation: destroy each other creature at/below cap; grows off any death)", () => {
  it("culls both sides in Formation and grows off the kills", () => {
    const g = gameWith("cyrus-the-merciless");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // 4 attack: culled
    const big = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!;
    buffCreature(g, [], big, 5, 0); // 9 attack: survives
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4 attack: culled
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 3/4
    const cyrus = g.state.players[0].lanes[1]!;
    expect(cyrus.defId).toBe("cyrus-the-merciless"); // "each OTHER creature": itself survives
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[0].lanes[2]?.uid).toBe(big.uid);
    expect(cyrus.attack).toBe(5); // 3 + 2 kills
    expect(cyrus.health).toBe(6); // 4 + 2
  });

  it("grows whenever any creature is destroyed, even without Formation", () => {
    const g = gameWith("cyrus-the-merciless");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const cyrus = g.state.players[0].lanes[0]!;
    kill(g, spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!);
    expect(cyrus.attack).toBe(4);
    expect(cyrus.health).toBe(5);
  });
});
