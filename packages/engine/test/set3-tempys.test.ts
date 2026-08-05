import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript,
  hasKeyword, loadCards, runBatches, spawnCreature,
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

/** Spawn a creature with its enter-play trigger batch resolved (un-Forged entry). */
function spawnFiring(g: Game, p: PlayerId, defId: string, level: number, lane: number): void {
  const initial = collectInto(() => { spawnCreature(g, [], p, defId, level, { lane }); });
  runBatches(g, [], initial);
}

describe("Set 3/3.1 Tempys script registration", () => {
  it("registers every Set 3 + 3.1 Tempys card in scope, plus the tokens", () => {
    const scripted = [
      "ashurian-flamesculptor", "borean-stormweaver", "burnout", "cinderbound-barbarian",
      "flamerift-instigator", "frostfang-maiden", "frostmane-dragon", "hammerfang",
      "herald-of-destruction", "iztek-khan-of-arrachtor", "oratek-battlebrand",
      "oratek-warhammer", "rage-of-kadras", "seal-of-kadras",
      // token cards scripted in the same file
      "frostmane-egg", "iztek-avatar-of-flame", "iztek-avatar-of-frost",
      "izteks-flame", "izteks-frost",
    ];
    for (const id of scripted) expect(cards[id], id).toBeTruthy();
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
  });
});

describe("Ashurian Flamesculptor (Forge: additional Tempys spell)", () => {
  it("L2 Forge grants an additional play", () => {
    const g = gameWith("ashurian-flamesculptor");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.playsLeft).toBe(2); // 2 - 1 spent + 1 granted
  });

  it("L1 is vanilla (no extra play)", () => {
    const g = gameWith("ashurian-flamesculptor");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.playsLeft).toBe(1);
  });
});

describe("Borean Stormweaver (Activate: N to a creature)", () => {
  it("deals 2 to a chosen creature at L1", () => {
    const g = gameWith("borean-stormweaver");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const weaver = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    weaver.defensive = false;
    applyAction(g, { type: "activate", uid: weaver.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(2);
  });
});

describe("Burnout (Overload: 8 to a creature or player)", () => {
  it("kills a 7-health creature and is removed from the game", () => {
    const g = gameWith("burnout");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull(); // 8 damage kills the 4/7
    expect(g.state.players[0].removed.map((c) => c.defId)).toContain("burnout");
    expect(g.state.players[0].discard.map((c) => c.defId)).not.toContain("burnout");
  });
});

describe("Cinderbound Barbarian (Forge at Rank gate: N to an enemy creature)", () => {
  it("does nothing below the rank gate", () => {
    const g = gameWith("cinderbound-barbarian");
    spawnFiring(g, 1, "cavern-hydra", 1, 2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // rank 1 < 2
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[2]!.damage).toBe(0);
  });

  it("at rank 2 deals 6 to a chosen enemy creature", () => {
    const g = gameWith("cinderbound-barbarian");
    g.state.players[0].rank = 2;
    spawnFiring(g, 1, "cavern-hydra", 1, 2);
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.optional).toBeFalsy(); // mandatory
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(6);
  });
});

describe("Flamerift Instigator (Forge: Negate Defender)", () => {
  it("negates Defender from a chosen creature", () => {
    const g = gameWith("flamerift-instigator");
    spawnFiring(g, 1, "cavern-hydra", 1, 2);
    const hydra = g.state.players[1].lanes[2]!;
    hydra.keywords.push({ keyword: "Defender", value: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([hydra.uid]); // only creatures with Defender
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Defender")).toBe(false);
  });
});

describe("Frostfang Maiden (friendly move: N to the creature opposing it)", () => {
  it("triggers on its own move", () => {
    const g = gameWith("frostfang-maiden");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const maiden = g.state.players[0].lanes[1]!;
    const hydra = g.state.players[1].lanes[0]!;
    maiden.defensive = false;
    applyAction(g, { type: "move", uid: maiden.uid, lane: 0 }); // Mobility 1
    expect(hydra.damage).toBe(3);
  });

  it("triggers when another friendly creature moves", () => {
    const g = gameWith("frostfang-maiden");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 });
    const mover = g.state.players[0].lanes[2]!;
    const target = g.state.players[1].lanes[3]!;
    mover.keywords.push({ keyword: "Mobility", value: 1 });
    mover.defensive = false;
    applyAction(g, { type: "move", uid: mover.uid, lane: 3 });
    expect(target.damage).toBe(3);
    expect(g.state.players[0].lanes[0]!.defId).toBe("frostfang-maiden"); // maiden stayed
  });
});

describe("Frostmane Dragon (egg the turn after being Forged)", () => {
  function forgedDragon(g: Game): void {
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "endTurn" }); // p0 ends; p1's turn
    applyAction(g, { type: "endTurn" }); // p1 ends; p0's turn starts -> hatch prompt
  }

  it("offers a level 1 Frostmane Egg at the start of your next turn", () => {
    const g = gameWith("frostmane-dragon");
    forgedDragon(g);
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    const egg = g.state.players[0].lanes.find((c) => c?.defId === "frostmane-egg");
    expect(egg).toBeTruthy();
    expect([egg!.attack, egg!.health, egg!.level]).toEqual([0, 6, 1]);
    expect(egg!.lane).not.toBe(2); // an available space, not the dragon's
    expect(g.state.players[0].lanes[2]!.defId).toBe("frostmane-dragon");
  });

  it("declined: no egg, and the one-shot marker does not re-prompt", () => {
    const g = gameWith("frostmane-dragon");
    forgedDragon(g);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "frostmane-egg")).toHaveLength(0);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" });
    expect(g.state.pending).toBeNull(); // no second prompt a turn later
  });

  it("an un-Forged dragon never offers the egg", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "frostmane-dragon", 1, { lane: 2 }); // not from hand
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "frostmane-egg")).toHaveLength(0);
  });
});

