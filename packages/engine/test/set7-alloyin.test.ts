import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, getCardScript, getStats,
  hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
  type CreatureState, type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set7 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.json", import.meta.url), "utf8")) as ScrapedSet;
const set71 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set72 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set73 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_7.3.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra + forge-guardian-alpha
const cards = loadCards(set7, set71, set72, set73, set1);

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

/** Play the last card of p0's hand (an addToHand'd card). */
function playLastAdded(g: Game, lane?: number): void {
  const handIndex = g.state.players[0].hand.length - 1;
  applyAction(g, { type: "playCard", handIndex, ...(lane !== undefined ? { lane } : {}) });
}

/** Deal damage outside of an action and resolve the resulting batch. */
function ping(g: Game, target: CreatureState, amount: number, battle = false, source: CreatureState | null = null): void {
  const initial = collectInto(() => dealCreatureDamage(g, [], target, amount, source, battle));
  runBatches(g, [], initial);
}

/** Answer the pending choice with a target. */
function chooseTarget(g: Game, targetUid: number): void {
  applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid });
}

const IDS = [
  "anvilbreaker", "armory-outpost", "automaton-prime", "bulwark-battalion",
  "crux-metamind-rogue", "cypien-experimentation", "defense-spire", "frontline-combatant",
  "gsf-commando", "guardians-assemble", "ironbeard-ascendant", "metadata-redactor",
  "ordnance-captain", "repress", "specimen-001", "stasis-indexer",
  "steelspark-tinkerer", "tower-cannoneer", "voltaic-prophet",
];

describe("Set 7 Alloyin registration", () => {
  it("all 19 cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Anvilbreaker (Free; enemy creature -2 attack, then move it at random)", () => {
  it("debuffs and moves the target to another open space without spending a play", () => {
    const g = gameWith("anvilbreaker");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending!.request.kind).toBe("enemyCreature");
    chooseTarget(g, foe.uid);
    expect(foe.attack).toBe(2); // 4 - 2
    expect(foe.lane).not.toBe(0); // moved to another available space
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[foe.lane]?.uid).toBe(foe.uid);
    expect(g.state.playsLeft).toBe(2); // Free
  });
});

describe("Armory Outpost (+N attack; splashes to adjacent creatures if the target is in Formation)", () => {
  it("buffs the adjacent creatures too when the target is in Formation", () => {
    const g = gameWith("armory-outpost");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const mid = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, mid.uid);
    const lanes = g.state.players[0].lanes;
    expect(lanes[0]!.attack).toBe(8); // 4 + 4
    expect(lanes[1]!.attack).toBe(8);
    expect(lanes[2]!.attack).toBe(8);
  });

  it("buffs only the target when it is not in Formation", () => {
    const g = gameWith("armory-outpost");
    const edge = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const mid = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, edge.uid); // lane 0 can never be in Formation
    expect(edge.attack).toBe(8);
    expect(mid.attack).toBe(4);
  });
});

describe("Automaton Prime (Formation: gets Armor N)", () => {
  it("gains Armor 4 when played between two friendly creatures", () => {
    const g = gameWith("automaton-prime");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(keywordValue(g.state.players[0].lanes[1]!, "Armor")).toBe(4);
  });

  it("gains nothing on an edge lane", () => {
    const g = gameWith("automaton-prime");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(0);
  });
});

describe("Bulwark Battalion (another friendly creature enters: it gets Armor N until end of turn)", () => {
  it("gives the entering creature temp Armor 4, which wears off at turn end; its own entry does nothing", () => {
    const g = gameWith("bulwark-battalion");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const battalion = g.state.players[0].lanes[0]!;
    expect(keywordValue(battalion, "Armor")).toBe(0); // "another" friendly creature
    let entered!: CreatureState;
    runBatches(g, [], collectInto(() => { entered = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; }));
    expect(keywordValue(entered, "Armor")).toBe(4);
    applyAction(g, { type: "endTurn" }); // temp keywords wear off
    expect(keywordValue(entered, "Armor")).toBe(0);
  });

  it("ignores enemy entries", () => {
    const g = gameWith("bulwark-battalion");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    let foe!: CreatureState;
    runBatches(g, [], collectInto(() => { foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; }));
    expect(keywordValue(foe, "Armor")).toBe(0);
  });
});

