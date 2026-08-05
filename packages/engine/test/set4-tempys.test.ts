import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, getCardScript, getStats, grantKeyword, hasKeyword,
  keywordValue, loadCards, refreshStatics, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set4 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.json", import.meta.url), "utf8")) as ScrapedSet;
const set41 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set42 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet;
const set31 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set4, set41, set42, set3, set31, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "technognome", startingHealth?: number): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7,
    startingHealth === undefined ? {} : { startingHealth });
}

/** Inject extra cards into a hand (level-gated plays, Dinosaur support). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "borean-windweaver", "brimstone-tyrant", "chant-of-dragonwatch", "firelight-hunter",
  "lavafused-asir", "saberfang", "sparksoul", "staff-of-vaerus", "stormspear",
  "thranik-ambusher", "totembound-berserker", "uranti-elementalist", "violent-outburst",
  "ator-thunder-titan", "rumblestone-elemental", "lug-uranti-charger", "thunderstomp",
];

describe("Set 4 Tempys registration", () => {
  it("all 17 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Ator, Thunder Titan (friendly Forges get Assault: Aggressive)", () => {
  it("grants Aggressive to a level-capped friendly creature Forged unopposed", () => {
    const g = gameWith("ator-thunder-titan");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    addToHand(g, 0, "technognome");
    applyAction(g, { type: "playCard", handIndex: 4, lane: 2 }); // unopposed Forge
    const gnome = g.state.players[0].lanes[2]!;
    expect(hasKeyword(gnome, "Aggressive")).toBe(true);
    expect(hasKeyword(g.state.players[0].lanes[0]!, "Aggressive")).toBe(false); // Ator itself unaffected
  });

  it("does not grant when the Forge is opposed or above the level cap", () => {
    const g = gameWith("ator-thunder-titan");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 3 });
    addToHand(g, 0, "technognome");
    applyAction(g, { type: "playCard", handIndex: 4, lane: 3 }); // opposed Forge
    expect(hasKeyword(g.state.players[0].lanes[3]!, "Aggressive")).toBe(false);
    endRound(g);
    addToHand(g, 0, "technognome", 2); // above Ator L1's level-1 cap
    const hi = g.state.players[0].hand.findIndex((c) => c.defId === "technognome" && c.level === 2);
    applyAction(g, { type: "playCard", handIndex: hi, lane: 4 }); // unopposed, but too high a level
    expect(hasKeyword(g.state.players[0].lanes[4]!, "Aggressive")).toBe(false);
  });
});

describe("Borean Windweaver (Mobility aura for other friendly creatures)", () => {
  it("grants Mobility 1 to other friendly creatures only", () => {
    const g = gameWith("borean-windweaver");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 4 });
    const weaver = g.state.players[0].lanes[2]!;
    const friend = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[4]!;
    refreshStatics(g);
    expect(keywordValue(friend, "Mobility")).toBe(1);
    expect(keywordValue(weaver, "Mobility")).toBe(1); // inherent only — the aura skips itself
    expect(keywordValue(foe, "Mobility")).toBe(0);
  });
});

describe("Brimstone Tyrant (Upgrade: N damage to each other creature)", () => {
  it("does nothing when played into an empty space", () => {
    const g = gameWith("brimstone-tyrant");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes[0]!.damage).toBe(0);
  });

  it("blasts every other creature when it replaces a creature", () => {
    const g = gameWith("brimstone-tyrant");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // replace -> Upgrade
    const tyrant = g.state.players[0].lanes[2]!;
    expect(g.state.players[0].lanes[0]!.damage).toBe(4);
    expect(g.state.players[1].lanes[1]!.damage).toBe(4);
    expect(tyrant.damage).toBe(0); // "each OTHER creature"
    expect(g.state.players[0].discard.some((i) => i.defId === "brimstone-tyrant")).toBe(true);
  });
});

describe("Chant of Dragonwatch (X = your Rank to each enemy creature)", () => {
  it("deals damage equal to your rank to each enemy creature", () => {
    const g = gameWith("chant-of-dragonwatch");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[0]!.damage).toBe(2);
    expect(g.state.players[1].lanes[1]!.damage).toBe(2);
  });
});

describe("Firelight Hunter (Assault: N damage to an enemy creature)", () => {
  it("deals 4 to a chosen enemy creature when unopposed", () => {
    const g = gameWith("firelight-hunter");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // unopposed
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([foe.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(4);
  });

  it("does not trigger when opposed", () => {
    const g = gameWith("firelight-hunter");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].lanes[2]!.damage).toBe(0);
  });
});

describe("Lavafused Asir (unopposed friendly creatures get +N attack)", () => {
  it("buffs unopposed friendly creatures, itself included", () => {
    const g = gameWith("lavafused-asir");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // unopposed
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // opposes the gnome
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 }); // unopposed enemy
    const asir = g.state.players[0].lanes[2]!;
    const gnome = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[1]!;
    expect(getStats(g, asir).attack).toBe(6); // 3 + 3
    expect(getStats(g, gnome).attack).toBe(3); // opposed: no bonus
    expect(getStats(g, foe).attack).toBe(3); // enemy side: no bonus
  });
});

describe("Lug, Uranti Charger (friendly move on your turn: extra battle)", () => {
  it("grants an extra battle when another friendly creature moves, and when Lug moves", () => {
    const g = gameWith("lug-uranti-charger");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    const lug = g.state.players[0].lanes[0]!;
    const gnome = g.state.players[0].lanes[1]!;
    grantKeyword([], gnome, { keyword: "Mobility", value: 1 });
    grantKeyword([], lug, { keyword: "Mobility", value: 1 });
    endRound(g);
    expect(g.state.battlesLeft).toBe(1);
    applyAction(g, { type: "move", uid: gnome.uid, lane: 2 });
    expect(g.state.battlesLeft).toBe(2);
    applyAction(g, { type: "move", uid: lug.uid, lane: 1 }); // Lug's own move counts
    expect(g.state.battlesLeft).toBe(3);
  });
});

describe("Rumblestone Elemental (self-sting; Assault: fill the board)", () => {
  it("Assault fills every open space with a copy", () => {
    const g = gameWith("rumblestone-elemental");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const lanes = g.state.players[0].lanes;
    expect(lanes.every((c) => c?.defId === "rumblestone-elemental")).toBe(true);
  });

  it("does not multiply when opposed", () => {
    const g = gameWith("rumblestone-elemental");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const stones = g.state.players[0].lanes.filter((c) => c?.defId === "rumblestone-elemental");
    expect(stones).toHaveLength(1);
  });

  it("deals battle damage to itself when it hits a player", () => {
    const g = gameWith("rumblestone-elemental", "technognome", 100);
    spawnCreature(g, [], 0, "rumblestone-elemental", 1, { lane: 2 }); // Spawned: no Assault
    endRound(g);
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(98); // 2 to the player
    expect(g.state.players[0].lanes[2]).toBeNull(); // 2 to itself kills the 2/1
  });
});

describe("Saberfang (battles an additional time on your turn)", () => {
  it("grants an extra battle action at the start of your turn", () => {
    const g = gameWith("saberfang");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.battlesLeft).toBe(1);
    endRound(g);
    expect(g.state.battlesLeft).toBe(2);
  });
});

describe("Sparksoul (Upgrade: gets Aggressive)", () => {
  it("gains Aggressive only when it replaces a creature", () => {
    const g = gameWith("sparksoul");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const first = g.state.players[0].lanes[2]!;
    expect(hasKeyword(first, "Aggressive")).toBe(false); // empty space: no Upgrade
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // replace -> Upgrade
    const second = g.state.players[0].lanes[2]!;
    expect(second.uid).not.toBe(first.uid);
    expect(hasKeyword(second, "Aggressive")).toBe(true);
  });
});

describe("Staff of Vaerus (L1/L2 spell, L3 creature)", () => {
  it("L1: grants Mobility 1 and an extra battle to a level 2 or lower friendly creature", () => {
    const g = gameWith("staff-of-vaerus");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 3, { lane: 1 }); // above the L1 level gate
    const [gnome, big] = [g.state.players[0].lanes[0]!, g.state.players[0].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0 }); // a spell at L1: no lane
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([gnome.uid]); // L3 creature gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(keywordValue(gnome, "Mobility")).toBe(1);
    expect(keywordValue(big, "Mobility")).toBe(0);
    expect(g.state.battlesLeft).toBe(2); // "battles an additional time this turn"
  });

  it("L3: enters play as a 15/12 with Mobility 2 and grants an extra battle each of your turns", () => {
    const g = gameWith("staff-of-vaerus");
    addToHand(g, 0, "staff-of-vaerus", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // a creature at L3
    const staff = g.state.players[0].lanes[2]!;
    expect(staff.defId).toBe("staff-of-vaerus");
    expect([staff.attack, staff.health]).toEqual([15, 12]);
    expect(keywordValue(staff, "Mobility")).toBe(2);
    endRound(g);
    expect(g.state.battlesLeft).toBe(2);
  });
});

describe("Stormspear (N damage to a creature + extra play)", () => {
  it("deals 3 to a chosen creature and refunds the play", () => {
    const g = gameWith("stormspear");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(3);
    expect(g.state.playsLeft).toBe(2); // 2 - 1 + 1 extra play
  });
});

describe("Thranik Ambusher (Assault: +N/+N)", () => {
  it("gets +2/+2 when unopposed", () => {
    const g = gameWith("thranik-ambusher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const t = g.state.players[0].lanes[2]!;
    expect([t.attack, t.health]).toEqual([7, 7]);
  });

  it("stays 5/5 when opposed", () => {
    const g = gameWith("thranik-ambusher");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const t = g.state.players[0].lanes[2]!;
    expect([t.attack, t.health]).toEqual([5, 5]);
  });
});

describe("Totembound Berserker (Assault: drag an enemy creature in front of it)", () => {
  it("moves a chosen enemy creature into the opposing space, level-gated", () => {
    const g = gameWith("totembound-berserker");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 2, { lane: 1 }); // above the L1 level-1 gate
    const [g1, g2] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 }); // unopposed
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([g1.uid]); // the L2 creature is gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: g1.uid });
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[3]!.uid).toBe(g1.uid); // dragged in front of the berserker
    expect(g.state.players[1].lanes[1]!.uid).toBe(g2.uid); // untouched
  });

  it("does nothing when declined or when opposed", () => {
    const g = gameWith("totembound-berserker");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false }); // decline
    expect(g.state.players[1].lanes[0]!.uid).toBe(foe.uid); // stayed put

    const g2 = gameWith("totembound-berserker");
    spawnCreature(g2, [], 1, "technognome", 1, { lane: 3 });
    applyAction(g2, { type: "playCard", handIndex: 0, lane: 3 }); // opposed
    expect(g2.state.pending).toBeNull();
  });
});

describe("Uranti Elementalist (Forge: move a friendly creature adjacent)", () => {
  it("moves another friendly creature to an available adjacent space", () => {
    const g = gameWith("uranti-elementalist");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    const gnome = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([gnome.uid]); // itself excluded
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect([1, 3]).toContain(gnome.lane); // an open space adjacent to lane 2
  });
});

describe("Violent Outburst (Aggressive + battle-damage self-sting)", () => {
  it("grants Aggressive and makes the creature damage itself after hitting a player", () => {
    const g = gameWith("violent-outburst", "technognome", 100);
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "technognome", 3, { lane: 0 }); // above the L1 level gate
    const hydra = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([hydra.uid]); // the L3 creature is gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Aggressive")).toBe(true);
    applyAction(g, { type: "battle" }); // Aggressive: the fresh hydra can attack
    expect(g.state.players[1].health).toBe(96); // 4 to the player
    expect(hydra.damage).toBe(4); // and 4 to itself
  });
});

describe("Thunderstomp (N to an enemy, then another N with a friendly Dinosaur)", () => {
  it("chains a second hit when a friendly Dinosaur is in play", () => {
    const g = gameWith("thunderstomp");
    spawnCreature(g, [], 0, "crag-walker", 1, { lane: 2 }); // friendly Dinosaur
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const [h0, h1] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: h0.uid });
    expect(h0.damage).toBe(5);
    const req2 = g.state.pending!.request; // chained second target
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([h0.uid, h1.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: h1.uid });
    expect(h1.damage).toBe(5);
    expect(g.state.pending).toBeNull();
  });

  it("stops after the first hit without a friendly Dinosaur", () => {
    const g = gameWith("thunderstomp");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(5);
    expect(g.state.pending).toBeNull(); // no second prompt
  });
});
