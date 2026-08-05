import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, dealCreatureDamage,
  destroyCreature, getCardScript, hasKeyword, keywordValue, legalActions, loadCards,
  refreshStatics, runBatches, spawnCreature,
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

function gameWith(deckId: string, oppId = "technognome"): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7);
}

/** Inject extra cards into a hand (level-gated plays, Allied conditions). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "aegis-wings", "anatomize", "anvillon-arbiter", "battletech-inventor",
  "gauntlets-of-sulgrim", "oreian-scavenger", "palladium-wave",
  "spiritsteel-infiltrator", "steeleye-researcher", "steelwatch-guard",
  "tech-explorer", "uriel-ironwing", "vault-welder", "war-tinker",
  "esperian-sage", "relic-hunter", "discordant-strike", "epoch-hawk",
];

describe("Set 4 Alloyin registration", () => {
  it("all 18 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Aegis Wings (buff; keywords if highest attack)", () => {
  it("grants Mobility 1 and Armor 2 when the target ends up highest", () => {
    const g = gameWith("aegis-wings");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 }); // 3 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4 attack
    const gnome = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.attack).toBe(6); // 3 + 3
    expect(keywordValue(gnome, "Mobility")).toBe(1);
    expect(keywordValue(gnome, "Armor")).toBe(2);
  });

  it("only buffs when another creature has higher attack", () => {
    const g = gameWith("aegis-wings");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 }); // 3 attack
    spawnCreature(g, [], 1, "technognome", 2, { lane: 1 }); // 9 attack
    const gnome = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.attack).toBe(6); // 6 < 9
    expect(keywordValue(gnome, "Mobility")).toBe(0);
    expect(keywordValue(gnome, "Armor")).toBe(0);
  });
});

describe("Anatomize (debuff + extra play)", () => {
  it("gives a creature -4 attack and refunds the play", () => {
    const g = gameWith("anatomize");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(-1); // 3 - 4
    expect(g.state.playsLeft).toBe(2); // 2 - 1 + 1 extra play
  });
});

describe("Anvillon Arbiter (enemy's 2nd card discards their hand)", () => {
  it("does not punish its own controller's plays", () => {
    const g = gameWith("anvillon-arbiter");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 2nd card, own
    expect(g.state.players[0].hand).toHaveLength(3);
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(1); // inherent
  });

  it("discards the enemy hand when they play their second card", () => {
    const g = gameWith("anvillon-arbiter");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" }); // p1's turn
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 1st card: nothing
    expect(g.state.players[1].hand).toHaveLength(4);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 2nd card: punish
    expect(g.state.players[1].hand).toHaveLength(0);
    expect(g.state.pending).toBeNull();
  });
});

describe("Battletech Inventor (Forge: enemy creature -N attack)", () => {
  it("gives a chosen enemy creature -3 attack", () => {
    const g = gameWith("battletech-inventor");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([foe.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(0); // 3 - 3
  });

  it("does not prompt with no enemy creature in play", () => {
    const g = gameWith("battletech-inventor");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Discordant Strike (enemy -N attack; Allied Nekrium: -N health)", () => {
  it("without Nekrium only debuffs attack", () => {
    const g = gameWith("discordant-strike");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.pending).toBeNull(); // no second choice
    expect(foe.attack).toBe(-1); // 3 - 4
    expect(foe.health).toBe(3);
  });

  it("with Nekrium in hand chains a -4 health choice onto a second enemy", () => {
    const g = gameWith("discordant-strike");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3/3
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    const [gnome, hydra] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    addToHand(g, 0, "cull-the-weak"); // Allied Nekrium
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("enemyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: gnome.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("enemyCreature");
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.pending).toBeNull();
    expect(gnome.attack).toBe(-1); // attack debuff on the first target
    expect(gnome.health).toBe(3);
    expect(hydra.attack).toBe(4); // untouched attack
    expect(hydra.health).toBe(3); // 7 - 4 health debuff
  });
});

describe("Epoch Hawk (6+ cards in hand: Activate spawns an Epoch Soldier)", () => {
  it("cannot activate with fewer than 6 cards in hand", () => {
    const g = gameWith("epoch-hawk");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g);
    const hawk = g.state.players[0].lanes[2]!;
    expect(g.state.players[0].hand).toHaveLength(5);
    expect(legalActions(g).some((a) => a.type === "activate" && a.uid === hawk.uid)).toBe(false);
    expect(() => applyAction(g, { type: "activate", uid: hawk.uid })).toThrow();
  });

  it("spawns a 4/4 Epoch Soldier with 6+ cards in hand", () => {
    const g = gameWith("epoch-hawk");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g);
    const hawk = g.state.players[0].lanes[2]!;
    addToHand(g, 0, "technognome");
    addToHand(g, 0, "technognome"); // 7 cards in hand
    applyAction(g, { type: "activate", uid: hawk.uid });
    const soldier = g.state.players[0].lanes.find((c) => c?.defId === "epoch-soldier");
    expect(soldier).toBeTruthy();
    expect(soldier!.lane).not.toBe(2);
    expect([soldier!.attack, soldier!.health]).toEqual([4, 4]);
    expect(soldier!.defensive).toBe(true);
  });
});

describe("Esperian Sage (enter: discard and level up; Allied Uterra: copy)", () => {
  it("mandatory discard-and-level on enter, no copy without Uterra", () => {
    const g = gameWith("esperian-sage");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBeUndefined(); // mandatory
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no Allied prompt
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3); // 5 - played - discarded
    expect(p0.lanes.filter((c) => c?.defId === "esperian-sage")).toHaveLength(1);
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play copy + effect copy
  });

  it("with Uterra in hand, puts a copy into another space (which also discards)", () => {
    const g = gameWith("esperian-sage");
    addToHand(g, 0, "cavern-hydra"); // Allied Uterra
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    let guard = 0;
    while (g.state.pending && guard++ < 10) {
      const req = g.state.pending.request;
      if (req.kind === "cardInHand") {
        const idx = g.state.players[0].hand.findIndex((c) => c.defId === "esperian-sage");
        applyChoice(g, { id: req.id, accepted: true, handIndex: idx });
      } else {
        expect(req.kind).toBe("yesNo");
        applyChoice(g, { id: req.id, accepted: true }); // make the copy
      }
    }
    const sages = g.state.players[0].lanes.filter((c) => c?.defId === "esperian-sage");
    expect(sages).toHaveLength(2); // original + copy
    expect(sages[0]!.lane).not.toBe(sages[1]!.lane);
    // hand: 6 - played - 2 discards (original's enter + copy's enter)
    expect(g.state.players[0].hand).toHaveLength(3);
  });

  it("declining the copy still discards once", () => {
    const g = gameWith("esperian-sage");
    addToHand(g, 0, "cavern-hydra");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    let guard = 0;
    while (g.state.pending && guard++ < 10) {
      const req = g.state.pending.request;
      if (req.kind === "cardInHand") {
        applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
      } else {
        applyChoice(g, { id: req.id, accepted: false }); // decline the copy
      }
    }
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "esperian-sage")).toHaveLength(1);
    expect(g.state.players[0].hand).toHaveLength(4); // 6 - played - 1 discard
  });
});

describe("Gauntlets of Sulgrim (L3 creature: Forge Armor 6 to all, Activate armor blast)", () => {
  it("Forge gives each friendly creature Armor 6 and Activate deals a friendly creature's Armor", () => {
    const g = gameWith("gauntlets-of-sulgrim");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const gnome = g.state.players[0].lanes[0]!;
    const hydra = g.state.players[1].lanes[1]!;
    addToHand(g, 0, "gauntlets-of-sulgrim", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    const gauntlets = g.state.players[0].lanes[2]!;
    expect([gauntlets.attack, gauntlets.health]).toEqual([15, 15]);
    expect(keywordValue(gauntlets, "Armor")).toBe(6);
    expect(keywordValue(gnome, "Armor")).toBe(6);
    endRound(g);
    applyAction(g, { type: "activate", uid: gauntlets.uid });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: gauntlets.uid }); // Armor 6
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("enemyCreature");
    applyChoice(g, { id: req2.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.damage).toBe(6);
  });
});

describe("Oreian Scavenger (Upgrade: Armor N)", () => {
  it("gets Armor 6 when played over another creature", () => {
    const g = gameWith("oreian-scavenger");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // replace
    const scav = g.state.players[0].lanes[0]!;
    expect(scav.defId).toBe("oreian-scavenger");
    expect(keywordValue(scav, "Armor")).toBe(6);
    expect(g.state.players[0].discard.at(-1)!.defId).toBe("technognome");
  });

  it("gets nothing on an empty space", () => {
    const g = gameWith("oreian-scavenger");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(0);
  });
});

describe("Palladium Wave (each enemy creature -2x Rank attack)", () => {
  it("debuffs each enemy creature by 2 at rank 1", () => {
    const g = gameWith("palladium-wave");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const [gnome, hydra] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no choices
    expect(gnome.attack).toBe(1); // 3 - 2
    expect(hydra.attack).toBe(2); // 4 - 2
  });

  it("scales with rank (-4 at rank 2)", () => {
    const g = gameWith("palladium-wave");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    const gnome = g.state.players[1].lanes[0]!;
    for (let t = 0; t < 4; t++) endRound(g);
    expect(g.state.players[0].rank).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(gnome.attack).toBe(-1); // 3 - 4
  });
});

describe("Relic Scout (when replaced: the replacer gets +N/+N and Armor N)", () => {
  it("grants +1/+1 and Armor 1 to the creature that replaces it", () => {
    const g = gameWith("technognome");
    spawnCreature(g, [], 0, "relic-scout", 1, { lane: 0 }); // 1/1 Armor 1
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // replace the Scout
    const gnome = g.state.players[0].lanes[0]!;
    expect(gnome.defId).toBe("technognome");
    expect([gnome.attack, gnome.health]).toEqual([4, 4]); // 3/3 + 1/1
    expect(keywordValue(gnome, "Armor")).toBe(1);
  });

  it("does not grant anything when it dies without being replaced", () => {
    const g = gameWith("technognome");
    spawnCreature(g, [], 0, "relic-scout", 1, { lane: 0 });
    const scout = g.state.players[0].lanes[0]!;
    runBatches(g, [], collectInto(() => destroyCreature(g, [], scout)));
    const gnome = g.state.players[0].lanes[0];
    expect(gnome).toBeNull();
  });
});

describe("Relic Hunter (Solbind Relic Scout; Upgrade absorbs the replaced creature)", () => {
  it("Solbind adds a Relic Scout to the deck at game start", () => {
    const g = gameWith("relic-hunter");
    const p0 = g.state.players[0];
    const all = [...p0.deck, ...p0.hand].map((c) => c.defId);
    expect(all).toHaveLength(31); // 30 + 1 bound
    expect(all).toContain("relic-scout");
  });

  it("absorbs the Scout AND gets its replaced-grant when replacing one", () => {
    const g = gameWith("relic-hunter");
    spawnCreature(g, [], 0, "relic-scout", 1, { lane: 0 }); // 1/1
    const hi = g.state.players[0].hand.findIndex((c) => c.defId === "relic-hunter");
    applyAction(g, { type: "playCard", handIndex: hi, lane: 0 });
    const hunter = g.state.players[0].lanes[0]!;
    expect(hunter.defId).toBe("relic-hunter");
    // 5/5 + 1/1 absorb (Upgrade) + 1/1 and Armor 1 (the Scout's replaced-grant)
    expect([hunter.attack, hunter.health]).toEqual([7, 7]);
    expect(keywordValue(hunter, "Armor")).toBe(1);
    expect(hasKeyword(hunter, "Breakthrough")).toBe(true); // inherent
    expect(g.state.players[0].discard.at(-1)!.defId).toBe("relic-scout");
  });

  it("gets nothing on an empty space", () => {
    const g = gameWith("relic-hunter");
    const hi = g.state.players[0].hand.findIndex((c) => c.defId === "relic-hunter");
    applyAction(g, { type: "playCard", handIndex: hi, lane: 0 });
    const hunter = g.state.players[0].lanes[0]!;
    expect([hunter.attack, hunter.health]).toEqual([5, 5]);
  });
});

describe("Spiritsteel Infiltrator (threshold static: Mobility + Armor)", () => {
  it("gains Mobility 1 and Armor 2 only while at 5+ attack", () => {
    const g = gameWith("spiritsteel-infiltrator");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const inf = g.state.players[0].lanes[0]!;
    refreshStatics(g);
    expect(inf.attack).toBe(4); // below the gate
    expect(keywordValue(inf, "Mobility")).toBe(0);
    expect(keywordValue(inf, "Armor")).toBe(0);
    buffCreature(g, [], inf, 2, 0); // 6 attack
    refreshStatics(g);
    expect(keywordValue(inf, "Mobility")).toBe(1);
    expect(keywordValue(inf, "Armor")).toBe(2);
  });
});

describe("Steeleye Researcher (Upgrade: optional discard and level up)", () => {
  it("prompts for a discard when played over another creature", () => {
    const g = gameWith("steeleye-researcher");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.hand).toHaveLength(3); // 5 - played - discarded
    expect(p0.discard.filter((c) => c.level === 2)).toHaveLength(2); // play copy + effect copy
  });

  it("does not prompt on an empty space", () => {
    const g = gameWith("steeleye-researcher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Steelwatch Guard (Upgrade: +N/+N)", () => {
  it("gets +4/+4 when played over another creature", () => {
    const g = gameWith("steelwatch-guard");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const guard = g.state.players[0].lanes[0]!;
    expect(guard.defId).toBe("steelwatch-guard");
    expect([guard.attack, guard.health]).toEqual([8, 8]); // 4/4 + 4/4
  });

  it("stays 4/4 on an empty space", () => {
    const g = gameWith("steelwatch-guard");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const guard = g.state.players[0].lanes[0]!;
    expect([guard.attack, guard.health]).toEqual([4, 4]);
  });
});

describe("Tech Explorer (Forge: optional discard and level up a creature)", () => {
  it("offers only creature cards in hand", () => {
    const g = gameWith("tech-explorer");
    addToHand(g, 0, "lightning-spark"); // a spell: excluded
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0, 1, 2, 3]); // spark at index 4 gated out
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(4); // 6 - played - discarded
  });
});

describe("Uriel Ironwing (Forge/Flank: opposing creature -N attack)", () => {
  it("debuffs the opposing creature on Forge and again after moving (Flank)", () => {
    const g = gameWith("uriel-ironwing");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 3 });
    const [f2, f3] = [g.state.players[1].lanes[2]!, g.state.players[1].lanes[3]!];
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(f2.attack).toBe(1); // 3 - 2 (Forge)
    const uriel = g.state.players[0].lanes[2]!;
    expect(keywordValue(uriel, "Mobility")).toBe(1); // inherent
    endRound(g);
    applyAction(g, { type: "move", uid: uriel.uid, lane: 3 }); // Flank
    expect(f3.attack).toBe(1); // 3 - 2
  });

  it("L3 destroys the opposing creature at 0 or less attack", () => {
    const g = gameWith("uriel-ironwing");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 }); // 3 attack
    addToHand(g, 0, "uriel-ironwing", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    expect(g.state.players[1].lanes[2]).toBeNull(); // 3 - 6 = -3 attack: destroyed
    expect(g.state.players[1].discard.some((c) => c.defId === "technognome")).toBe(true);
  });
});

describe("Vault Welder (Upgrade: Negate Defender)", () => {
  it("keeps Defender on an empty space, loses it after an Upgrade", () => {
    const g = gameWith("vault-welder");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // empty space
    expect(hasKeyword(g.state.players[0].lanes[0]!, "Defender")).toBe(true);
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // replace
    const welder = g.state.players[0].lanes[1]!;
    expect(welder.defId).toBe("vault-welder");
    expect(hasKeyword(welder, "Defender")).toBe(false);
  });
});

describe("War Tinker (end of the enemy's turn: replace with a random Robot from deck)", () => {
  it("replaces itself only at the end of the enemy player's turn", () => {
    const deck = [...Array(15).fill("war-tinker"), ...Array(15).fill("vault-welder")] as string[];
    const g = createGame(cards, deck, deckOf("technognome"), 7);
    addToHand(g, 0, "war-tinker");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    const tinker = g.state.players[0].lanes[0]!;
    dealCreatureDamage(g, [], tinker, 1); // mark the original
    applyAction(g, { type: "endTurn" }); // own turn end: no replace
    expect(g.state.players[0].lanes[0]!.uid).toBe(tinker.uid);
    expect(g.state.players[0].lanes[0]!.damage).toBe(1);
    applyAction(g, { type: "endTurn" }); // enemy turn end: replace
    const copy = g.state.players[0].lanes[0]!;
    expect(copy.uid).not.toBe(tinker.uid);
    expect(["war-tinker", "vault-welder"]).toContain(copy.defId); // a Robot from the deck
    expect(copy.damage).toBe(0); // fresh copy
  });
});