describe("Frostmane Egg (rank up: replace with same-level Dragon)", () => {
  it("becomes a level 1 Frostmane Dragon when you gain a rank", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "frostmane-egg", 1, { lane: 1 });
    g.state.players[0].turnInRank = 4; // this endTurn ranks up to 2
    applyAction(g, { type: "endTurn" });
    const dragon = g.state.players[0].lanes[1];
    expect(dragon?.defId).toBe("frostmane-dragon");
    expect(dragon?.level).toBe(1);
    expect(g.state.players[0].discard.some((c) => c.defId === "frostmane-egg")).toBe(true);
  });
});

describe("Hammerfang (enemy enters opposing: sidestep to a random open space)", () => {
  it("moves away when an enemy creature is Spawned opposing it", () => {
    const g = gameWith("hammerfang");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    spawnFiring(g, 1, "cavern-hydra", 1, 2);
    const fang = g.state.players[0].lanes.find((c) => c?.defId === "hammerfang");
    expect(fang).toBeTruthy();
    expect(fang!.lane).not.toBe(2);
    expect(g.state.players[1].lanes[2]!.defId).toBe("cavern-hydra");
  });

  it("also moves when the enemy creature is Forged opposing it", () => {
    const g = gameWith("hammerfang");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    g.state.active = 1;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // p1 plays the hydra
    const fang = g.state.players[0].lanes.find((c) => c?.defId === "hammerfang");
    expect(fang).toBeTruthy();
    expect(fang!.lane).not.toBe(2);
  });
});

describe("Herald of Destruction (un-Forged enemy entry: attack to that player)", () => {
  it("pings for its attack on un-Forged entries only", () => {
    const g = gameWith("herald-of-destruction");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3 attack at L1
    spawnFiring(g, 1, "cavern-hydra", 1, 2); // un-Forged: ping
    expect(g.state.players[1].health).toBe(120 - 3);
    g.state.active = 1;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // Forged: no ping
    expect(g.state.players[1].health).toBe(120 - 3);
  });
});