describe("Crux, Metamind Rogue (Forge: Armor N when alone; Upgrade: enemy creature -N attack)", () => {
  it("gets Armor 3 when it is the only friendly creature", () => {
    const g = gameWith("crux-metamind-rogue");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(3);
  });

  it("gets nothing with another friendly creature in play", () => {
    const g = gameWith("crux-metamind-rogue");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(0);
  });

  it("Upgrade: gives an enemy creature -4 attack (Forge also fires when it is suddenly alone)", () => {
    const g = gameWith("crux-metamind-rogue");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 }); // to be replaced
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // replace -> Upgrade
    const crux = g.state.players[0].lanes[0]!;
    expect(crux.defId).toBe("crux-metamind-rogue");
    expect(g.state.pending!.request.kind).toBe("enemyCreature");
    chooseTarget(g, foe.uid);
    expect(foe.attack).toBe(0); // 4 - 4
    expect(keywordValue(crux, "Armor")).toBe(3); // alone after the replace
    expect(g.state.players[0].discard.some((i) => i.defId === "cavern-hydra" && i.level === 1)).toBe(true);
  });
});

describe("Cypien Experimentation (random friendly +N attack; random friendly Armor N)", () => {
  it("both picks land on the only friendly creature", () => {
    const g = gameWith("cypien-experimentation");
    const c = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(c.attack).toBe(9); // 4 + 5
    expect(keywordValue(c, "Armor")).toBe(5);
  });

  it("fizzles cleanly with no friendly creature", () => {
    const g = gameWith("cypien-experimentation");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].discard.some((i) => i.defId === "cypien-experimentation")).toBe(true);
  });
});

describe("Defense Spire (Overload; each friendly creature gets Armor 6 this turn)", () => {
  it("grants temp Armor 6 to all friendly creatures and is removed from the game", () => {
    const g = gameWith("defense-spire");
    const a = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const b = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(keywordValue(a, "Armor")).toBe(6);
    expect(keywordValue(b, "Armor")).toBe(6);
    expect(g.state.players[0].removed.some((i) => i.defId === "defense-spire")).toBe(true); // Overload
    applyAction(g, { type: "endTurn" });
    expect(keywordValue(a, "Armor")).toBe(0); // this turn only
  });
});

describe("Frontline Combatant (Armor N via data-gap fix-up; Forge: optional Armor-damage trade)", () => {
  it("enters with Armor 4 and trades its Armor for the target's attack", () => {
    const g = gameWith("frontline-combatant");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/4
    const combatant = g.state.players[0].lanes[0]!;
    expect(keywordValue(combatant, "Armor")).toBe(4); // inherent armor (lowercase in the data)
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.optional).toBe(true);
    chooseTarget(g, foe.uid);
    expect(foe.damage).toBe(4); // damage equal to its Armor
    expect(combatant.damage).toBe(0); // the 4 back-damage is fully absorbed
    expect(combatant.armorUsed).toBe(4);
  });

  it("does nothing when declined", () => {
    const g = gameWith("frontline-combatant");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect(foe.damage).toBe(0);
    expect(g.state.players[0].lanes[0]!.damage).toBe(0);
  });
});

describe("G.S.F. Commando (Forge: +1 Armor per other friendly Metamind; Activate: Nx Armor damage)", () => {
  it("counts other friendly Metaminds on Forge and blasts for its Armor", () => {
    const g = gameWith("gsf-commando");
    spawnCreature(g, [], 0, "metadata-redactor", 1, { lane: 1 }); // one other Metamind
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/8 Armor 1
    const commando = g.state.players[0].lanes[0]!;
    expect(keywordValue(commando, "Armor")).toBe(2); // 1 inherent + 1 Metamind
    endRound(g); // shed the defensive stance
    applyAction(g, { type: "activate", uid: commando.uid });
    chooseTarget(g, foe.uid);
    expect(foe.damage).toBe(2); // L1: 1x its Armor
  });

  it("keeps just its inherent Armor with no other Metamind", () => {
    const g = gameWith("gsf-commando");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(keywordValue(g.state.players[0].lanes[0]!, "Armor")).toBe(1);
  });
});

describe("Guardians Assemble (copy of a Forge Guardian from your deck into the center space)", () => {
  it("L1: spawns a copy in the center space; the deck keeps its cards", () => {
    const g = gameWith("forge-guardian-alpha"); // 30 L1 Forge Guardians
    addToHand(g, 0, "guardians-assemble");
    const deckBefore = g.state.players[0].deck.length;
    playLastAdded(g);
    const center = g.state.players[0].lanes[2];
    expect(center?.defId).toBe("forge-guardian-alpha");
    expect(center?.level).toBe(1);
    expect(center?.attack).toBe(4); // Alpha L1 4/8
    expect(center?.health).toBe(8);
    expect(g.state.players[0].deck).toHaveLength(deckBefore); // a copy: deck untouched
  });

  it("L3 is Free", () => {
    const g = gameWith("forge-guardian-alpha");
    addToHand(g, 0, "guardians-assemble", 3);
    playLastAdded(g);
    expect(g.state.playsLeft).toBe(2);
    expect(g.state.players[0].lanes[2]?.defId).toBe("forge-guardian-alpha");
  });
});

