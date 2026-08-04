import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, createGame, destroyCreature, getStats, grantKeyword,
  hasKeyword, keywordValue, loadCards, refreshStatics, runBatches, spawnCreature,
  type CreatureState, type Game, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** p0 passes turn 1, p1 plays a hydra in `lane`, passes; p0's turn again. */
function withEnemyHydra(g: Game, lane = 2): Game {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "playCard", handIndex: 0, lane });
  applyAction(g, { type: "endTurn" });
  return g;
}

describe("Alloyin General (adjacent attack aura)", () => {
  it("buffs only friendly creatures in adjacent lanes", () => {
    const g = gameWith("alloyin-general");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 });
    const p0 = g.state.players[0];
    expect(getStats(g, p0.lanes[1]!).attack).toBe(4); // 2 + 2 from lane 2
    expect(getStats(g, p0.lanes[2]!).attack).toBe(4); // 2 + 2 from lane 1
    expect(getStats(g, p0.lanes[4]!).attack).toBe(2); // no adjacent ally
  });
});

describe("Alloyin Highlander (lone warrior)", () => {
  it("gets +4 attack while it is the only friendly creature", () => {
    const g = gameWith("alloyin-highlander");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const first = g.state.players[0].lanes[2]!;
    expect(getStats(g, first).attack).toBe(9); // 5 + 4
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    expect(getStats(g, first).attack).toBe(5); // bonus lost
  });

  it("gets Armor 2 from the static only while it is the only friendly creature", () => {
    const g = gameWith("alloyin-highlander");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const first = g.state.players[0].lanes[2]!;
    refreshStatics(g);
    expect(keywordValue(first, "Armor")).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    refreshStatics(g);
    expect(keywordValue(first, "Armor")).toBe(0); // Armor lost too
  });
});

describe("Arcflight Squadron (Activate: extra play)", () => {
  it("grants an additional play this turn", () => {
    const g = gameWith("arcflight-squadron");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    endRound(g);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    expect(g.state.playsLeft).toBe(0);
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    expect(g.state.playsLeft).toBe(1);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 });
    expect(g.state.players[0].lanes[4]?.defId).toBe("arcflight-squadron");
  });
});

describe("Battle Techtician (center-space aura)", () => {
  it("buffs other friendly creatures only while in the center space", () => {
    const g = gameWith("battle-techtician");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // center
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const p0 = g.state.players[0];
    expect(getStats(g, p0.lanes[0]!).attack).toBe(5); // 3 + 2
    expect(getStats(g, p0.lanes[2]!).attack).toBe(3); // does not buff itself
  });
});

describe("Brightsteel Sentinel (Forge: Robots get Armor this turn)", () => {
  it("grants temp Armor 5 to friendly Robots, cleared at end of turn", () => {
    const g = gameWith("brightsteel-sentinel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const self = g.state.players[0].lanes[0]!;
    expect(keywordValue(self, "Armor")).toBe(5); // it is a Robot itself
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(self, "Armor")).toBe(0);
  });
});

