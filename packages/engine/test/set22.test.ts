import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, destroyCreature, getCardScript,
  keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set21 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set22 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.2.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set2, set21, set22);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra", seed = 7): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), seed);
}

function passTurns(g: Game, n: number): void {
  for (let i = 0; i < n; i++) applyAction(g, { type: "endTurn" });
}

/** Destroy a creature outside of combat, resolving its trigger batch. */
function slay(g: Game, uid: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => destroyCreature(g, [], c));
  runBatches(g, [], initial);
}

describe("Set 2.2 script registration", () => {
  it("registers every Set 2.2 card with non-trivial text", () => {
    const scripted = [
      "agamemnon", "blightskull-phantasm", "flamebreak-invoker", "gemheart-sprout",
      "metamind-overseer", "mimicwurm", "palladium-simulacrum", "phalanx-squadron",
      "razortooth-stalker", "shardthief-druid", "shimmerfang-serpent", "sigmund-fraud",
      "spiritfrost-shaman", "stygian-lotus", "umbraglim-mantis", "xithian-host",
      "yuru-the-necrosage",
    ];
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
    // spiritforge-sentinel is keyword-only (Armor N): no script
  });

  it("spirit-reaver / ice-torrent stay registered from set2-nekrium/set5-tempys (skipped here)", () => {
    expect(cards["spirit-reaver"]).toBeTruthy();
    expect(getCardScript("spirit-reaver")).not.toBeNull();
    expect(cards["ice-torrent"]).toBeTruthy();
    expect(getCardScript("ice-torrent")).not.toBeNull();
  });
});

describe("Agamemnon (battle damage to a creature on your turn: battles again)", () => {
  it("refunds the battle action so it can battle a second time", () => {
    const g = gameWith("agamemnon");
    spawnCreature(g, [], 0, "agamemnon", 1, { lane: 0 }); // 4/8
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    passTurns(g, 2); // offensive
    applyAction(g, { type: "battle" }); // trade 4/4; trigger refunds the battle
    expect(g.state.battlesLeft).toBe(1);
    applyAction(g, { type: "battle" }); // second battle is legal
    expect(g.state.players[1].lanes[0]).toBeNull(); // hydra took 4 twice and died
  });

  it("does not refund while defending on the opponent's turn", () => {
    const g = gameWith("agamemnon", "cavern-hydra");
    spawnCreature(g, [], 0, "agamemnon", 1, { lane: 0 }); // 4/8
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "endTurn" }); // p1's turn
    applyAction(g, { type: "battle" }); // hydra attacks into agamemnon
    expect(g.state.battlesLeft).toBe(0); // no extra battle on the enemy turn
  });
});

describe("Blightskull Phantasm (rank up: opposing creature -N/-N)", () => {
  it("gives the opposing creature -3/-3 when you gain a Rank", () => {
    const g = gameWith("blightskull-phantasm");
    spawnCreature(g, [], 0, "blightskull-phantasm", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // opposed 4/7
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // p0 ranks up
    expect(g.state.players[0].rank).toBe(2);
    const hydra = g.state.players[1].lanes[1]!;
    expect([hydra.attack, hydra.health]).toEqual([1, 4]);
  });
});

describe("Flamebreak Invoker (Tempys spellPlayed: 1 to each enemy creature)", () => {
  it("burns each enemy creature on your Tempys spells, ignores other factions", () => {
    const g = gameWith("tremorcharge");
    spawnCreature(g, [], 0, "flamebreak-invoker", 1, { lane: 0 }); // Tempys 4/6
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 }); // Tremorcharge (Tempys) targets the invoker
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    expect(g.state.players[1].lanes[0]!.damage).toBe(1);
    expect(g.state.players[1].lanes[1]!.damage).toBe(1);
    g.state.players[0].hand.push({ uid: 9001, defId: "energy-surge", level: 1, owner: 0 }); // Alloyin
    applyAction(g, { type: "playCard", handIndex: g.state.players[0].hand.length - 1 });
    expect(g.state.players[1].lanes[0]!.damage).toBe(1); // unchanged
  });
});

