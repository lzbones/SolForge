import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, dealCreatureDamage,
  dealPlayerDamage, destroyCreature, getCardScript, hasKeyword, healCreature, keywordValue,
  legalActions, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set6 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.json", import.meta.url), "utf8")) as ScrapedSet;
const set61 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set62 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra + doomwing-dire-drake + grimgaunt-spectre + lightning-wyrm + ashurian-mystic
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

const IDS = [
  "blood-boon", "darkroot-shambler", "dragon-slayer", "dream-tree", "dusk-hammer",
  "grapplevine", "mosstodon", "othra-apex-predator", "shroudthorn-splicer",
  "tremorsaur", "verdant-sphere", "vigorwisp", "enduring-vitality",
  "patron-of-deepwood", "rubyscale-dragon", "shardplate-graft",
];

describe("Set 6 Uterra registration", () => {
  it("all 16 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });

  it("the Darkforged Mimic token has data (2/3, 6/7, 10/11)", () => {
    const def = cards["darkforged-mimic"];
    expect(def).toBeTruthy();
    expect(def.levels.map((l) => [l.attack, l.health])).toEqual([[2, 3], [6, 7], [10, 11]]);
  });
});

describe("Blood Boon (+N/+N, doubled if a creature was destroyed this turn)", () => {
  it("gives +3/+3 with no deaths this turn", () => {
    const g = gameWith("blood-boon");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(7);
    expect(foe.health).toBe(10);
  });

  it("gives +6/+6 after a creature was destroyed this turn", () => {
    const g = gameWith("blood-boon");
    const doomed = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    destroyCreature(g, [], doomed);
    runBatches(g, [], []); // death check -> deathLog
    expect(g.state.deathLog).toHaveLength(1);
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(10); // 4 + 6
    expect(foe.health).toBe(13); // 7 + 6
  });
});

describe("Darkroot Shambler (Forge: friendly creature gets +N health per friendly Darkforged)", () => {
  it("counts friendly Darkforged including itself, not enemy ones", () => {
    const g = gameWith("darkroot-shambler");
    const m1 = spawnCreature(g, [], 0, "darkforged-mimic", 1, { lane: 0 })!; // 2/3
    spawnCreature(g, [], 0, "darkforged-mimic", 1, { lane: 1 }); // 2/3
    spawnCreature(g, [], 1, "darkforged-mimic", 1, { lane: 0 }); // enemy: not counted
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/2
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: m1.uid });
    expect(m1.health).toBe(9); // 3 + 2*3 friendly Darkforged (m1, m2, the shambler)
    expect(m1.attack).toBe(2); // health only
  });
});

describe("Dragon Slayer (Forge: destroy an enemy level-capped Dragon)", () => {
  it("destroys an enemy level 1 Dragon", () => {
    const g = gameWith("dragon-slayer");
    const drake = spawnCreature(g, [], 1, "doomwing-dire-drake", 1, { lane: 2 })!; // 6/2 Dragon
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([drake.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: drake.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.deathLog.some((d) => d.defId === "doomwing-dire-drake")).toBe(true);
  });

  it("L1 cannot target a level 2 Dragon or a non-Dragon", () => {
    const g = gameWith("dragon-slayer");
    spawnCreature(g, [], 1, "doomwing-dire-drake", 2, { lane: 2 }); // level 2 Dragon
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 }); // level 1, not a Dragon
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull(); // no legal target: no prompt
    expect(g.state.players[1].lanes[2]).not.toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
  });
});

describe("Dream Tree (damaged and survives on your turn: play an additional card)", () => {
  it("grants an extra play when it survives damage on your turn", () => {
    const g = gameWith("cavern-hydra");
    const tree = spawnCreature(g, [], 0, "dream-tree", 1, { lane: 0 })!; // 0/7
    expect(g.state.playsLeft).toBe(2);
    const initial = collectInto(() => dealCreatureDamage(g, [], tree, 3));
    runBatches(g, [], initial);
    expect(tree.damage).toBe(3);
    expect(g.state.playsLeft).toBe(3);
  });

  it("does not trigger from lethal damage or on the opponent's turn", () => {
    const g = gameWith("cavern-hydra");
    const tree = spawnCreature(g, [], 0, "dream-tree", 1, { lane: 0 })!;
    // opponent's turn: no trigger (playsLeft is the active player's)
    applyAction(g, { type: "endTurn" });
    const a = collectInto(() => dealCreatureDamage(g, [], tree, 3));
    runBatches(g, [], a);
    expect(g.state.playsLeft).toBe(2);
    expect(g.state.players[0].lanes[0]).not.toBeNull();
    // back on your turn: lethal damage does not trigger either
    applyAction(g, { type: "endTurn" });
    const b = collectInto(() => dealCreatureDamage(g, [], tree, 4)); // 3 + 4 = 7 total: lethal
    runBatches(g, [], b);
    expect(g.state.playsLeft).toBe(2);
    expect(g.state.players[0].lanes[0]).toBeNull();
  });
});

