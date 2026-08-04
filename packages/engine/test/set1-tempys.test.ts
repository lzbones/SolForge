/** Set 1 Tempys card behavior tests — loads real scraped data. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getStats, hasKeyword, loadCards, runBatches, spawnCreature,
  type Game, type GameEvent, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** p0 passes, p1 plays a cavern-hydra in `lane`, back to p0. */
function enemyHydra(g: Game, lane: number) {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "playCard", handIndex: 0, lane });
  applyAction(g, { type: "endTurn" });
}

function choose(g: Game, targetUid: number, accepted = true) {
  applyChoice(g, { id: g.state.pending!.request.id, accepted, targetUid });
}

describe("Magma Hound (Forge: optional enemy burn)", () => {
  it("burns when accepted, does nothing when declined", () => {
    const g = gameWith("magma-hound");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // no enemies -> no prompt
    expect(g.state.pending).toBeNull();
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // hound #2
    expect(g.state.pending).not.toBeNull();
    const hydra = g.state.players[1].lanes[2]!;
    choose(g, hydra.uid);
    expect(hydra.damage).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 }); // hound #3 -> decline
    expect(g.state.pending).not.toBeNull();
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(hydra.damage).toBe(2);
  });
});

describe("Cinderfist Brawler (battle damage to a player is doubled)", () => {
  it("deals its battle damage to the player again", () => {
    const g = gameWith("cinderfist-brawler");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 7/3
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra (defensive, won't fight back)
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // brawler hits face for 7, trigger deals 7 again
    expect(g.state.players[1].health).toBe(120 - 14);
  });
});

describe("Flameblade Champion (battle damage to a player sweeps their creatures)", () => {
  it("deals the same damage to each creature the defending player controls", () => {
    const g = gameWith("flameblade-champion");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 }); // 4/5
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // champion hits face for 4, then 4 to each p1 creature
    expect(g.state.players[1].health).toBe(116);
    expect(g.state.players[1].lanes[0]!.damage).toBe(4);
    expect(g.state.players[1].lanes[1]!.damage).toBe(4);
  });
});

describe("Flame Speaker (spellPlayed: burn the enemy player)", () => {
  it("deals 2 damage to the enemy player each time you play a spell", () => {
    const g = gameWith("energy-surge");
    spawnCreature(g, [], 0, "flame-speaker", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // untargeted trigger
    expect(g.state.players[1].health).toBe(118);
    applyAction(g, { type: "playCard", handIndex: 0 }); // second spell burns again
    expect(g.state.players[1].health).toBe(116);
  });
});

describe("Flameshaper Savant (cardPlayed: level-gated Tempys burn)", () => {
  it("L2 may deal 4 to a creature or player when you play a level 1 Tempys card", () => {
    const g = gameWith("iceborn-fortitude");
    spawnCreature(g, [], 0, "flameshaper-savant", 2, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 }); // iceborn-fortitude L1 (Tempys)
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.kind).toBe("anyCreatureOrPlayer");
    expect(req.options).toContain(hydra.uid);
    choose(g, hydra.uid);
    expect(hydra.damage).toBe(4);
  });
});

describe("Rageborn Hellion (friendly battle damage to a player: +1/+1)", () => {
  it("grows from its own hits and from other friendly creatures' hits", () => {
    const g = gameWith("rageborn-hellion");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/8
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 4/8
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // both hit face for 4, unopposed
    const a = g.state.players[0].lanes[0]!;
    const b = g.state.players[0].lanes[1]!;
    // each grows +1/+1 from its own hit and +1/+1 from the other's
    expect([a.attack, a.health]).toEqual([6, 10]);
    expect([b.attack, b.health]).toEqual([6, 10]);
    expect(g.state.players[1].health).toBe(112);
  });
});

describe("Riftlasher (battle damage to a player on your turn -> enemy creature)", () => {
  it("deals the same amount to a chosen enemy creature", () => {
    const g = gameWith("riftlasher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 3/6
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // hits face for 3, prompt for the lash
    expect(g.state.pending).not.toBeNull();
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(hydra.damage).toBe(3);
    expect(g.state.players[1].health).toBe(117);
  });
});

describe("Disintegrate (random 1-8 to the enemy player)", () => {
  it("deals between 1 and 8 damage", () => {
    const g = gameWith("disintegrate");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const dmg = 120 - g.state.players[1].health;
    expect(dmg).toBeGreaterThanOrEqual(1);
    expect(dmg).toBeLessThanOrEqual(8);
  });
});

describe("Firestorm (5 damage to each creature)", () => {
  it("damages every creature on both sides", () => {
    const g = gameWith("firestorm");
    enemyHydra(g, 1);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[1]!.damage).toBe(5);
  });
});