describe("Gemheart Sprout (Activate: gain health per friendly creature)", () => {
  it("L1 heals 1 per friendly creature (itself included)", () => {
    const g = gameWith("gemheart-sprout");
    spawnCreature(g, [], 0, "gemheart-sprout", 1, { lane: 0 }); // 3/4 Defender
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const sprout = g.state.players[0].lanes[0]!;
    sprout.defensive = false;
    g.state.players[0].health = 100;
    applyAction(g, { type: "activate", uid: sprout.uid });
    expect(g.state.players[0].health).toBe(102); // 2 friendly creatures x 1
  });

  it("L2 heals 2 per friendly creature", () => {
    const g = gameWith("gemheart-sprout");
    spawnCreature(g, [], 0, "gemheart-sprout", 2, { lane: 0 });
    const sprout = g.state.players[0].lanes[0]!;
    sprout.defensive = false;
    g.state.players[0].health = 100;
    applyAction(g, { type: "activate", uid: sprout.uid });
    expect(g.state.players[0].health).toBe(102); // 1 friendly creature x 2
  });
});

describe("Metamind Overseer (rank up: draw 2 cards)", () => {
  it("draws 2 extra cards at your rank-up", () => {
    const g = gameWith("metamind-overseer");
    spawnCreature(g, [], 0, "metamind-overseer", 1, { lane: 0 });
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // hand discarded, rank up: draw 2, then the turn draw of 5
    expect(g.state.players[0].rank).toBe(2);
    expect(g.state.players[0].hand).toHaveLength(7);
  });
});

describe("Mimicwurm (Forge: optional copies at lower levels)", () => {
  it("L1 has no Forge ability", () => {
    const g = gameWith("mimicwurm");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
  });

  it("L2 accepted: puts a level 1 Mimicwurm into another space", () => {
    const g = gameWith("mimicwurm");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    const wurms = g.state.players[0].lanes.filter((c) => c?.defId === "mimicwurm");
    expect(wurms.map((c) => c!.level).sort()).toEqual([1, 2]);
  });

  it("L2 declined: no copy", () => {
    const g = gameWith("mimicwurm");
    g.state.players[0].hand[0]!.level = 2;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "mimicwurm")).toHaveLength(1);
  });

  it("L3 chains: level 2 copy, then a level 1 copy", () => {
    const g = gameWith("mimicwurm");
    g.state.players[0].hand[0]!.level = 3;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true }); // level 2 copy
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("yesNo");
    applyChoice(g, { id: req2.id, accepted: true }); // level 1 copy
    expect(g.state.pending).toBeNull();
    const levels = g.state.players[0].lanes
      .filter((c) => c?.defId === "mimicwurm").map((c) => c!.level).sort();
    expect(levels).toEqual([1, 2, 3]);
  });
});

describe("Palladium Simulacrum (Forge/Flank: copy if in the center space)", () => {
  it("spawns a same-level copy when Forged into the center space", () => {
    const g = gameWith("palladium-simulacrum");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const sims = g.state.players[0].lanes.filter((c) => c?.defId === "palladium-simulacrum");
    expect(sims).toHaveLength(2);
    expect(sims.every((c) => c!.level === 1)).toBe(true);
  });

  it("does not copy when Forged off-center", () => {
    const g = gameWith("palladium-simulacrum");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "palladium-simulacrum")).toHaveLength(1);
  });

  it("spawns a copy when moved into the center space (Flank)", () => {
    const g = gameWith("palladium-simulacrum");
    spawnCreature(g, [], 0, "palladium-simulacrum", 2, { lane: 1 }); // Mobility 1 inherent
    const sim = g.state.players[0].lanes[1]!;
    sim.defensive = false;
    applyAction(g, { type: "move", uid: sim.uid, lane: 2 });
    const sims = g.state.players[0].lanes.filter((c) => c?.defId === "palladium-simulacrum");
    expect(sims).toHaveLength(2);
    expect(sims.every((c) => c!.level === 2)).toBe(true);
  });
});