describe("Dusk Hammer (another friendly Darkforged enters: +N/+N)", () => {
  it("grows from other friendly Darkforged entries only", () => {
    const g = gameWith("dusk-hammer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 5/4
    const hammer = g.state.players[0].lanes[0]!;
    const a = collectInto(() => spawnCreature(g, [], 0, "darkforged-mimic", 1, { lane: 1 }));
    runBatches(g, [], a);
    expect(hammer.attack).toBe(6); // 5 + 1
    expect(hammer.health).toBe(5); // 4 + 1
    const b = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })); // not Darkforged
    runBatches(g, [], b);
    const c = collectInto(() => spawnCreature(g, [], 1, "darkforged-mimic", 1, { lane: 0 })); // enemy
    runBatches(g, [], c);
    expect(hammer.attack).toBe(6);
    expect(hammer.health).toBe(5);
  });
});

describe("Grapplevine (continuous: Negate Mobility from each creature)", () => {
  it("blocks enemy movement while in play; movement returns when it leaves", () => {
    const g = gameWith("grapplevine");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 3/9
    const vine = g.state.players[0].lanes[1]!;
    const spectre = spawnCreature(g, [], 1, "grimgaunt-spectre", 1, { lane: 2 })!; // 3/3 Mobility 1
    applyAction(g, { type: "endTurn" }); // p1's turn: the spectre is offensive
    legalActions(g); // staticKeywords are refreshed on the legalActions path
    expect(keywordValue(spectre, "Mobility")).toBeLessThanOrEqual(0); // 1 - 100
    expect(() => applyAction(g, { type: "move", uid: spectre.uid, lane: 1 })).toThrow();
    destroyCreature(g, [], vine);
    runBatches(g, [], []);
    legalActions(g); // refresh again so the move legality check sees the vine gone
    expect(keywordValue(spectre, "Mobility")).toBe(1);
    applyAction(g, { type: "move", uid: spectre.uid, lane: 1 });
    expect(spectre.lane).toBe(1);
  });
});

describe("Mosstodon (Forge: each other friendly Dinosaur gets +N health)", () => {
  it("buffs other friendly Dinosaurs only", () => {
    const g = gameWith("mosstodon");
    const dino = spawnCreature(g, [], 0, "tremorsaur", 1, { lane: 0 })!; // 0/8 Dinosaur
    const plain = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // 4/7 Hydra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 7/4 Dinosaur
    expect(dino.health).toBe(11); // 8 + 3
    expect(plain.health).toBe(7); // unchanged
    expect(g.state.players[0].lanes[2]!.health).toBe(4); // itself unchanged ("other")
  });
});