describe("Ironbeard, Ascendant (Solbind Anvilbreaker; grows when you play Anvilbreaker)", () => {
  it("Solbind shuffles one level-1 Anvilbreaker into the deck", () => {
    const g = gameWith("ironbeard-ascendant");
    const pl = g.state.players[0];
    const all = [...pl.deck, ...pl.hand];
    expect(all).toHaveLength(31); // 30 + 1 bound card
    const bound = all.filter((i) => i.defId === "anvilbreaker");
    expect(bound).toHaveLength(1);
    expect(bound[0]!.level).toBe(1);
  });

  it("enters with Armor 1 (lowercase data gap) and gets +2 attack when you play Anvilbreaker", () => {
    const g = gameWith("ironbeard-ascendant");
    const handIndex = g.state.players[0].hand.findIndex((i) => i.defId === "ironbeard-ascendant");
    applyAction(g, { type: "playCard", handIndex, lane: 0 }); // 6/6
    const ironbeard = g.state.players[0].lanes[0]!;
    expect(keywordValue(ironbeard, "Armor")).toBe(1);
    addToHand(g, 0, "anvilbreaker");
    playLastAdded(g); // no enemy creatures: the spell fizzles but was still played
    expect(ironbeard.attack).toBe(8); // 6 + 2
  });

  it("L4: every friendly creature gets +5 attack and Armor 3", () => {
    const g = gameWith("ironbeard-ascendant");
    addToHand(g, 0, "ironbeard-ascendant", 4);
    playLastAdded(g, 0); // 20/20
    const ironbeard = g.state.players[0].lanes[0]!;
    const a = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    const b = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!;
    addToHand(g, 0, "anvilbreaker");
    playLastAdded(g);
    expect(ironbeard.attack).toBe(25); // 20 + 5
    expect(keywordValue(ironbeard, "Armor")).toBe(7); // 4 inherent + 3
    for (const c of [a, b]) {
      expect(c.attack).toBe(9); // 4 + 5
      expect(keywordValue(c, "Armor")).toBe(3);
    }
  });
});

describe("Metadata Redactor (Formation: remove all abilities from each friendly adjacent creature)", () => {
  it("strips and silences both adjacent creatures when in Formation", () => {
    const g = gameWith("metadata-redactor");
    const gsf = spawnCreature(g, [], 0, "gsf-commando", 1, { lane: 0 })!; // Armor 1 + abilities
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    expect(keywordValue(gsf, "Armor")).toBe(0);
    expect(gsf.silenced).toBe(true);
    expect(hydra.silenced).toBe(true);
  });

  it("does nothing without Formation", () => {
    const g = gameWith("metadata-redactor");
    const gsf = spawnCreature(g, [], 0, "gsf-commando", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // edge lane: never Formation
    expect(keywordValue(gsf, "Armor")).toBe(1);
    expect(gsf.silenced).toBe(false);
  });
});

describe("Ordnance Captain (Formation: each friendly creature gets +N attack)", () => {
  it("buffs every friendly creature including itself", () => {
    const g = gameWith("ordnance-captain");
    const a = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const b = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 3/6
    const captain = g.state.players[0].lanes[1]!;
    expect(a.attack).toBe(6); // 4 + 2
    expect(b.attack).toBe(6);
    expect(captain.attack).toBe(5); // 3 + 2
  });

  it("does nothing without Formation", () => {
    const g = gameWith("ordnance-captain");
    const a = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(a.attack).toBe(4);
    expect(g.state.players[0].lanes[0]!.attack).toBe(3);
  });
});

describe("Repress (enemy creature -N attack; Uterra targets lose all abilities)", () => {
  it("strips and silences an Uterra creature", () => {
    const g = gameWith("repress");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // Uterra 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(foe.attack).toBe(1); // 4 - 3
    expect(foe.silenced).toBe(true);
  });

  it("only debuffs a non-Uterra creature", () => {
    const g = gameWith("repress");
    const foe = spawnCreature(g, [], 1, "gsf-commando", 1, { lane: 0 })!; // Alloyin, Armor 1
    applyAction(g, { type: "playCard", handIndex: 0 });
    chooseTarget(g, foe.uid);
    expect(foe.attack).toBe(0); // 3 - 3
    expect(keywordValue(foe, "Armor")).toBe(1); // abilities intact
    expect(foe.silenced).toBe(false);
  });
});

describe("Specimen 001 (dealt non-battle damage: each OTHER friendly creature gets +N attack and Armor M)", () => {
  it("rallies the other friendly creatures on non-battle damage, but not on battle damage", () => {
    const g = gameWith("specimen-001");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 2/12
    const specimen = g.state.players[0].lanes[0]!;
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })!; // 4/7
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!;
    ping(g, specimen, 3, true, foe); // battle damage: no trigger
    expect(ally.attack).toBe(4);
    expect(keywordValue(ally, "Armor")).toBe(0);
    ping(g, specimen, 3, false, foe); // non-battle damage: trigger
    expect(ally.attack).toBe(6); // 4 + 2
    expect(keywordValue(ally, "Armor")).toBe(1);
    expect(specimen.attack).toBe(2); // itself excluded
    expect(keywordValue(specimen, "Armor")).toBe(0);
    expect(specimen.damage).toBe(6);
  });
});

