import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, destroyCreature, getStats, hasKeyword, keywordValue,
  loadCards, refreshStatics, runBatches, spawnCreature,
  type Game, type ScrapedSet,
} from "../src/index.js";

const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "technognome"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

describe("Aetherguard (gains Armor when you play a spell)", () => {
  it("gets stacking Armor 1 per spell played", () => {
    const g = gameWith("digitize");
    spawnCreature(g, [], 0, "aetherguard", 1, { lane: 0 });
    const guard = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 }); // digitize L1
    expect(keywordValue(guard, "Armor")).toBe(1);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(guard, "Armor")).toBe(2);
  });
});

describe("Alloyin Strategist (adjacent attack aura)", () => {
  it("buffs only friendly creatures in adjacent lanes", () => {
    const g = gameWith("alloyin-strategist");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 });
    const p0 = g.state.players[0];
    expect(getStats(g, p0.lanes[1]!).attack).toBe(6); // 4 + 2 from lane 2
    expect(getStats(g, p0.lanes[2]!).attack).toBe(6); // 4 + 2 from lane 1
    expect(getStats(g, p0.lanes[4]!).attack).toBe(4); // no adjacent ally
    expect(keywordValue(p0.lanes[2]!, "Mobility")).toBe(1); // inherent Mobility 1
  });
});