describe("Othra, Apex Predator (rank up: replace with the next-level Othra; L3 poisons)", () => {
  it("replaces itself with a level 2 Othra when you gain a rank", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "othra-apex-predator", 1, { lane: 1 }); // 8/6
    g.state.players[0].turnInRank = 4; // this endTurn ranks up to 2
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].rank).toBe(2);
    const othra = g.state.players[0].lanes[1]!;
    expect(othra.defId).toBe("othra-apex-predator");
    expect(othra.level).toBe(2);
    expect(othra.attack).toBe(0); // fresh level 2 copy
    expect(othra.health).toBe(12);
    expect(hasKeyword(othra, "Defender")).toBe(true);
    expect(g.state.players[0].discard.some((i) => i.defId === "othra-apex-predator" && i.level === 1)).toBe(true);
  });

  it("replaces a level 2 Othra with the 10/50 level 3; ignores the opponent's rank-up", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "othra-apex-predator", 2, { lane: 1 });
    applyAction(g, { type: "endTurn" }); // p1's turn
    g.state.players[1].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // p1 ranks up: no trigger for p0's Othra
    expect(g.state.players[1].rank).toBe(2);
    expect(g.state.players[0].lanes[1]!.level).toBe(2);
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // p0 ranks up
    const othra = g.state.players[0].lanes[1]!;
    expect(othra.level).toBe(3);
    expect(othra.attack).toBe(10);
    expect(othra.health).toBe(50);
  });

  it("L3 gives Poison 10 to a creature or player it deals battle damage to", () => {
    const g = gameWith("cavern-hydra");
    const othra = spawnCreature(g, [], 0, "othra-apex-predator", 3, { lane: 0 })!; // 10/50
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    const a = collectInto(() => dealCreatureDamage(g, [], foe, 10, othra, true));
    runBatches(g, [], a);
    expect(keywordValue(foe, "Poison")).toBe(10);
    const b = collectInto(() => dealPlayerDamage(g, [], 1, 10, othra, true));
    runBatches(g, [], b);
    expect(g.state.players[1].poison).toBe(10);
    // non-battle damage from Othra gives no Poison
    const foe2 = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    const c = collectInto(() => dealCreatureDamage(g, [], foe2, 10, othra));
    runBatches(g, [], c);
    expect(keywordValue(foe2, "Poison")).toBe(0);
  });
});

describe("Shroudthorn Splicer (friendly Darkforged enters, if Forged: Spawn a Darkforged Mimic)", () => {
  it("spawns a 2/3 Mimic when another friendly Darkforged is Forged, but not off itself or un-Forged entries", () => {
    const g = gameWith("shroudthorn-splicer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 2/3
    // its own Forge: the engine does not broadcast a creature's entry to itself
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "darkforged-mimic")).toHaveLength(0);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // second splicer, Forged
    const mimics = g.state.players[0].lanes.filter((c) => c?.defId === "darkforged-mimic");
    expect(mimics).toHaveLength(1);
    expect(mimics[0]!.attack).toBe(2);
    expect(mimics[0]!.health).toBe(3);
    // un-Forged Darkforged entry: no trigger
    const open = g.state.players[0].lanes.findIndex((c) => !c);
    const a = collectInto(() => spawnCreature(g, [], 0, "darkforged-mimic", 1, { lane: open }));
    runBatches(g, [], a);
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "darkforged-mimic")).toHaveLength(2);
  });
});

describe("Tremorsaur (you are dealt battle damage: +attack equal to the damage; L3: twice)", () => {
  it("gains attack when battle damage hits you", () => {
    const g = gameWith("tremorsaur");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 0/8
    const saur = g.state.players[0].lanes[0]!;
    spawnCreature(g, [], 1, "lightning-wyrm", 1, { lane: 2 }); // 4/2 Aggressive
    applyAction(g, { type: "battle" }); // the wyrm hits p0 for 4
    expect(g.state.players[0].health).toBe(116);
    expect(saur.attack).toBe(4);
  });

  it("L3 gains twice the damage", () => {
    const g = gameWith("cavern-hydra");
    const saur = spawnCreature(g, [], 0, "tremorsaur", 3, { lane: 0 })!; // 0/24
    spawnCreature(g, [], 1, "lightning-wyrm", 1, { lane: 2 });
    applyAction(g, { type: "battle" });
    expect(saur.attack).toBe(8); // 4 * 2
  });

  it("does not grow from non-battle damage to you (engine gap — see header)", () => {
    const g = gameWith("cavern-hydra");
    const saur = spawnCreature(g, [], 0, "tremorsaur", 1, { lane: 0 })!;
    const initial = collectInto(() => dealPlayerDamage(g, [], 0, 5));
    runBatches(g, [], initial);
    expect(g.state.players[0].health).toBe(115);
    expect(saur.attack).toBe(0); // TODO: no hook for non-battle player damage
  });
});

describe("Verdant Sphere (creature gets +N health, you gain N health)", () => {
  it("gives any creature +5 health and heals you for 5", () => {
    const g = gameWith("verdant-sphere");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.health).toBe(12); // 7 + 5 (any creature, even an enemy)
    expect(foe.attack).toBe(4);
    expect(g.state.players[0].health).toBe(105);
  });
});