describe("Spiritflame Mystic (Vengeance: 2 damage to each creature)", () => {
  it("burns every creature when destroyed", () => {
    const g = gameWith("spiritflame-mystic");
    const ev: GameEvent[] = [];
    const m = spawnCreature(g, ev, 0, "spiritflame-mystic", 1, { lane: 0 })!;
    const h = spawnCreature(g, ev, 1, "cavern-hydra", 1, { lane: 1 })!;
    const items = collectInto(() => destroyCreature(g, ev, m));
    runBatches(g, ev, items);
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(h.damage).toBe(2);
  });
});

describe("Pyre Giant (+4 attack while unopposed)", () => {
  it("gains attack only while the opposing space is empty", () => {
    const g = gameWith("pyre-giant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/2
    const giant = g.state.players[0].lanes[0]!;
    expect(getStats(g, giant).attack).toBe(8);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra opposes it
    expect(getStats(g, giant).attack).toBe(4);
  });
});

describe("Storm Bringer (drifts at each turn start; Flank)", () => {
  it("moves at the start of each turn and burns the opposing creature it lands on", () => {
    const g = gameWith("storm-bringer", "ashurian-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5/6
    const bringer = g.state.players[0].lanes[2]!;
    let flankHits = 0;
    let drifted = false;
    for (let i = 0; i < 5; i++) {
      const evs = applyAction(g, { type: "endTurn" });
      for (const e of evs) {
        if (e.type === "moved" && e.uid === bringer.uid) {
          drifted = true;
          if (e.to === 0) flankHits++; // landed opposing the mystic -> Flank for 2
        }
      }
      if (i === 0) applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 mystic 3/5
    }
    expect(drifted).toBe(true);
    const m = g.state.players[1].lanes[0];
    if (m) expect(m.damage).toBe(2 * flankHits);
    else expect(2 * flankHits).toBeGreaterThanOrEqual(5); // burned to death
  });
});

describe("Abraxas, Avatar of Kadras (Activate: double an adjacent creature's attack)", () => {
  it("gives an adjacent creature +X attack this turn, X = its attack", () => {
    const g = gameWith("abraxas-avatar-of-kadras");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // A 4/7
    enemyHydra(g, 4);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // B 4/7
    const a = g.state.players[0].lanes[0]!;
    const b = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: a.uid });
    expect(g.state.pending).not.toBeNull();
    choose(g, b.uid);
    expect(getStats(g, b).attack).toBe(8); // 4 + 4
    applyAction(g, { type: "endTurn" }); // temp buff wears off
    expect(getStats(g, b).attack).toBe(4);
  });
});

describe("Uranti Cryomancer (Activate: 1 damage to a creature)", () => {
  it("pings a chosen creature", () => {
    const g = gameWith("uranti-cryomancer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    enemyHydra(g, 0);
    const cryo = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "activate", uid: cryo.uid });
    expect(g.state.pending).not.toBeNull();
    choose(g, hydra.uid);
    expect(hydra.damage).toBe(1);
    expect(cryo.activatedThisTurn).toBe(true);
  });
});

describe("Seismic Adept (Activate: move an enemy creature)", () => {
  it("moves the chosen enemy creature to another enemy space", () => {
    const g = gameWith("seismic-adept");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    enemyHydra(g, 0);
    const adept = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "activate", uid: adept.uid });
    choose(g, hydra.uid);
    expect(hydra.lane).not.toBe(0);
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[hydra.lane]?.uid).toBe(hydra.uid);
  });
});

describe("Static Shock (1 damage + an additional spell this turn)", () => {
  it("damages the target and refunds the play", () => {
    const g = gameWith("static-shock");
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).not.toBeNull();
    choose(g, -2); // player 1
    expect(g.state.players[1].health).toBe(119);
    expect(g.state.playsLeft).toBe(2); // 2 - 1 (this spell) + 1 (bonus)
  });
});

describe("Call the Lightning (battle an additional time)", () => {
  it("grants a second battle this turn", () => {
    const g = gameWith("call-the-lightning");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.battlesLeft).toBe(2);
    applyAction(g, { type: "battle" });
    expect(g.state.battlesLeft).toBe(1);
    applyAction(g, { type: "battle" });
    expect(g.state.battlesLeft).toBe(0);
    expect(() => applyAction(g, { type: "battle" })).toThrow();
  });
});

describe("Zyx, Storm Herald (battles an additional time on your turn)", () => {
  it("grants an extra battle from your next turn on", () => {
    const g = gameWith("zyx-storm-herald");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.battlesLeft).toBe(1);
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "endTurn" }); // p0 turn start
    expect(g.state.battlesLeft).toBe(2);
  });
});