describe("Phalanx Squadron (Forge: friendly creature with Armor gets +N/+N)", () => {
  it("offers only friendly creatures with Armor and buffs the pick +2/+2", () => {
    const g = gameWith("phalanx-squadron");
    spawnCreature(g, [], 0, "aegis-knight", 1, { lane: 0 }); // Armor 1
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }); // no Armor
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[0].lanes[0]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[0]!.uid });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([7, 7]);
  });
});

describe("Razortooth Stalker (battle damage to a player: +N/+N)", () => {
  it("grows +2/+2 after hitting the enemy player", () => {
    const g = gameWith("razortooth-stalker");
    spawnCreature(g, [], 0, "razortooth-stalker", 1, { lane: 2 }); // 4/5
    passTurns(g, 2);
    applyAction(g, { type: "battle" });
    const stalker = g.state.players[0].lanes[2]!;
    expect(g.state.players[1].health).toBe(116);
    expect([stalker.attack, stalker.health]).toEqual([6, 7]);
  });
});

describe("Shardthief Druid (Forge: steal all Regenerate from an enemy creature)", () => {
  it("negates the target's Regenerate and gains that much itself", () => {
    const g = gameWith("shardthief-druid");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // Regenerate 1 inherent
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 }); // Regenerate 3 inherent
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([
      g.state.players[1].lanes[1]!.uid,
      g.state.players[1].lanes[2]!.uid,
    ]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[1].lanes[2]!.uid });
    expect(keywordValue(g.state.players[1].lanes[2]!, "Regenerate")).toBe(0);
    expect(keywordValue(g.state.players[0].lanes[0]!, "Regenerate")).toBe(3);
  });

  it("fizzles when no enemy creature has Regenerate", () => {
    const g = gameWith("shardthief-druid");
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 1 }); // no Regenerate
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(keywordValue(g.state.players[0].lanes[0]!, "Regenerate")).toBe(0);
  });
});

describe("Shimmerfang Serpent (battle damage to a creature: that much Poison)", () => {
  it("gives the creature Poison equal to the damage dealt", () => {
    const g = gameWith("shimmerfang-serpent");
    spawnCreature(g, [], 0, "shimmerfang-serpent", 1, { lane: 0 }); // 3/6
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7
    passTurns(g, 2);
    applyAction(g, { type: "battle" }); // serpent deals 3 to the hydra
    const hydra = g.state.players[1].lanes[0]!;
    expect(hydra.damage).toBe(3);
    expect(keywordValue(hydra, "Poison")).toBe(3);
  });
});

describe("Sigmund Fraud (Activate, destroy another friendly creature: drain N)", () => {
  it("sacrifices a friendly creature, deals 4 and heals you for 4", () => {
    const g = gameWith("sigmund-fraud");
    spawnCreature(g, [], 0, "sigmund-fraud", 1, { lane: 0 }); // 3/9 Defender
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const fraud = g.state.players[0].lanes[0]!;
    fraud.defensive = false;
    g.state.players[0].health = 100;
    applyAction(g, { type: "activate", uid: fraud.uid });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([g.state.players[0].lanes[1]!.uid]); // "another" only
    applyChoice(g, { id: req.id, accepted: true, targetUid: g.state.players[0].lanes[1]!.uid });
    expect(g.state.players[0].lanes[1]).toBeNull(); // sacrificed
    expect(g.state.players[1].health).toBe(116);
    expect(g.state.players[0].health).toBe(104);
  });

  it("cannot activate while it is your only creature", () => {
    const g = gameWith("sigmund-fraud");
    spawnCreature(g, [], 0, "sigmund-fraud", 1, { lane: 0 });
    const fraud = g.state.players[0].lanes[0]!;
    fraud.defensive = false;
    expect(() => applyAction(g, { type: "activate", uid: fraud.uid })).toThrow();
  });
});