describe("Bulwark Bash (two-step: friendly Armor source, then enemy target)", () => {
  it("deals damage equal to 1X the chosen friendly creature's Armor", () => {
    const g = gameWith("bulwark-bash");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const wall = g.state.players[0].lanes[0]!;
    grantKeyword([], wall, { keyword: "Armor", value: 5 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([wall.uid]); // only the creature with Armor
    applyChoice(g, { id: req1.id, accepted: true, targetUid: wall.uid });
    const req2 = g.state.pending!.request; // chained second prompt
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.pending).toBeNull();
    expect(hydra.damage).toBe(5); // Armor 5 x 1
  });
});

describe("Cypien Augmentation (center-space buff)", () => {
  it("buffs a creature in the center space", () => {
    const g = withEnemyHydra(gameWith("cypien-augmentation"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(6); // 4 + 2
    expect(hydra.health).toBe(9); // 7 + 2
  });
});

describe("Electro Net (permanent attack debuff)", () => {
  it("gives a creature −5 attack", () => {
    const g = withEnemyHydra(gameWith("electro-net"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(-1); // 4 − 5
  });
});

describe("Energy Prison (grant Defender)", () => {
  it("gives a level 1 creature Defender", () => {
    const g = withEnemyHydra(gameWith("energy-prison"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Defender")).toBe(true);
  });
});

describe("Flowsteel Prototype (grows when you play cheap creatures)", () => {
  it("doubles its attack when you play a level 1 creature", () => {
    const g = gameWith("flowsteel-prototype");
    // Turns 1–4: stock the deck with L2 copies, then rank up to 2.
    for (let t = 0; t < 4; t++) {
      applyAction(g, { type: "playCard", handIndex: 0, lane: t });
      applyAction(g, { type: "discardToLevel", handIndex: 0 });
      endRound(g);
    }
    expect(g.state.players[0].rank).toBe(2);
    let proto: CreatureState | null = null;
    for (let t = 0; t < 10 && !proto; t++) {
      const hand = g.state.players[0].hand;
      const i2 = hand.findIndex((c) => c.level === 2);
      const i1 = hand.findIndex((c) => c.level === 1);
      if (i2 >= 0 && i1 >= 0) {
        applyAction(g, { type: "playCard", handIndex: i2, lane: 4 });
        proto = g.state.players[0].lanes[4]!;
        expect(proto.level).toBe(2);
        const j1 = g.state.players[0].hand.findIndex((c) => c.level === 1);
        applyAction(g, { type: "playCard", handIndex: j1, lane: 0 }); // replace the L1 there
        expect(proto.attack).toBe(12); // 6 + 6
      } else {
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        endRound(g);
      }
    }
    expect(proto).not.toBeNull();
  });
});

describe("Forcefield (temp Armor)", () => {
  it("grants Armor 5 this turn only", () => {
    const g = withEnemyHydra(gameWith("forcefield"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(keywordValue(hydra, "Armor")).toBe(5);
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(hydra, "Armor")).toBe(0);
  });
});

describe("Forge Guardian Gamma (Activate: sacrifice five Robot Guardians)", () => {
  it("replaces five Robot Guardians with a 25/25 Forge Guardian Omega", () => {
    const g = gameWith("forge-guardian-gamma");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    endRound(g);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    endRound(g);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 });
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    const p0 = g.state.players[0];
    expect(p0.lanes[0]?.defId).toBe("forge-guardian-omega");
    expect(p0.lanes[0]?.attack).toBe(25);
    expect(p0.lanes[0]?.health).toBe(25);
    expect(p0.lanes[1]).toBeNull();
    expect(p0.lanes[2]).toBeNull();
    expect(p0.lanes[3]).toBeNull();
    expect(p0.lanes[4]).toBeNull();
  });
});

describe("Ghox, Metamind Paragon (start of turn draw)", () => {
  it("draws a card at the start of its controller's turn", () => {
    const g = gameWith("ghox-metamind-paragon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    expect(g.state.players[0].hand).toHaveLength(6); // 5 drawn + 1 from Ghox
  });
});

describe("Heavy Artillery (attack buff)", () => {
  it("gives a creature +5 attack", () => {
    const g = withEnemyHydra(gameWith("heavy-artillery"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(9); // 4 + 5
  });
});

describe("Hinterland Watchman (conditional keyword static)", () => {
  it("gains Mobility 3 only while it has 5 or more attack", () => {
    const g = gameWith("hinterland-watchman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/7
    const c = g.state.players[0].lanes[0]!;
    refreshStatics(g);
    expect(hasKeyword(c, "Mobility")).toBe(false); // 4 < 5
    buffCreature(g, [], c, 1, 0);
    refreshStatics(g);
    expect(keywordValue(c, "Mobility")).toBe(3); // 5 >= 5
  });
});

describe("Jet Pack (attack + Mobility)", () => {
  it("gives a creature +3 attack and Mobility 1", () => {
    const g = withEnemyHydra(gameWith("jet-pack"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(7); // 4 + 3
    expect(keywordValue(hydra, "Mobility")).toBe(1);
  });
});

describe("Lightshield Patrol (conditional Armor static)", () => {
  it("gains Armor 2 only while it has 5 or more attack", () => {
    const g = gameWith("lightshield-patrol");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/5
    const c = g.state.players[0].lanes[0]!;
    refreshStatics(g);
    expect(keywordValue(c, "Armor")).toBe(0); // 4 < 5
    buffCreature(g, [], c, 1, 0);
    refreshStatics(g);
    expect(keywordValue(c, "Armor")).toBe(2); // 5 >= 5
  });
});

describe("Matrix Warden (Forge: targeted friendly buff)", () => {
  it("prompts for a friendly creature and gives it +3 attack", () => {
    const g = gameWith("matrix-warden");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).not.toBeNull();
    const self = g.state.players[0].lanes[0]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: self.uid });
    expect(self.attack).toBe(6); // 3 + 3
  });
});

describe("Metasculpt (silence: remove all abilities)", () => {
  it("the silenced creature's Vengeance no longer triggers", () => {
    const g = gameWith("metasculpt");
    spawnCreature(g, [], 1, "fell-walker", 1, { lane: 1 }); // Vengeance: 3/3 Zombie
    const walker = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: walker.uid });
    expect(walker.silenced).toBe(true);
    destroyCreature(g, [], walker);
    runBatches(g, [], []);
    expect(g.state.players[1].lanes[1]).toBeNull(); // no 3/3 Zombie spawned
  });
});

describe("Metamind Adept (Forge: draw)", () => {
  it("draws a card when played from hand", () => {
    const g = gameWith("metamind-adept");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[0].hand).toHaveLength(5); // 4 left + 1 drawn
  });
});

describe("Munitions Drone (Activate: buff another creature)", () => {
  it("gives another creature +3 attack, excluding itself", () => {
    const g = gameWith("munitions-drone");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    endRound(g);
    const drone0 = g.state.players[0].lanes[0]!;
    const drone1 = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: drone0.uid });
    expect(g.state.pending!.request.options).not.toContain(drone0.uid);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: drone1.uid });
    expect(drone1.attack).toBe(4); // 1 + 3
  });
});

describe("Nexus Pilot (center-space bonus)", () => {
  it("gets +3/+4 only while in the center space", () => {
    const g = gameWith("nexus-pilot");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const p0 = g.state.players[0];
    expect(getStats(g, p0.lanes[2]!)).toEqual({ attack: 6, health: 8 });
    expect(getStats(g, p0.lanes[0]!)).toEqual({ attack: 3, health: 4 });
  });
});

describe("Oreian Warwalker (Activate: double attack)", () => {
  it("doubles its attack", () => {
    const g = gameWith("oreian-warwalker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    expect(g.state.players[0].lanes[0]!.attack).toBe(6); // 3 × 2
  });
});

describe("Palladium Pulsemage (Activate: temp debuff)", () => {
  it("gives a creature −4 attack until end of turn", () => {
    const g = gameWith("palladium-pulsemage");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    const hydra = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(getStats(g, hydra).attack).toBe(0); // 4 − 4
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, hydra).attack).toBe(4); // temp wore off
  });
});

describe("Sonic Pulse (enemy board debuff)", () => {
  it("gives each enemy creature −4 attack", () => {
    const g = withEnemyHydra(gameWith("sonic-pulse"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // untargeted
    expect(g.state.players[1].lanes[2]!.attack).toBe(0); // 4 − 4
  });
});

describe("Stasis Warden (spellPlayed: friendly creature gets Defender)", () => {
  it("grants Defender after you play a spell; it expires at the start of your next turn", () => {
    const g = gameWith("energy-surge");
    spawnCreature(g, [], 0, "stasis-warden", 1, { lane: 0 });
    const warden = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 }); // energy-surge L1
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([warden.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: warden.uid });
    expect(hasKeyword(warden, "Defender")).toBe(true);
    applyAction(g, { type: "endTurn" }); // p1's turn: still Defender
    expect(hasKeyword(warden, "Defender")).toBe(true);
    applyAction(g, { type: "endTurn" }); // p0's next turn starts: expires
    expect(hasKeyword(warden, "Defender")).toBe(false);
  });
});

describe("Steelforged Avatar (Forge: buff per Alloyin card in hand)", () => {
  it("gets +1/+1 for each Alloyin card in hand and has Armor 1", () => {
    const g = gameWith("steelforged-avatar");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const self = g.state.players[0].lanes[0]!;
    expect(self.attack).toBe(7); // 3 + 4 (four other Alloyin cards in hand)
    expect(self.health).toBe(7);
    expect(keywordValue(self, "Armor")).toBe(1);
  });
});

describe("Steelshaper Savant (cardPlayed: level-gated Alloyin Armor grant)", () => {
  it("L2 offers Armor 2 to a friendly creature when you play a level 1 Alloyin card", () => {
    const g = gameWith("energy-surge");
    spawnCreature(g, [], 0, "steelshaper-savant", 2, { lane: 0 });
    const savant = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 }); // energy-surge L1 (Alloyin)
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([savant.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: savant.uid });
    expect(keywordValue(savant, "Armor")).toBe(2);
  });
});

