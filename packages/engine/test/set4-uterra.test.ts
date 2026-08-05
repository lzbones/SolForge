import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  allCreatures, applyAction, applyChoice, createGame, getCardScript, grantKeyword, hasKeyword,
  keywordValue, loadCards, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set4 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.json", import.meta.url), "utf8")) as ScrapedSet;
const set41 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set42 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_4.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set4, set41, set42, set3, set2, set1);

const deckOf = (id: string) => Array(30).fill(id) as string[];
const endRound = (g: Game) => {
  applyAction(g, { type: "endTurn" });
  applyAction(g, { type: "endTurn" });
};

function gameWith(deckId: string, oppId = "technognome", startingHealth?: number): Game {
  return createGame(cards, deckOf(deckId), deckOf(oppId), 7,
    startingHealth === undefined ? {} : { startingHealth });
}

/** Inject extra cards into a hand (higher-level plays, faction support). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

const IDS = [
  "kitaru-sprite", "lash-of-demara", "lysian-rain", "roaming-warclaw", "shardclaw-crusher",
  "soothsayer-hermit", "spiritstone-druid", "stag-of-lys", "tuskin-grovekeeper", "venomdrinker",
  "venomstrike", "wegu-the-ancient", "whispers-of-dendris", "nova-grove-queen", "verdant-charge",
  "bron-wild-tamer", "gemhide-ravager",
];

describe("Set 4 Uterra registration", () => {
  it("all 17 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Bron, Wild Tamer (Upgrade a Dinosaur: become a Dino Knight)", () => {
  it("replaces itself with a same-level Dino Knight when it replaces a Dinosaur", () => {
    const g = gameWith("bron-wild-tamer");
    spawnCreature(g, [], 0, "crag-walker", 1, { lane: 2 }); // Tempys Dinosaur
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const knight = g.state.players[0].lanes[2]!;
    expect(knight.defId).toBe("dino-knight");
    expect([knight.attack, knight.health]).toEqual([8, 8]);
    expect(hasKeyword(knight, "Breakthrough")).toBe(true);
    expect(hasKeyword(knight, "Aggressive")).toBe(true);
    const discard = g.state.players[0].discard.map((i) => i.defId);
    expect(discard).toContain("crag-walker");
    expect(discard).toContain("bron-wild-tamer");
  });

  it("stays on the board when it replaces a non-Dinosaur", () => {
    const g = gameWith("bron-wild-tamer");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes[2]!.defId).toBe("bron-wild-tamer");
  });

  it("heals 3 damage from each other friendly creature when it hits a player", () => {
    const g = gameWith("bron-wild-tamer", "technognome", 100);
    spawnCreature(g, [], 0, "bron-wild-tamer", 1, { lane: 2 }); // Spawned: no Upgrade
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    endRound(g);
    hydra.damage = 5; // set after the round: skips the hydra's Regenerate tick
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(92); // 4 from Bron + 4 from the hydra
    expect(hydra.damage).toBe(2); // healed 3 of 5
  });
});

describe("Gemhide Ravager (battle-damage lifetap; Allied Tempys: Mobility)", () => {
  it("gains you health equal to its battle damage to a player", () => {
    const g = gameWith("gemhide-ravager", "technognome", 100);
    spawnCreature(g, [], 0, "gemhide-ravager", 1, { lane: 2 });
    endRound(g);
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].health).toBe(95);
    expect(g.state.players[0].health).toBe(105); // gained the 5 damage dealt
  });

  it("gets Mobility 1 with a Tempys card in hand, and not without", () => {
    const g = gameWith("gemhide-ravager");
    addToHand(g, 0, "crag-walker"); // Tempys
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Mobility")).toBe(1);

    const g2 = gameWith("gemhide-ravager"); // all-Uterra hand
    applyAction(g2, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g2.state.players[0].lanes[2]!, "Mobility")).toBe(0);
  });
});

describe("Lash of Demara (L1/L2 spell, L3 creature)", () => {
  it("L1: each enemy creature gets Poison 3, friendly creatures unaffected", () => {
    const g = gameWith("lash-of-demara");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 }); // a spell at L1: no lane
    expect(keywordValue(g.state.players[1].lanes[0]!, "Poison")).toBe(3);
    expect(keywordValue(g.state.players[1].lanes[1]!, "Poison")).toBe(3);
    expect(keywordValue(g.state.players[0].lanes[0]!, "Poison")).toBe(0);
  });

  it("L3: Forge gives Poison 6; Activate gives a Poisoned enemy Defender", () => {
    const g = gameWith("lash-of-demara");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    addToHand(g, 0, "lash-of-demara", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // a creature at L3
    const lash = g.state.players[0].lanes[2]!;
    expect([lash.attack, lash.health]).toEqual([14, 20]);
    expect(keywordValue(g.state.players[1].lanes[0]!, "Poison")).toBe(6);
    lash.defensive = false; // skip the round: the enemy Poison tick would kill a dummy
    const hydra = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "activate", uid: lash.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([hydra.uid, g.state.players[1].lanes[1]!.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hasKeyword(hydra, "Defender")).toBe(true);
  });
});

describe("Lysian Rain (+N health to a creature or player)", () => {
  it("gives a creature a permanent +7 health", () => {
    const g = gameWith("lysian-rain");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([4, 14]); // 7 + 7
  });

  it("gives a player +7 health via the player sentinel", () => {
    const g = gameWith("lysian-rain");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.options).toContain(-1);
    applyChoice(g, { id: req.id, accepted: true, targetUid: -1 });
    expect(g.state.players[0].health).toBe(127);
  });
});

describe("Nova, Grove Queen (Forge: Seedlings; four levels)", () => {
  it("L1: puts a 1/1 Seedling into one adjacent available space", () => {
    const g = gameWith("nova-grove-queen");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const lanes = g.state.players[0].lanes;
    const seedlings = lanes.filter((c) => c?.defId === "seedling");
    expect(seedlings).toHaveLength(1);
    expect([seedlings[0]!.attack, seedlings[0]!.health]).toEqual([1, 1]);
    expect([1, 3]).toContain(seedlings[0]!.lane);
  });

  it("L2: fills each adjacent available space", () => {
    const g = gameWith("nova-grove-queen");
    addToHand(g, 0, "nova-grove-queen", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    const lanes = g.state.players[0].lanes;
    expect(lanes[1]?.defId).toBe("seedling");
    expect(lanes[3]?.defId).toBe("seedling");
    expect(lanes[0]).toBeNull();
    expect(lanes[4]).toBeNull();
  });

  it("L3/L4: fills every available space; L4 body is 14/19", () => {
    const g = gameWith("nova-grove-queen");
    addToHand(g, 0, "nova-grove-queen", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    let lanes = g.state.players[0].lanes;
    expect(lanes.every((c) => c !== null)).toBe(true);
    expect(lanes.filter((c) => c?.defId === "seedling")).toHaveLength(4);

    const g4 = gameWith("nova-grove-queen");
    addToHand(g4, 0, "nova-grove-queen", 4);
    applyAction(g4, { type: "playCard", handIndex: 5, lane: 2 });
    lanes = g4.state.players[0].lanes;
    expect([lanes[2]!.attack, lanes[2]!.health]).toEqual([14, 19]);
    expect(lanes.every((c) => c !== null)).toBe(true);
  });
});

describe("Roaming Warclaw (Forge: optional 1/1 Raptor in another space)", () => {
  it("spawns a 1/1 Raptor in a different space when accepted", () => {
    const g = gameWith("roaming-warclaw");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("yesNo");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true });
    const raptors = [...allCreatures(g.state)].filter((c) => c.defId === "raptor");
    expect(raptors).toHaveLength(1);
    expect([raptors[0]!.attack, raptors[0]!.health]).toEqual([1, 1]);
    expect(raptors[0]!.lane).not.toBe(2);
  });

  it("does nothing when declined", () => {
    const g = gameWith("roaming-warclaw");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect([...allCreatures(g.state)].filter((c) => c.defId === "raptor")).toHaveLength(0);
  });
});

describe("Soothsayer Hermit (Forge: recover a low-level creature from discard)", () => {
  it("offers only level 1 creatures at L1 and moves the pick to hand", () => {
    const g = gameWith("soothsayer-hermit");
    const pl = g.state.players[0];
    pl.discard.push(
      { uid: g.state.nextUid++, defId: "cavern-hydra", level: 1, owner: 0 },
      { uid: g.state.nextUid++, defId: "cavern-hydra", level: 2, owner: 0 },
      { uid: g.state.nextUid++, defId: "lysian-rain", level: 1, owner: 0 }, // a spell
    );
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInDiscard");
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([0]); // only the level 1 creature
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(pl.hand.some((i) => i.defId === "cavern-hydra" && i.level === 1)).toBe(true);
    expect(pl.discard.filter((i) => i.defId === "cavern-hydra")).toHaveLength(1); // the L2 stays
  });
});

describe("Stag of Lys (end of your turn: gain N health)", () => {
  it("heals 2 at the end of your turn only", () => {
    const g = gameWith("stag-of-lys");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[0].health).toBe(122);
    applyAction(g, { type: "endTurn" }); // enemy turn: no trigger
    expect(g.state.players[0].health).toBe(122);
  });
});

describe("Venomdrinker (Forge: +X/+X, X = total enemy Poison)", () => {
  it("sums Poison across enemy creatures", () => {
    const g = gameWith("venomdrinker");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    grantKeyword([], g.state.players[1].lanes[0]!, { keyword: "Poison", value: 3 });
    grantKeyword([], g.state.players[1].lanes[1]!, { keyword: "Poison", value: 4 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const v = g.state.players[0].lanes[2]!;
    expect([v.attack, v.health]).toEqual([12, 12]); // 5 + 7
  });
});

describe("Venomstrike (Poison N + extra play)", () => {
  it("gives a creature Poison 4 and refunds the play", () => {
    const g = gameWith("venomstrike");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const hydra = g.state.players[1].lanes[0]!;
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(keywordValue(hydra, "Poison")).toBe(4);
    expect(g.state.playsLeft).toBe(2); // 2 - 1 + 1 extra play
  });
});

describe("Verdant Charge (each friendly creature: +N/+N and Regenerate N)", () => {
  it("buffs and grants Regenerate 1 to each friendly creature only", () => {
    const g = gameWith("verdant-charge");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 }); // vanilla dummies:
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 }); // cavern-hydra has Regenerate
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const [a, b] = [g.state.players[0].lanes[0]!, g.state.players[0].lanes[1]!];
    expect([a.attack, a.health]).toEqual([4, 4]);
    expect([b.attack, b.health]).toEqual([4, 4]);
    expect(keywordValue(a, "Regenerate")).toBe(1);
    expect(keywordValue(b, "Regenerate")).toBe(1);
    const foe = g.state.players[1].lanes[2]!;
    expect([foe.attack, foe.health]).toEqual([3, 3]);
    expect(keywordValue(foe, "Regenerate")).toBe(0);
  });
});

describe("Whispers of Dendris (each friendly creature gets +Rank/+Rank)", () => {
  it("buffs each friendly creature by your rank", () => {
    const g = gameWith("whispers-of-dendris");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "technognome", 1, { lane: 1 });
    g.state.players[0].rank = 2;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([6, 9]);
    expect([g.state.players[0].lanes[1]!.attack, g.state.players[0].lanes[1]!.health]).toEqual([5, 5]);
  });
});

describe("Engine-gap cards (registered as vanilla bodies — TODO in scripts file)", () => {
  it("Wegu, the Ancient keeps its inherent Defender", () => {
    const g = gameWith("wegu-the-ancient");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const wegu = g.state.players[0].lanes[2]!;
    expect([wegu.attack, wegu.health]).toEqual([0, 1]);
    expect(hasKeyword(wegu, "Defender")).toBe(true);
  });

  it("Kitaru Sprite plays as a vanilla 3/7 (replacement trigger unimplemented)", () => {
    const g = gameWith("kitaru-sprite");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // replaced: no Spawn (engine gap)
    const sprite = g.state.players[0].lanes[2]!;
    expect([sprite.attack, sprite.health]).toEqual([3, 7]);
    expect([...allCreatures(g.state)].filter((c) => c.defId === "kitaru-sprite")).toHaveLength(1);
  });
});