describe("Vigorwisp (when it gains health, heal that much from each other friendly creature)", () => {
  it("heals other friendly creatures when it is healed; +health buffs do not trigger", () => {
    const g = gameWith("vigorwisp");
    const wisp = spawnCreature(g, [], 0, "vigorwisp", 1, { lane: 0 })!; // 5/5
    wisp.damage = 3;
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // 4/7
    ally.damage = 4;
    const a = collectInto(() => healCreature(g, [], wisp, 2));
    runBatches(g, [], a);
    expect(wisp.damage).toBe(1);
    expect(ally.damage).toBe(2); // healed for the 2 the wisp actually healed
    // a +health buff is not a heal (Everflow Eidolon convention)
    const b = collectInto(() => buffCreature(g, [], wisp, 0, 5));
    runBatches(g, [], b);
    expect(wisp.health).toBe(10);
    expect(ally.damage).toBe(2);
  });
});

describe("Enduring Vitality (UNIMPLEMENTED player aura — no-op, Overload still applies)", () => {
  it("resolves as a no-op and is removed from the game", () => {
    const g = gameWith("enduring-vitality");
    const side = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    const a = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }));
    runBatches(g, [], a);
    expect(side.attack).toBe(4); // no aura — TODO
    expect(g.state.players[0].removed.some((i) => i.defId === "enduring-vitality")).toBe(true);
  });
});

describe("Patron of Deepwood (Forge with 3+ Uterra cards in hand: optional copy into an adjacent space)", () => {
  it("offers the copy and places it adjacent when accepted", () => {
    const g = gameWith("patron-of-deepwood"); // all-Uterra hand
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 7/4
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    const patrons = g.state.players[0].lanes
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c?.defId === "patron-of-deepwood");
    expect(patrons).toHaveLength(2);
    const copy = patrons.find((x) => x.i !== 2)!;
    expect(Math.abs(copy.i - 2)).toBe(1); // adjacent space
    expect(copy.c!.level).toBe(1); // a copy at the same level
  });

  it("declining places no copy", () => {
    const g = gameWith("patron-of-deepwood");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "patron-of-deepwood")).toHaveLength(1);
  });

  it("does not trigger with fewer than 3 Uterra cards in hand", () => {
    const g = gameWith("ashurian-mystic"); // non-Uterra hand
    addToHand(g, 0, "patron-of-deepwood");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "patron-of-deepwood")).toHaveLength(1);
  });
});

describe("Rubyscale Dragon (end of your turn: you and each other friendly creature get +N health)", () => {
  it("heals you and buffs other friendly creatures, not itself", () => {
    const g = gameWith("rubyscale-dragon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 2/7
    const dragon = g.state.players[0].lanes[0]!;
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // 4/7
    g.state.players[0].health = 100;
    applyAction(g, { type: "endTurn" }); // p0's turnEnd
    expect(g.state.players[0].health).toBe(101);
    expect(ally.health).toBe(8); // 7 + 1
    expect(dragon.health).toBe(7); // itself excluded ("other")
  });
});

describe("Shardplate Graft (+N/+N and 'at the start of your turn, this gets +N/+N')", () => {
  it("grants a stacking start-of-turn growth ability", () => {
    const g = gameWith("shardplate-graft");
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: ally.uid });
    expect(ally.attack).toBe(6); // 4 + 2
    expect(ally.health).toBe(9);
    expect(ally.grantedAbilities).toEqual(["uterra:shardplate-graft-2"]);
    applyAction(g, { type: "playCard", handIndex: 0 }); // second graft on the same creature
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: ally.uid });
    expect(ally.attack).toBe(8);
    expect(ally.health).toBe(11);
    expect(ally.grantedAbilities).toEqual(["uterra:shardplate-graft-2", "uterra:shardplate-graft-2"]);
    endRound(g); // p0's next startTurn: both granted abilities fire
    expect(ally.attack).toBe(12); // 8 + 2 + 2
    expect(ally.health).toBe(15);
  });

  it("cannot target an enemy creature", () => {
    const g = gameWith("shardplate-graft");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no friendly creature in play: no prompt
    expect(foe.attack).toBe(4);
  });
});