describe("Apocrymancer (Alloyin spell -> optional discard and level up)", () => {
  it("offers a discard+level when you play an Alloyin spell", () => {
    const g = gameWith("digitize");
    spawnCreature(g, [], 0, "apocrymancer", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3);
    expect(p0.discard.filter((c) => c.level === 1)).toHaveLength(2); // played + discarded
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // both leveled copies
  });

  it("does not trigger on a non-Alloyin spell", () => {
    const g = gameWith("dissolve"); // Uterra spell (unscripted)
    spawnCreature(g, [], 0, "apocrymancer", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
  });

  it("does nothing when declined", () => {
    const g = gameWith("digitize");
    spawnCreature(g, [], 0, "apocrymancer", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(g.state.players[0].hand).toHaveLength(4);
  });
});

describe("Crucible Colossus (loses Defender when you gain a Rank)", () => {
  it("has Defender until its controller ranks up", () => {
    const g = gameWith("crucible-colossus");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const colossus = g.state.players[0].lanes[0]!;
    expect(hasKeyword(colossus, "Defender")).toBe(true);
    for (let t = 0; t < 4; t++) endRound(g);
    expect(g.state.players[0].rank).toBe(2);
    expect(hasKeyword(colossus, "Defender")).toBe(false);
  });
});

describe("Cypien Steelgraft (two friendly creatures get Armor)", () => {
  it("chains two friendly-creature choices and grants Armor 2 to each", () => {
    const g = gameWith("cypien-steelgraft");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    const [t0, t1] = [g.state.players[0].lanes[0]!, g.state.players[0].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([t0.uid, t1.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: t0.uid });
    const req2 = g.state.pending!.request; // chained second prompt
    expect(req2.options).toEqual([t1.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: t1.uid });
    expect(g.state.pending).toBeNull();
    expect(keywordValue(t0, "Armor")).toBe(2);
    expect(keywordValue(t1, "Armor")).toBe(2);
  });
});

describe("Delpha, Chronosculptor (start of turn: level up a random hand card)", () => {
  it("L2 puts a leveled copy of a random level 1 hand card into the discard", () => {
    const g = gameWith("technognome");
    spawnCreature(g, [], 0, "delpha-chronosculptor", 2, { lane: 0 });
    endRound(g); // back to p0: turnStart fires
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(5); // hand untouched
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(1);
    expect(p0.discard.find((c) => c.level === 2)?.defId).toBe("technognome");
  });
});

describe("Digitize (enemy board temp debuff)", () => {
  it("gives each enemy creature −4 attack until end of turn", () => {
    const g = gameWith("digitize");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    const [e0, e2] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[2]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // untargeted
    expect(getStats(g, e0).attack).toBe(-1); // 3 − 4
    expect(getStats(g, e2).attack).toBe(-1);
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, e0).attack).toBe(3); // temp wore off
  });
});

describe("Esperian Scarab (Allied Uterra: optional self-copy)", () => {
  it("puts a copy into another space when accepted with a Uterra card in hand", () => {
    const mixed = [...Array(15).fill("esperian-scarab"), ...Array(15).fill("tanglesprout")] as string[];
    const g = createGame(cards, mixed, deckOf("technognome"), 7);
    let done = false;
    for (let t = 0; t < 12 && !done; t++) {
      const hand = g.state.players[0].hand;
      const si = hand.findIndex((c) => c.defId === "esperian-scarab" && c.level === 1);
      const hasUterra = hand.some((c) => cards[c.defId]?.faction === "Uterra");
      if (si >= 0 && hasUterra) {
        applyAction(g, { type: "playCard", handIndex: si, lane: 0 });
        const req = g.state.pending!.request;
        expect(req.kind).toBe("yesNo");
        expect(req.optional).toBe(true);
        applyChoice(g, { id: req.id, accepted: true });
        const copies = g.state.players[0].lanes.filter((c) => c?.defId === "esperian-scarab");
        expect(copies).toHaveLength(2);
        expect(copies[0]!.lane).not.toBe(copies[1]!.lane);
        done = true;
      } else {
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        endRound(g);
      }
    }
    expect(done).toBe(true);
  });

  it("does not trigger without a Uterra card in hand", () => {
    const g = gameWith("esperian-scarab"); // pure Alloyin deck
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    const copies = g.state.players[0].lanes.filter((c) => c?.defId === "esperian-scarab");
    expect(copies).toHaveLength(1);
  });
});

describe("Ironbeard, Hammer of Anvillon (battle damage: debuff + convert)", () => {
  it("gives the damaged creature −2 attack and moves it to Ironbeard's side", () => {
    const g = gameWith("ironbeard-hammer-of-anvillon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "endTurn" });
    spawnCreature(g, [], 1, "metamind-operator", 1, { lane: 2 }); // 4/10, survives
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    const ironbeard = g.state.players[0].lanes[2]!;
    const moved = g.state.players[0].lanes.find((c) => c?.defId === "metamind-operator");
    expect(moved).toBeDefined();
    expect(moved!.lane).not.toBe(2);
    expect(moved!.owner).toBe(0); // now fights for p0
    expect(moved!.attack).toBe(2); // 4 − 2
    expect(moved!.damage).toBe(4); // took Ironbeard's 4 battle damage
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(ironbeard.damage).toBe(3); // 4 back − Armor 1
  });
});

describe("Metamind Explorer (Vengeance: draw)", () => {
  it("draws a card when destroyed", () => {
    const g = gameWith("metamind-explorer");
    spawnCreature(g, [], 0, "metamind-explorer", 1, { lane: 0 });
    const explorer = g.state.players[0].lanes[0]!;
    destroyCreature(g, [], explorer);
    runBatches(g, [], []);
    expect(g.state.players[0].hand).toHaveLength(6); // 5 + 1 from Vengeance
  });
});

describe("Metatransfer (debuff, then discard and level up)", () => {
  it("chains from creature target to hand discard", () => {
    const g = gameWith("metatransfer");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    const enemy = g.state.players[1].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("anyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: enemy.uid });
    const req2 = g.state.pending!.request; // chained discard prompt
    expect(req2.kind).toBe("cardInHand");
    applyChoice(g, { id: req2.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).toBeNull();
    const p0 = g.state.players[0];
    expect(enemy.attack).toBe(-2); // 3 − 5
    expect(p0.hand).toHaveLength(3); // 5 − played − discarded
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play + effect
  });
});

describe("Nexus Techtician (center-space Armor aura)", () => {
  it("grants Armor 2 to other friendly creatures only from the center", () => {
    const g = gameWith("nexus-techtician");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // center
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const p0 = g.state.players[0];
    refreshStatics(g);
    expect(keywordValue(p0.lanes[0]!, "Armor")).toBe(2);
    expect(keywordValue(p0.lanes[2]!, "Armor")).toBe(0); // does not buff itself
  });
});

describe("Onyxium Marauder (Allied Nekrium: Regenerate)", () => {
  it("gains Regenerate 1 when played with a Nekrium card in hand", () => {
    const mixed = [...Array(15).fill("onyxium-marauder"), ...Array(15).fill("grave-geist")] as string[];
    const g = createGame(cards, mixed, deckOf("technognome"), 7);
    let done = false;
    for (let t = 0; t < 12 && !done; t++) {
      const hand = g.state.players[0].hand;
      const mi = hand.findIndex((c) => c.defId === "onyxium-marauder" && c.level === 1);
      const hasNekrium = hand.some((c) => cards[c.defId]?.faction === "Nekrium");
      if (mi >= 0 && hasNekrium) {
        applyAction(g, { type: "playCard", handIndex: mi, lane: 0 });
        expect(g.state.pending).toBeNull(); // untargeted Forge effect
        const marauder = g.state.players[0].lanes[0]!;
        expect(keywordValue(marauder, "Regenerate")).toBe(1);
        expect(keywordValue(marauder, "Armor")).toBe(1); // inherent
        done = true;
      } else {
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        applyAction(g, { type: "discardToLevel", handIndex: 0 });
        endRound(g);
      }
    }
    expect(done).toBe(true);
  });

  it("does not gain Regenerate without a Nekrium card in hand", () => {
    const g = gameWith("onyxium-marauder"); // pure Alloyin deck
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Regenerate")).toBe(0);
  });
});

describe("Oreian Peacekeeper (Forge: temp Armor)", () => {
  it("gets Armor 4 this turn only", () => {
    const g = gameWith("oreian-peacekeeper");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const self = g.state.players[0].lanes[0]!;
    expect(keywordValue(self, "Armor")).toBe(4);
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(self, "Armor")).toBe(0);
  });
});

describe("Overwhelming Force (friendly board attack buff)", () => {
  it("gives each friendly creature +3 attack", () => {
    const g = gameWith("overwhelming-force");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 3 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes[0]!.attack).toBe(6); // 3 + 3
    expect(g.state.players[0].lanes[3]!.attack).toBe(6);
  });
});

describe("Palladium Hindermind (Forge: enemy board debuff)", () => {
  it("gives each enemy creature −1 attack", () => {
    const g = gameWith("palladium-hindermind");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[2]!.attack).toBe(2); // 3 − 1
  });
});

describe("Sap (reduce attack to 0, level-gated)", () => {
  it("targets only level 1 creatures at L1 and zeroes the attack", () => {
    const g = gameWith("sap");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 2, { lane: 1 });
    const [e0, e1] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toEqual([e0.uid]); // L2 target gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: e0.uid });
    expect(getStats(g, e0).attack).toBe(0);
    expect(getStats(g, e1).attack).toBe(9); // untouched
  });
});