describe("Iztek, Khan of Arrachtor (Solbind + Avatar flips)", () => {
  it("Solbind adds one Iztek's Frost and one Iztek's Flame to the deck", () => {
    const g = gameWith("iztek-khan-of-arrachtor");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand].map((c) => c.defId);
    expect(all).toHaveLength(32); // 30 + 2 bound
    expect(all.filter((id) => id === "izteks-frost")).toHaveLength(1);
    expect(all.filter((id) => id === "izteks-flame")).toHaveLength(1);
  });

  it("playing Iztek's Flame replaces the Khan with a level 1 Avatar of Flame", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "iztek-khan-of-arrachtor");
    addToHand(g, 0, "izteks-flame");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // the Khan
    applyAction(g, { type: "playCard", handIndex: 5 }); // Iztek's Flame
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    applyChoice(g, { id: req.id, accepted: true, targetUid: -2 }); // player 1
    expect(g.state.players[1].health).toBe(120 - 6);
    const avatar = g.state.players[0].lanes[0];
    expect(avatar?.defId).toBe("iztek-avatar-of-flame");
    expect([avatar!.attack, avatar!.health, avatar!.level]).toEqual([7, 6, 1]);
    expect(g.state.players[0].discard.some((c) => c.defId === "iztek-khan-of-arrachtor")).toBe(true);
  });

  it("playing Iztek's Frost replaces the Khan with a level 1 Avatar of Frost", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "iztek-khan-of-arrachtor");
    addToHand(g, 0, "izteks-frost");
    spawnFiring(g, 1, "cavern-hydra", 1, 2);
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // the Khan
    applyAction(g, { type: "playCard", handIndex: 5 }); // Iztek's Frost
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toContain(hydra.uid);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.grantedAbilities).toContain("tempys:frozen-solid");
    const avatar = g.state.players[0].lanes[0];
    expect(avatar?.defId).toBe("iztek-avatar-of-frost");
    expect([avatar!.attack, avatar!.health, avatar!.level]).toEqual([6, 7, 1]);
  });
});

describe("Iztek, Avatar of Flame (double battle damage; flips on Frost)", () => {
  it("deals its battle damage to the player again", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "iztek-avatar-of-flame", 1, { lane: 0 });
    const avatar = g.state.players[0].lanes[0]!;
    avatar.defensive = false; // Aggressive is inherent from the card data
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(120 - 14); // 7 battle + 7 again
  });

  it("playing Iztek's Frost replaces it with an Avatar of Frost", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "iztek-avatar-of-flame", 1, { lane: 0 });
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    addToHand(g, 0, "izteks-frost");
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[0].lanes[0]?.defId).toBe("iztek-avatar-of-frost");
    expect(g.state.players[0].discard.some((c) => c.defId === "iztek-avatar-of-flame")).toBe(true);
  });
});

describe("Iztek, Avatar of Frost (Activate: N to a creature)", () => {
  it("deals 2 to a chosen creature at L1", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 0, "iztek-avatar-of-frost", 1, { lane: 0 });
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const avatar = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    avatar.defensive = false;
    applyAction(g, { type: "activate", uid: avatar.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(2);
  });
});