describe("Stasis Indexer (Forge: level-gated creature gets Defender until the end of the enemy's next turn)", () => {
  it("locks an enemy creature down through its next turn, then the Defender expires", () => {
    const g = gameWith("stasis-indexer");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending!.request.kind).toBe("anyCreature");
    chooseTarget(g, foe.uid);
    expect(hasKeyword(foe, "Defender")).toBe(true);
    applyAction(g, { type: "endTurn" }); // p0's turn ends: survives the temp wipe
    expect(hasKeyword(foe, "Defender")).toBe(true); // live during the enemy's next turn
    applyAction(g, { type: "endTurn" }); // the enemy player's next turn ends: expire
    expect(hasKeyword(foe, "Defender")).toBe(false);
  });

  it("L1 cannot target a level-2 creature", () => {
    const g = gameWith("stasis-indexer");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 0 })!; // level 2
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.options).not.toContain(foe.uid);
    expect(req.options).toHaveLength(1); // only the level-1 indexer itself
  });
});

describe("Steelspark Tinkerer (Defender; Forge: you may discard and level up a card)", () => {
  it("offers the optional recycle on Forge", () => {
    const g = gameWith("steelspark-tinkerer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const tinkerer = g.state.players[0].lanes[0]!;
    expect(hasKeyword(tinkerer, "Defender")).toBe(true); // inherent
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(3); // 4 left - 1 discarded
    const discard = g.state.players[0].discard;
    expect(discard.filter((i) => i.level === 2)).toHaveLength(2); // played copy + recycled copy
    expect(discard.filter((i) => i.level === 1)).toHaveLength(1); // the discarded card itself
  });
});

describe("Tower Cannoneer (static: each friendly Defender gets +N attack)", () => {
  it("buffs friendly Defenders only", () => {
    const g = gameWith("tower-cannoneer");
    const cannoneer = spawnCreature(g, [], 0, "tower-cannoneer", 1, { lane: 0 })!; // 6/4
    const tinkerer = spawnCreature(g, [], 0, "steelspark-tinkerer", 1, { lane: 1 })!; // 1/9 Defender
    const prime = spawnCreature(g, [], 0, "automaton-prime", 1, { lane: 2 })!; // 8/4, no Defender
    expect(getStats(g, tinkerer).attack).toBe(4); // 1 + 3
    expect(getStats(g, prime).attack).toBe(8); // untouched
    expect(getStats(g, cannoneer).attack).toBe(6); // not a Defender itself
  });
});

describe("Voltaic Prophet (Formation: L1 recycle one; L2 recycle ALL; L3 level ALL in hand)", () => {
  it("L1: offers the optional recycle only in Formation", () => {
    const g = gameWith("voltaic-prophet");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.optional).toBe(true);
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    expect(g.state.players[0].hand).toHaveLength(3); // 4 left - 1 discarded
  });

  it("L1: no prompt without Formation", () => {
    const g = gameWith("voltaic-prophet");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
  });

  it("L2: discards and levels up each card in hand", () => {
    const g = gameWith("voltaic-prophet");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    addToHand(g, 0, "voltaic-prophet", 2);
    playLastAdded(g, 1);
    expect(g.state.players[0].hand).toHaveLength(0);
    const discard = g.state.players[0].discard;
    expect(discard.filter((i) => i.level === 1)).toHaveLength(5); // the discarded hand
    expect(discard.filter((i) => i.level === 2)).toHaveLength(5); // their leveled copies
    expect(discard.filter((i) => i.level === 3)).toHaveLength(1); // the played L2's own copy
  });

  it("L3: levels up each card in hand without discarding", () => {
    const g = gameWith("voltaic-prophet");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 });
    addToHand(g, 0, "voltaic-prophet", 3);
    playLastAdded(g, 1);
    expect(g.state.players[0].hand).toHaveLength(5); // the originals stay in hand
    const discard = g.state.players[0].discard;
    expect(discard.filter((i) => i.level === 1)).toHaveLength(0);
    expect(discard.filter((i) => i.level === 2)).toHaveLength(5); // leveled copies (L3 play: no copy)
  });
});
