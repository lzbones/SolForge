import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealPlayerDamage, getCardScript, getStats,
  grantKeyword, keywordValue, loadCards, refreshStatics, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set5 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.json", import.meta.url), "utf8")) as ScrapedSet;
const set51 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set52 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_5.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set23 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.3.json", import.meta.url), "utf8")) as ScrapedSet; // power-torrent
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet; // technognome
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra
const cards = loadCards(set5, set51, set52, set23, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "cavern-hydra"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (leveled plays, enemy-hand contents). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "aeromind-squadron", "ambriel-archangel", "ambriels-edict", "barrier-soldier",
  "batterbot", "countermeasure", "doppelbot", "leyline-sentry", "lucid-echoes",
  "metamind-archivist", "nexus-overwatch", "oreian-steelskin", "steeleye-seer",
  "torrent-acolyte", "war-machine",
  "power-torrent", // Set 2.3 support card scripted for Torrent Acolyte
];

describe("Set 5 Alloyin registration", () => {
  it("all 15 cards + power-torrent have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Aeromind Squadron (Forge: tutor a random Metamind from deck)", () => {
  it("puts a Metamind from the deck into hand", () => {
    const g = gameWith("aeromind-squadron");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[0].hand).toHaveLength(5); // 4 left + 1 tutored
    expect(g.state.players[0].deck).toHaveLength(24);
    expect(keywordValue(g.state.players[0].lanes[0]!, "Mobility")).toBe(1); // inherent
  });

  it("does nothing when the deck has no Metamind", () => {
    const g = gameWith("technognome");
    addToHand(g, 0, "aeromind-squadron");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.players[0].hand).toHaveLength(5);
    expect(g.state.players[0].deck).toHaveLength(25);
  });
});

describe("Ambriel Archangel (while alone: player Armor N, self Armor M + Mobility 1)", () => {
  it("grants player Armor 10 and self Armor 2 / Mobility 1 while alone", () => {
    const g = gameWith("ambriel-archangel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const self = g.state.players[0].lanes[0]!;
    expect(g.state.players[0].armor).toBe(10);
    refreshStatics(g);
    expect(keywordValue(self, "Armor")).toBe(2);
    expect(keywordValue(self, "Mobility")).toBe(1);
    // no longer alone: the self-buff switches off
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    refreshStatics(g);
    expect(keywordValue(self, "Armor")).toBe(0);
    expect(keywordValue(self, "Mobility")).toBe(0);
  });

  it("tops player Armor back up at each turn start while alone", () => {
    const g = gameWith("ambriel-archangel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    g.state.players[0].armor = 3; // partially consumed
    applyAction(g, { type: "endTurn" }); // p1's turn starts -> turnStart trigger
    expect(g.state.players[0].armor).toBe(10);
  });

  it("does not top up when another friendly creature is in play", () => {
    const g = gameWith("ambriel-archangel");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    g.state.players[0].armor = 3;
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].armor).toBe(3);
  });
});

describe("Ambriel's Edict (destroy all but each side's highest-attack creature; discard hand)", () => {
  it("keeps only the highest-attack creature on each side, then discards the hand", () => {
    const g = gameWith("ambriels-edict", "technognome");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // 4/7 keeps
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 }); // 3/3 dies
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3/3 dies
    spawnCreature(g, [], 1, "technognome", 2, { lane: 1 }); // 9/9 keeps
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes[0]?.defId).toBe("cavern-hydra");
    expect(g.state.players[0].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[1]?.level).toBe(2);
    expect(g.state.players[0].hand).toHaveLength(0);
    // Overload: the edict is removed from the game, not discarded
    expect(g.state.players[0].removed.some((i) => i.defId === "ambriels-edict")).toBe(true);
  });

  it("does not destroy anything when a player has no creatures", () => {
    const g = gameWith("ambriels-edict", "technognome");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes[0]?.defId).toBe("technognome");
    expect(g.state.players[0].hand).toHaveLength(0); // hand is still discarded
  });
});