describe("Skyknight Glider (center-space Mobility)", () => {
  it("gets Mobility 2 only while in the center space", () => {
    const g = gameWith("skyknight-glider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const p0 = g.state.players[0];
    refreshStatics(g);
    expect(keywordValue(p0.lanes[2]!, "Mobility")).toBe(2);
    expect(keywordValue(p0.lanes[0]!, "Mobility")).toBe(0);
  });
});

describe("Steelscale Dragon (bonus while all other friendly creatures have Defender)", () => {
  it("keeps the bonus alone or with Defender allies, loses it otherwise", () => {
    const g = gameWith("steelscale-dragon");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const dragon = g.state.players[0].lanes[2]!;
    refreshStatics(g);
    expect(getStats(g, dragon).attack).toBe(8); // 4 + 4 (no other creatures: vacuous)
    expect(keywordValue(dragon, "Armor")).toBe(2);
    expect(hasKeyword(dragon, "Breakthrough")).toBe(true);
    spawnCreature(g, [], 0, "vault-blockade", 1, { lane: 1 }); // Defender ally
    refreshStatics(g);
    expect(getStats(g, dragon).attack).toBe(8);
    spawnCreature(g, [], 0, "technognome", 1, { lane: 3 }); // non-Defender ally
    refreshStatics(g);
    expect(getStats(g, dragon).attack).toBe(4);
    expect(keywordValue(dragon, "Armor")).toBe(0);
    expect(hasKeyword(dragon, "Breakthrough")).toBe(false);
  });
});

describe("Steelwelder Medic (Activate: give another creature Armor)", () => {
  it("gives another creature Armor 1, excluding itself", () => {
    const g = gameWith("steelwelder-medic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    endRound(g);
    const medic0 = g.state.players[0].lanes[0]!;
    const medic1 = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: medic0.uid });
    expect(g.state.pending!.request.options).not.toContain(medic0.uid);
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: medic1.uid });
    expect(keywordValue(medic1, "Armor")).toBe(1);
    expect(keywordValue(medic0, "Armor")).toBe(0);
  });
});

describe("vanilla / keyword-only Alloyin cards", () => {
  it("technognome plays as a plain 3/3", () => {
    const g = gameWith("technognome");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    const self = g.state.players[0].lanes[0]!;
    expect(self.attack).toBe(3);
    expect(self.health).toBe(3);
  });

  it("keyword-only cards carry their parsed keywords", () => {
    const g = gameWith("vault-blockade");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const wall = g.state.players[0].lanes[0]!;
    expect(keywordValue(wall, "Armor")).toBe(10);
    expect(hasKeyword(wall, "Defender")).toBe(true);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // second play: tower-scout? no — vault-blockade again
  });

  it("anvillon-enforcer and tower-scout need no script", () => {
    const g = gameWith("anvillon-enforcer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(2);
    const g2 = gameWith("tower-scout");
    applyAction(g2, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g2.state.players[0].lanes[0]!, "Mobility")).toBe(1);
  });
});