describe("Avalanche Invoker (Rank up: 3 damage to each non-Tempys creature)", () => {
  it("hits every non-Tempys creature when its controller gains a rank", () => {
    const g = gameWith("avalanche-invoker");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 6/7 Tempys
    for (let i = 0; i < 7; i++) {
      applyAction(g, { type: "endTurn" });
      if (g.state.active === 1 && i < 6) { // no plays after p0's rank-up turn
        const lane = g.state.players[1].lanes.findIndex((l) => !l);
        applyAction(g, { type: "playCard", handIndex: 0, lane }); // p1 hydra
      }
    }
    // p0's 4th endTurn: rank up -> 3 damage to each non-Tempys creature.
    // (Hydra's Regenerate 1 heals 1 at p1's turn start, which already ran by
    // assertion time: damage is 3 fresh / 2 after healing.)
    for (const c of g.state.players[1].lanes) if (c) expect([2, 3]).toContain(c.damage);
    expect(g.state.players[0].lanes[0]!.damage).toBe(0); // Tempys: untouched
  });
});

describe("Everflame Phoenix (L2 -> L3 on rank up; L3 Vengeance -> L2)", () => {
  it("is replaced by a level 3 copy when its controller gains a rank", () => {
    const g = gameWith("everflame-phoenix");
    const ev: GameEvent[] = [];
    spawnCreature(g, ev, 0, "everflame-phoenix", 2, { lane: 0 });
    for (let i = 0; i < 7; i++) applyAction(g, { type: "endTurn" });
    const c = g.state.players[0].lanes[0];
    expect(c?.defId).toBe("everflame-phoenix");
    expect(c?.level).toBe(3);
    expect(c?.attack).toBe(22);
  });

  it("puts a level 2 copy into its space when destroyed at level 3", () => {
    const g = gameWith("everflame-phoenix");
    const ev: GameEvent[] = [];
    const c = spawnCreature(g, ev, 0, "everflame-phoenix", 3, { lane: 1 })!;
    const items = collectInto(() => destroyCreature(g, ev, c));
    runBatches(g, ev, items);
    const c2 = g.state.players[0].lanes[1];
    expect(c2?.defId).toBe("everflame-phoenix");
    expect(c2?.level).toBe(2);
  });
});

describe("Stormforged Avatar (Forge: +1/+1 per Tempys card in hand)", () => {
  it("gets +4/+4 with four Tempys cards in hand", () => {
    const g = gameWith("stormforged-avatar");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/3
    const a = g.state.players[0].lanes[0]!;
    expect(a.attack).toBe(7);
    expect(a.health).toBe(7);
  });
});

describe("Nargath Bruiser (Forge: give a friendly creature +2 health)", () => {
  it("can target itself", () => {
    const g = gameWith("nargath-bruiser");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 5/4
    expect(g.state.pending).not.toBeNull();
    const self = g.state.players[0].lanes[0]!;
    choose(g, self.uid);
    expect(self.health).toBe(6);
  });
});

describe("Scorchmane Dragon L2 (Forge: 5 damage to the opposing creature)", () => {
  it("blasts the creature opposing it", () => {
    const g = gameWith("scorchmane-dragon");
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    const ev: GameEvent[] = [];
    const items = collectInto(() => spawnCreature(g, ev, 0, "scorchmane-dragon", 2, { lane: 2, fromHand: true }));
    runBatches(g, ev, items);
    expect(g.state.players[1].lanes[2]!.damage).toBe(5);
  });
});

describe("Windcaller Shaman (Forge: move a friendly creature adjacent)", () => {
  it("pulls another friendly creature next to itself", () => {
    const g = gameWith("windcaller-shaman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // shaman #1 (alone: no prompt)
    expect(g.state.pending).toBeNull();
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // shaman #2
    expect(g.state.pending).not.toBeNull();
    const first = g.state.players[0].lanes[0]!;
    choose(g, first.uid);
    expect([1, 3]).toContain(first.lane); // adjacent to lane 2
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[0].lanes[first.lane]?.uid).toBe(first.uid);
  });
});

describe("Fervent Assault (Mobility 1 + granted Flank)", () => {
  it("granted Flank triggers when the creature moves", () => {
    const g = gameWith("fervent-assault");
    const ev: GameEvent[] = [];
    spawnCreature(g, ev, 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 }); // fervent L1
    const hydra0 = g.state.players[0].lanes[2]!;
    choose(g, hydra0.uid);
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 }); // p1 hydra
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "move", uid: hydra0.uid, lane: 3 }); // Mobility 1 -> flank 3
    expect(g.state.players[1].lanes[3]!.damage).toBe(3);
  });
});