describe("Barrier Soldier (Forge: you get Armor N)", () => {
  it("grants the player Armor 5, which prevents the first 5 damage each turn", () => {
    const g = gameWith("barrier-soldier");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[0].armor).toBe(5);
    dealPlayerDamage(g, [], 0, 3);
    // per-turn Armor: pool stays 5, usage is tracked separately
    expect(g.state.players[0].armor).toBe(5);
    expect(g.state.players[0].armorUsed).toBe(3);
    expect(g.state.players[0].health).toBe(120);
    dealPlayerDamage(g, [], 0, 4); // only 2 prevention left this turn
    expect(g.state.players[0].health).toBe(118);
  });
});

describe("Batterbot (static: +attack equal to its Armor)", () => {
  it("adds its Armor to its attack", () => {
    const g = gameWith("batterbot");
    const c = spawnCreature(g, [], 0, "batterbot", 1, { lane: 0 })!; // 6/8
    expect(getStats(g, c).attack).toBe(6);
    grantKeyword([], c, { keyword: "Armor", value: 3 });
    expect(getStats(g, c).attack).toBe(9);
  });
});

describe("Countermeasure (enemy -N attack or friendly +N attack)", () => {
  it("gives a chosen enemy creature -4 attack", () => {
    const g = gameWith("countermeasure");
    const foe = spawnCreature(g, [], 1, "technognome", 1, { lane: 0 })!; // 3/3
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(-1);
  });

  it("gives a chosen friendly creature +4 attack", () => {
    const g = gameWith("countermeasure");
    const mine = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!; // 3/3
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: mine.uid });
    expect(mine.attack).toBe(7);
  });
});

describe("Doppelbot (Activate: replace with a copy of an enemy-hand creature)", () => {
  it("replaces itself with a copy of the chosen creature", () => {
    const g = gameWith("technognome", "technognome");
    const bot = spawnCreature(g, [], 0, "doppelbot", 1, { lane: 0 })!;
    endRound(g); // p0's turn again; doppelbot is offensive
    applyAction(g, { type: "activate", uid: bot.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 }); // enemy L1 technognome
    const copy = g.state.players[0].lanes[0]!;
    expect(copy.defId).toBe("technognome");
    expect(copy.owner).toBe(0);
    expect(copy.attack).toBe(3);
    expect(g.state.players[0].discard.some((i) => i.defId === "doppelbot")).toBe(true);
  });

  it("L2 copy gets +5 attack", () => {
    const g = gameWith("technognome", "technognome");
    const bot = spawnCreature(g, [], 0, "doppelbot", 2, { lane: 0 })!;
    endRound(g);
    applyAction(g, { type: "activate", uid: bot.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].lanes[0]!.attack).toBe(8); // 3 + 5
  });
});

describe("Leyline Sentry (Ambush: enemy un-Forged entry)", () => {
  it("ambushes when an enemy creature enters play un-Forged on the enemy turn", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-sentry");
    // p0 (active) gets an un-Forged token entry; p1's sentry is watching
    const initial = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: "random" }));
    runBatches(g, [], initial);
    applyAction(g, { type: "battle" }); // any action runs the ambush check
    const lanes = g.state.players[1].lanes.filter((l) => l !== null);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.defId).toBe("leyline-sentry");
    expect(lanes[0]!.attack).toBe(2); // L1 2/8
    expect(lanes[0]!.health).toBe(8);
    expect(g.state.players[1].hand).toHaveLength(5); // sentry left the hand
    const discard = g.state.players[1].discard;
    expect(discard.some((i) => i.defId === "leyline-sentry" && i.level === 1)).toBe(true);
    expect(discard.some((i) => i.defId === "leyline-sentry" && i.level === 2)).toBe(true); // leveled copy
  });

  it("does not ambush on a Forged (from-hand) entry", () => {
    const g = gameWith("cavern-hydra", "cavern-hydra");
    addToHand(g, 1, "leyline-sentry");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.players[1].lanes.every((l) => l === null)).toBe(true);
    expect(g.state.players[1].hand).toHaveLength(6);
  });
});