describe("Iztek's Flame (Solbind token spell)", () => {
  it("L2 deals 9 to a creature", () => {
    const g = gameWith("cavern-hydra");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    addToHand(g, 0, "izteks-flame", 2);
    applyAction(g, { type: "playCard", handIndex: 5 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull(); // 9 damage kills the 4/7
  });
});

describe("Iztek's Frost (Solbind token spell: destroy-on-damage until next turn ends)", () => {
  it("L1 gates to level 2 or lower and the granted ability destroys on damage", () => {
    const g = gameWith("cavern-hydra");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    spawnFiring(g, 1, "cavern-hydra", 3, 3);
    const low = g.state.players[1].lanes[1]!;
    addToHand(g, 0, "izteks-frost");
    applyAction(g, { type: "playCard", handIndex: 5 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([low.uid]); // the level 3 hydra is gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: low.uid });
    expect(low.grantedAbilities).toContain("tempys:frozen-solid");
    const initial = collectInto(() => dealCreatureDamage(g, [], low, 1));
    runBatches(g, [], initial);
    expect(g.state.players[1].lanes[1]).toBeNull(); // destroyed when dealt damage
  });

  it("expires at the end of the NEXT turn", () => {
    const g = gameWith("cavern-hydra");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    addToHand(g, 0, "izteks-frost");
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.grantedAbilities).toEqual(["tempys:frozen-solid", "tempys:set3-frost-expire-1"]);
    applyAction(g, { type: "endTurn" }); // this turn ends: still active
    expect(hydra.grantedAbilities).toEqual(["tempys:frozen-solid", "tempys:set3-frost-expire-2"]);
    applyAction(g, { type: "endTurn" }); // the next turn ends: expired
    expect(hydra.grantedAbilities).toEqual([]);
  });
});

describe("Oratek Battlebrand (N to a creature; Allied Alloyin: discard+level)", () => {
  it("chains the optional discard-and-level after the damage when Allied", () => {
    const g = gameWith("oratek-battlebrand");
    addToHand(g, 0, "alloyin-general");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("anyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: hydra.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("cardInHand");
    expect(req2.optional).toBe(true);
    applyChoice(g, { id: req2.id, accepted: true, handIndex: 4 }); // the Alloyin card
    const discard = g.state.players[0].discard;
    expect(discard.some((c) => c.defId === "alloyin-general" && c.level === 1)).toBe(true);
    expect(discard.some((c) => c.defId === "alloyin-general" && c.level === 2)).toBe(true);
    expect(g.state.players[1].lanes[1]).toBeNull(); // 7 damage killed the 4/7
  });

  it("without an Alloyin card in hand there is no second prompt", () => {
    const g = gameWith("oratek-battlebrand");
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[1]).toBeNull();
  });
});

describe("Oratek Warhammer (Allied Alloyin: battle damage to a player -> discard+level)", () => {
  it("offers the optional discard-and-level after hitting the player", () => {
    const g = gameWith("oratek-warhammer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const hammer = g.state.players[0].lanes[0]!;
    hammer.defensive = false;
    addToHand(g, 0, "alloyin-general");
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(120 - 3); // 3 attack at L1
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 4 }); // the Alloyin card
    const discard = g.state.players[0].discard;
    expect(discard.some((c) => c.defId === "alloyin-general" && c.level === 1)).toBe(true);
    expect(discard.some((c) => c.defId === "alloyin-general" && c.level === 2)).toBe(true);
  });

  it("no Alloyin card in hand: no trigger", () => {
    const g = gameWith("oratek-warhammer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const hammer = g.state.players[0].lanes[0]!;
    hammer.defensive = false;
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(120 - 3);
    expect(g.state.pending).toBeNull();
  });
});

describe("Rage of Kadras (friendly Tempys +1 attack and slam opposing)", () => {
  it("buffs each friendly Tempys creature and each slams its opposing creature", () => {
    const g = gameWith("rage-of-kadras");
    spawnCreature(g, [], 0, "hammerfang", 1, { lane: 0 }); // 5/5
    spawnCreature(g, [], 0, "hammerfang", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // plain spawn: Hammerfang stays
    applyAction(g, { type: "playCard", handIndex: 0 });
    const fang0 = g.state.players[0].lanes[0]!;
    const fang1 = g.state.players[0].lanes[1]!;
    const hydra = g.state.players[1].lanes[0]!;
    expect([fang0.attack, fang1.attack]).toEqual([6, 6]); // 5 + 1, permanent
    expect(hydra.damage).toBe(6); // opposing fang0's buffed attack
    expect(g.state.players[0].removed.map((c) => c.defId)).toContain("rage-of-kadras"); // Overload
  });
});

describe("Seal of Kadras (N to a creature or player)", () => {
  it("L1 deals 1 to a player", () => {
    const g = gameWith("seal-of-kadras");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    applyChoice(g, { id: req.id, accepted: true, targetUid: -2 }); // player 1
    expect(g.state.players[1].health).toBe(119);
  });

  it("L3 deals 25, killing a 7-health creature", () => {
    const g = gameWith("seal-of-kadras");
    g.state.players[0].hand[0]!.level = 3;
    spawnFiring(g, 1, "cavern-hydra", 1, 1);
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull();
  });
});