describe("Asir's Blessing (granted: +1/+1 on battle damage to a player)", () => {
  it("grows the blessed creature when it hits a player", () => {
    const g = gameWith("asirs-blessing");
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0 }); // blessing on the hydra
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(hydra.grantedAbilities).toContain("tempys:asir-1");
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" }); // hydra hits face for 4 -> +1/+1
    expect(g.state.players[0].health).toBe(116);
    expect(hydra.attack).toBe(5);
    expect(hydra.health).toBe(8);
  });
});

describe("Lightning Brand (+1 attack and Aggressive this turn)", () => {
  it("wears off at end of turn", () => {
    const g = gameWith("lightning-brand");
    enemyHydra(g, 0);
    applyAction(g, { type: "playCard", handIndex: 0 }); // brand L1 on the hydra
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(getStats(g, hydra).attack).toBe(5);
    expect(hasKeyword(hydra, "Aggressive")).toBe(true);
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, hydra).attack).toBe(4);
    expect(hasKeyword(hydra, "Aggressive")).toBe(false);
  });
});

describe("Volcanic Giant (start of your turn: 1-4 damage to the enemy player)", () => {
  it("erupts at the start of its controller's turn", () => {
    const g = gameWith("volcanic-giant");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" }); // p1
    applyAction(g, { type: "endTurn" }); // p0 turn start: erupt
    const dmg = 120 - g.state.players[1].health;
    expect(dmg).toBeGreaterThanOrEqual(1);
    expect(dmg).toBeLessThanOrEqual(4);
  });
});

describe("Master of Elements L2 (Forge: play an additional spell)", () => {
  it("grants an extra play when it enters from hand", () => {
    const g = gameWith("master-of-elements");
    expect(g.state.playsLeft).toBe(2);
    const ev: GameEvent[] = [];
    const items = collectInto(() => spawnCreature(g, ev, 0, "master-of-elements", 2, { lane: 0, fromHand: true }));
    runBatches(g, ev, items);
    expect(g.state.playsLeft).toBe(3);
  });
});

describe("Frozen Solid (granted: when dealt damage, destroy it)", () => {
  it("destroys the enchanted creature the next time it takes damage", () => {
    const g = gameWith("frozen-solid");
    enemyHydra(g, 0);
    applyAction(g, { type: "playCard", handIndex: 0 }); // frozen solid L1 on the hydra
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(hydra.grantedAbilities).toContain("tempys:frozen-solid");
    const ev: GameEvent[] = [];
    const items = collectInto(() => dealCreatureDamage(g, ev, hydra, 1));
    runBatches(g, ev, items);
    expect(g.state.players[1].lanes[0]).toBeNull();
  });
});

describe("Uranti Bolt (3 damage + Defender until your next turn)", () => {
  it("Defender lasts through the opponent's turn, then expires", () => {
    const g = gameWith("uranti-bolt");
    enemyHydra(g, 0);
    applyAction(g, { type: "playCard", handIndex: 0 }); // bolt L1
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(hydra.damage).toBe(3);
    expect(hasKeyword(hydra, "Defender")).toBe(true);
    applyAction(g, { type: "endTurn" }); // p1's turn: still Defender
    expect(hasKeyword(hydra, "Defender")).toBe(true);
    applyAction(g, { type: "endTurn" }); // p0's next turn starts: expires
    expect(hasKeyword(hydra, "Defender")).toBe(false);
  });
});

describe("Primordial Slam (+7 attack this turn)", () => {
  it("gives the target +7 attack until end of turn", () => {
    const g = gameWith("primordial-slam");
    enemyHydra(g, 0);
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(getStats(g, hydra).attack).toBe(11); // 4 + 7
  });
});

describe("Aquatic Embrace (+5 health)", () => {
  it("gives the target +5 health", () => {
    const g = gameWith("aquatic-embrace");
    enemyHydra(g, 0);
    applyAction(g, { type: "playCard", handIndex: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    choose(g, hydra.uid);
    expect(hydra.health).toBe(12); // 7 + 5
  });
});

describe("Iceborn Fortitude (each friendly creature gets +3 health)", () => {
  it("buffs every friendly creature", () => {
    const g = gameWith("iceborn-fortitude");
    const ev: GameEvent[] = [];
    spawnCreature(g, ev, 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, ev, 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes[0]!.health).toBe(10); // 7 + 3
    expect(g.state.players[0].lanes[1]!.health).toBe(10);
  });
});

describe("Flamestoke Shaman (Activate: give an adjacent level 1 creature Aggressive)", () => {
  it("grants Aggressive to an adjacent creature", () => {
    const g = gameWith("flamestoke-shaman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // shaman A
    enemyHydra(g, 4);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // shaman B
    const a = g.state.players[0].lanes[1]!;
    const b = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: a.uid });
    expect(g.state.pending).not.toBeNull();
    choose(g, b.uid);
    expect(hasKeyword(b, "Aggressive")).toBe(true);
  });
});