describe("Metamind Archivist (Forge: with another Metamind, draw N at end of turn)", () => {
  it("draws 1 card at the end of the turn it was Forged", () => {
    const g = gameWith("metamind-archivist");
    spawnCreature(g, [], 0, "aeromind-squadron", 1, { lane: 0 }); // the other Metamind
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].hand).toHaveLength(6); // 5 redraw + 1 archivist draw
  });

  it("does not draw without another friendly Metamind", () => {
    const g = gameWith("metamind-archivist");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 }); // Gnome, not a Metamind
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].hand).toHaveLength(5);
  });
});

describe("Nexus Overwatch (Forge in the center space: you may discard and level up)", () => {
  it("offers the discard-and-level choice in the center space", () => {
    const g = gameWith("nexus-overwatch");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(3); // 4 left - 1 discarded
    const discard = g.state.players[0].discard;
    expect(discard).toHaveLength(3); // L2 copy of the play + discarded L1 + its L2 copy
    expect(discard.filter((i) => i.defId === "nexus-overwatch" && i.level === 2)).toHaveLength(2);
    expect(discard.some((i) => i.defId === "nexus-overwatch" && i.level === 1)).toBe(true);
  });

  it("does not trigger outside the center space", () => {
    const g = gameWith("nexus-overwatch");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Oreian Steelskin (Armor N, +1 more at Rank 2+)", () => {
  it("grants Armor 2 at Rank 1 and Armor 3 at Rank 2", () => {
    const g = gameWith("oreian-steelskin");
    const c = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(keywordValue(c, "Armor")).toBe(2);
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(keywordValue(c, "Armor")).toBe(5); // 2 + (2 + 1)
  });
});

describe("Steeleye Seer (Activate: level up a card in hand, maybe discard it)", () => {
  it("levels the card in place, then discards it above your Rank", () => {
    const g = gameWith("steeleye-seer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    const seer = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: seer.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 }); // L1 -> L2, Rank 1: discarded
    expect(g.state.players[0].hand).toHaveLength(4);
    const last = g.state.players[0].discard.at(-1)!;
    expect(last.defId).toBe("steeleye-seer");
    expect(last.level).toBe(2);
  });

  it("keeps the leveled card in hand at Rank 2", () => {
    const g = gameWith("steeleye-seer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    endRound(g);
    g.state.players[0].rank = 2;
    const seer = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: seer.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(5);
    expect(g.state.players[0].hand[0]!.level).toBe(2);
  });
});

describe("Torrent Acolyte (L2 Forge: put a level 2 Power Torrent into hand)", () => {
  it("puts a level 2 Power Torrent into hand", () => {
    const g = gameWith("torrent-acolyte");
    addToHand(g, 0, "torrent-acolyte", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(g.state.players[0].hand.some((i) => i.defId === "power-torrent" && i.level === 2)).toBe(true);
  });

  it("Power Torrent (support card) is Free at L2 and gives +3 attack", () => {
    const g = gameWith("torrent-acolyte");
    const c = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!; // 3/3
    addToHand(g, 0, "power-torrent", 2);
    applyAction(g, { type: "playCard", handIndex: 5 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(c.attack).toBe(6);
    expect(g.state.playsLeft).toBe(2); // Free: no play consumed
  });
});

describe("War Machine (Forge: each other friendly creature gets +3 attack)", () => {
  it("buffs the other friendly creatures, not itself", () => {
    const g = gameWith("war-machine");
    const a = spawnCreature(g, [], 0, "technognome", 1, { lane: 0 })!; // 3/3
    const b = spawnCreature(g, [], 0, "technognome", 2, { lane: 1 })!; // 9/9
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 3/3
    expect(a.attack).toBe(6);
    expect(b.attack).toBe(12);
    expect(g.state.players[0].lanes[2]!.attack).toBe(3);
  });
});