describe("Spiritfrost Shaman (rank up: deal N to the enemy player)", () => {
  it("deals 5 to the enemy player at your rank-up", () => {
    const g = gameWith("spiritfrost-shaman");
    spawnCreature(g, [], 0, "spiritfrost-shaman", 1, { lane: 0 });
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].health).toBe(115);
  });
});

describe("Stygian Lotus (Forge: copy itself while opposed)", () => {
  it("fills your side with copies when every space is opposed", () => {
    const g = gameWith("stygian-lotus");
    for (let i = 0; i < 5; i++) spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: i });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "stygian-lotus")).toHaveLength(5);
  });

  it("spawns nothing when unopposed", () => {
    const g = gameWith("stygian-lotus");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes.filter(Boolean)).toHaveLength(1);
  });

  it("spawns a single copy when only the original is opposed", () => {
    const g = gameWith("stygian-lotus", "cavern-hydra", 11);
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // only lane 2 opposed
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    // the copy lands in a random unopposed space and stops the chain
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "stygian-lotus")).toHaveLength(2);
  });
});

describe("Umbraglim Mantis (rank up: you get +N health)", () => {
  it("heals you for 8 at your rank-up", () => {
    const g = gameWith("umbraglim-mantis");
    spawnCreature(g, [], 0, "umbraglim-mantis", 1, { lane: 0 });
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].health).toBe(128);
  });
});

describe("Xithian Host (Vengeance: 3 to the enemy player, heal N)", () => {
  it("deals 3 and heals 3 at L1, heals 9 at L3", () => {
    const g = gameWith("xithian-host");
    spawnCreature(g, [], 0, "xithian-host", 1, { lane: 2 });
    slay(g, g.state.players[0].lanes[2]!.uid);
    expect(g.state.players[1].health).toBe(117);
    expect(g.state.players[0].health).toBe(123);
    const g2 = gameWith("xithian-host");
    spawnCreature(g2, [], 0, "xithian-host", 3, { lane: 2 });
    slay(g2, g2.state.players[0].lanes[2]!.uid);
    expect(g2.state.players[1].health).toBe(117); // always 3 damage
    expect(g2.state.players[0].health).toBe(129);
  });
});

describe("Yuru, the Necrosage (adjacent non-Spirit death: Spirit token)", () => {
  it("puts a 5/5 Spirit into an adjacent friendly creature's space", () => {
    const g = gameWith("yuru-the-necrosage");
    spawnCreature(g, [], 0, "yuru-the-necrosage", 1, { lane: 2 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 }); // adjacent
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 4 }); // not adjacent
    slay(g, g.state.players[0].lanes[1]!.uid);
    const spirit = g.state.players[0].lanes[1];
    expect(spirit?.defId).toBe("spirit-nekrium");
    expect([spirit?.attack, spirit?.health]).toEqual([5, 5]);
    slay(g, g.state.players[0].lanes[4]!.uid);
    expect(g.state.players[0].lanes[4]).toBeNull(); // no Spirit from a distant death
  });

  it("does not trigger for Spirits or enemy creatures", () => {
    const g = gameWith("yuru-the-necrosage");
    spawnCreature(g, [], 0, "yuru-the-necrosage", 1, { lane: 2 });
    spawnCreature(g, [], 0, "spirit-nekrium", 1, { lane: 1, overrideStats: { attack: 5, health: 5 } });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // enemy death in the "mirror" lane
    slay(g, g.state.players[0].lanes[1]!.uid); // Spirit: no trigger
    expect(g.state.players[0].lanes[1]).toBeNull();
    slay(g, g.state.players[1].lanes[1]!.uid); // enemy creature: no trigger
    expect(g.state.players[0].lanes[1]).toBeNull();
  });
});