describe("Synapsis Oracle (Activate: discard and level up)", () => {
  it("discards a card from hand and puts a leveled copy in the discard", () => {
    const g = gameWith("synapsis-oracle");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    applyAction(g, { type: "activate", uid: g.state.players[0].lanes[0]!.uid });
    expect(g.state.pending!.request.kind).toBe("cardInHand");
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(4);
    expect(p0.discard.filter((c) => c.level === 1).length).toBeGreaterThanOrEqual(5); // 4 end-turn + 1 activate
    expect(p0.discard.filter((c) => c.level === 2).length).toBeGreaterThanOrEqual(2); // play + activate
  });
});

describe("Tech Upgrade (friendly Robot buff)", () => {
  it("gives a friendly Robot +4 attack and Armor 2", () => {
    const mixed = [...Array(15).fill("tech-upgrade"), ...Array(15).fill("matrix-warden")] as string[];
    const g = createGame(cards, mixed, deckOf("cavern-hydra"), 7);
    let done = false;
    for (let t = 0; t < 12 && !done; t++) {
      const hand = g.state.players[0].hand;
      const mi = hand.findIndex((c) => c.defId === "matrix-warden" && c.level === 1);
      const ti = hand.findIndex((c) => c.defId === "tech-upgrade" && c.level === 1);
      if (mi >= 0 && ti >= 0) {
        applyAction(g, { type: "playCard", handIndex: mi, lane: 0 });
        const warden = g.state.players[0].lanes[0]!;
        // Matrix Warden's own Forge: +3 attack to itself
        applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: warden.uid });
        const ti2 = g.state.players[0].hand.findIndex((c) => c.defId === "tech-upgrade" && c.level === 1);
        applyAction(g, { type: "playCard", handIndex: ti2 });
        applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: warden.uid });
        expect(warden.attack).toBe(10); // 3 + 3 (Forge) + 4 (Tech Upgrade)
        expect(keywordValue(warden, "Armor")).toBe(2);
        done = true;
      } else {
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        endRound(g);
      }
    }
    expect(done).toBe(true);
  });
});

describe("Technosmith (Forge: optional discard and level up)", () => {
  it("discards and levels up a card when accepted", () => {
    const g = gameWith("technosmith");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending!.request.optional).toBe(true);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3);
    expect(p0.discard.filter((c) => c.level === 1)).toHaveLength(1);
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play + Forge
  });

  it("does nothing when declined", () => {
    const g = gameWith("technosmith");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(4);
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(1); // from playing only
  });
});

describe("Vault Technician (vanilla)", () => {
  it("plays as a plain 6/3", () => {
    const g = gameWith("vault-technician");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    const self = g.state.players[0].lanes[0]!;
    expect(self.attack).toBe(6);
    expect(self.health).toBe(3);
  });
});

describe("Warmonger Mod (double attack)", () => {
  it("doubles a level 2-or-lower creature's attack", () => {
    const g = withEnemyHydra(gameWith("warmonger-mod"));
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[2]!;
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(8); // 4 × 2
  });
});
