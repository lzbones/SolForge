import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, canAttack, collectInto, createGame, destroyCreature, getStats,
  getCardScript, hasKeyword, healPlayer, keywordValue, loadCards, moveCreature, refreshStatics,
  runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set6 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.json", import.meta.url), "utf8")) as ScrapedSet;
const set61 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set62 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra + lightning-wyrm + energy-surge
const set3 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_3.json", import.meta.url), "utf8")) as ScrapedSet; // izteks-frost / izteks-flame (Valifrax)
const cards = loadCards(set6, set61, set62, set1, set3);

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

const IDS = [
  "aethertap-shaman", "arc-wurm", "blood-boil", "darkstone-asir", "frostspeaker-shaman",
  "ignir-khan-of-ashur", "kadrasian-stoneback", "pyre-mystic", "shadowflame-elemental",
  "sparkweaver-acolyte", "umbraskin-yeti", "valifrax-izteks-champion",
  "ice-grasp", "patron-of-kadras", "phoenix-call", "trial-by-combat",
  // support card scripted in the same file
  "cryophoenix",
];

describe("Set 6 Tempys registration", () => {
  it("all 16 cards + 1 support card have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Aethertap Shaman (when you play a spell, it gets Mobility 1 this turn)", () => {
  it("gains Mobility 1 when you play a spell; it wears off at end of turn", () => {
    const g = gameWith("blood-boil");
    addToHand(g, 0, "aethertap-shaman");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 7/6
    const shaman = g.state.players[0].lanes[0]!;
    expect(keywordValue(shaman, "Mobility")).toBe(0);
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // a target for the spell
    applyAction(g, { type: "playCard", handIndex: 0 }); // Blood Boil (a spell)
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: g.state.players[1].lanes[1]!.uid });
    expect(keywordValue(shaman, "Mobility")).toBe(1);
    expect(shaman.tempKeywords.some((k) => k.keyword === "Mobility")).toBe(true);
    applyAction(g, { type: "endTurn" }); // temp keywords wear off
    expect(keywordValue(shaman, "Mobility")).toBe(0);
  });

  it("does not trigger on the enemy player's spells", () => {
    const g = gameWith("aethertap-shaman", "blood-boil");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const shaman = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "endTurn" }); // p1's turn, hand is 5 Blood Boils
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: shaman.uid });
    expect(keywordValue(shaman, "Mobility")).toBe(0);
  });
});

describe("Arc Wurm (when a friendly creature moves, deal N to the enemy player)", () => {
  it("triggers on its own move and on another friendly creature's move", () => {
    const g = gameWith("arc-wurm");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // wurm A, 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // wurm B, 4/7
    endRound(g); // both offensive
    const wurmB = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "move", uid: wurmB.uid, lane: 3 });
    // B's own "moved" trigger + A's "friendlyCreatureMoved" trigger: 2 + 2
    expect(g.state.players[1].health).toBe(116);
  });

  it("ignores enemy moves", () => {
    const g = gameWith("arc-wurm");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!;
    const initial = collectInto(() => moveCreature(g, [], foe, 4)); // enemy creature moves
    runBatches(g, [], initial);
    expect(g.state.players[1].health).toBe(120);
  });
});

describe("Blood Boil (N to a creature, plus another N if a creature was destroyed this turn)", () => {
  it("deals 5 with no deaths this turn", () => {
    const g = gameWith("blood-boil");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(5);
    expect(g.state.players[1].lanes[0]).not.toBeNull(); // survives at 2 health
  });

  it("deals 5+5 in two packets after a creature was destroyed this turn", () => {
    const g = gameWith("blood-boil");
    const doomed = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    destroyCreature(g, [], doomed);
    runBatches(g, [], []); // death check -> deathLog
    expect(g.state.deathLog).toHaveLength(1);
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(g.state.players[1].lanes[0]).toBeNull(); // 10 damage destroys the 7-health hydra
    expect(g.state.deathLog.filter((d) => d.defId === "cavern-hydra")).toHaveLength(2);
  });
});

describe("Darkstone Asir (Forge: N per friendly Darkforged to a target enemy creature)", () => {
  it("counts itself and other friendly Darkforged", () => {
    const g = gameWith("darkstone-asir");
    spawnCreature(g, [], 0, "umbraskin-yeti", 1, { lane: 0 }); // Darkforged Yeti
    spawnCreature(g, [], 0, "shadowflame-elemental", 1, { lane: 1 }); // Darkforged Elemental
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 2/4, Darkforged Asir
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([foe.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(6); // 2 x 3 friendly Darkforged (yeti + elemental + itself)
  });

  it("offers no target when the enemy board is empty", () => {
    const g = gameWith("darkstone-asir");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.pending).toBeNull();
  });
});

describe("Frostspeaker Shaman (Defender; Activate: N damage to a creature or player)", () => {
  it("deals 2 to the enemy player", () => {
    const g = gameWith("frostspeaker-shaman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 2/7 Defender
    endRound(g);
    const shaman = g.state.players[0].lanes[1]!;
    expect(hasKeyword(shaman, "Defender")).toBe(true);
    applyAction(g, { type: "activate", uid: shaman.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreatureOrPlayer");
    expect(req.options).toContain(-1);
    expect(req.options).toContain(-2);
    applyChoice(g, { id: req.id, accepted: true, targetUid: -2 });
    expect(g.state.players[1].health).toBe(118);
  });

  it("deals 2 to a creature", () => {
    const g = gameWith("frostspeaker-shaman");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 })!; // 4/7
    endRound(g);
    const shaman = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "activate", uid: shaman.uid });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.damage).toBe(2);
  });
});

describe("Ignir, Khan of Ashur (4-level Forgeborn; end-of-turn burn)", () => {
  it("L1 deals 4 to the enemy player when no enemy creature is in play", () => {
    const g = gameWith("ignir-khan-of-ashur");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/4
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].health).toBe(116);
  });

  it("L3 deals 14 to a random enemy creature AND 14 to the enemy player", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "ignir-khan-of-ashur", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // 14/14
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7, the only enemy creature
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].lanes[1]).toBeNull(); // 14 damage destroys it
    expect(g.state.players[1].health).toBe(106); // 120 - 14
  });

  it("L4 deals 24 to EACH enemy creature and the enemy player", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "ignir-khan-of-ashur", 4);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // 24/24
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 4 });
    applyAction(g, { type: "endTurn" });
    expect(g.state.players[1].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[4]).toBeNull();
    expect(g.state.players[1].health).toBe(96); // 120 - 24
    expect(g.state.players[0].lanes[2]!.defId).toBe("ignir-khan-of-ashur"); // itself unharmed
  });

  it("does not trigger on the opponent's turn", () => {
    const g = gameWith("ignir-khan-of-ashur");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    endRound(g); // p0 endTurn burns once (116), p1 endTurn must not burn
    expect(g.state.players[1].health).toBe(116);
  });
});

describe("Kadrasian Stoneback (Flank: Negate its Defender this turn)", () => {
  it("loses Defender when it moves and gets it back at end of turn", () => {
    const g = gameWith("kadrasian-stoneback");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 6/6 Defender, Mobility 1
    const stoneback = g.state.players[0].lanes[2]!;
    expect(hasKeyword(stoneback, "Defender")).toBe(true);
    endRound(g);
    applyAction(g, { type: "move", uid: stoneback.uid, lane: 3 });
    expect(hasKeyword(stoneback, "Defender")).toBe(false);
    expect(canAttack(stoneback)).toBe(true); // offensive and no Defender
    applyAction(g, { type: "endTurn" }); // defender-restore granted ability fires
    expect(hasKeyword(stoneback, "Defender")).toBe(true);
    expect(stoneback.grantedAbilities).toHaveLength(0); // the restore removed itself
  });
});

describe("Pyre Mystic (enemy player gains health: deal 1x/2x/3x that much to the enemy player)", () => {
  it("deals 2x the enemy's heal back as damage at L2", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "pyre-mystic", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 9/9
    const initial = collectInto(() => healPlayer(g, [], 1, 6));
    runBatches(g, [], initial);
    expect(g.state.players[1].health).toBe(114); // 120 + 6 healed - 12 backlash
  });

  it("ignores its own player's heals", () => {
    const g = gameWith("pyre-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // L1, 5/5
    const initial = collectInto(() => healPlayer(g, [], 0, 5));
    runBatches(g, [], initial);
    expect(g.state.players[0].health).toBe(125);
    expect(g.state.players[1].health).toBe(120); // untouched
  });
});

describe("Shadowflame Elemental (static: each friendly Darkforged gets Aggressive)", () => {
  it("lets a freshly spawned friendly Darkforged attack immediately; non-Darkforged are unaffected", () => {
    const g = gameWith("cavern-hydra");
    const yeti = spawnCreature(g, [], 0, "umbraskin-yeti", 1, { lane: 0 })!; // Darkforged, defensive
    const hydra = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!; // not Darkforged, defensive
    refreshStatics(g);
    expect(canAttack(yeti)).toBe(false);
    spawnCreature(g, [], 0, "shadowflame-elemental", 1, { lane: 4 });
    refreshStatics(g);
    expect(canAttack(yeti)).toBe(true); // Aggressive from the aura overrides defensive
    expect(canAttack(hydra)).toBe(false); // not Darkforged: no aura
    const enemyYeti = spawnCreature(g, [], 1, "umbraskin-yeti", 1, { lane: 0 })!; // enemy side
    refreshStatics(g);
    expect(canAttack(enemyYeti)).toBe(false); // aura is friendly-only
  });
});

describe("Sparkweaver Acolyte (when you play a Tempys spell, +N attack this turn)", () => {
  it("gains +4 attack on your Tempys spell, ignores other factions' spells", () => {
    const g = gameWith("blood-boil");
    addToHand(g, 0, "sparkweaver-acolyte");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 4/6
    const acolyte = g.state.players[0].lanes[0]!;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 }); // Blood Boil: Tempys
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: g.state.players[1].lanes[1]!.uid });
    expect(acolyte.attack).toBe(4); // permanent value unchanged
    expect(getStats(g, acolyte).attack).toBe(8); // +4 this turn
    endRound(g); // temp buff wears off; fresh hand
    expect(getStats(g, acolyte).attack).toBe(4);
    addToHand(g, 0, "energy-surge"); // Alloyin spell
    applyAction(g, { type: "playCard", handIndex: 5 });
    expect(acolyte.tempMods).toHaveLength(0); // no trigger off a non-Tempys spell
  });
});

describe("Umbraskin Yeti (another friendly Darkforged enters: +N/+N)", () => {
  it("grows when another friendly Darkforged enters play", () => {
    const g = gameWith("umbraskin-yeti");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/6
    const yeti = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => spawnCreature(g, [], 0, "shadowflame-elemental", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect(yeti.attack).toBe(4);
    expect(yeti.health).toBe(7);
  });

  it("ignores enemy entries, non-Darkforged friendlies and its own entry", () => {
    const g = gameWith("umbraskin-yeti");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 3/6, its own entry does not count
    const yeti = g.state.players[0].lanes[0]!;
    expect(yeti.attack).toBe(3);
    const a = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })); // not Darkforged
    runBatches(g, [], a);
    const b = collectInto(() => spawnCreature(g, [], 1, "umbraskin-yeti", 1, { lane: 0 })); // enemy
    runBatches(g, [], b);
    expect(yeti.attack).toBe(3);
    expect(yeti.health).toBe(6);
  });
});

describe("Valifrax, Iztek's Champion (Flank: Iztek's Frost if opposed, else Iztek's Flame)", () => {
  it("puts a same-level Iztek's Frost into hand when it moves opposite an enemy creature", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "valifrax-izteks-champion", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // 8/12
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 }); // opposing the destination
    endRound(g);
    const valifrax = g.state.players[0].lanes[2]!;
    const handBefore = g.state.players[0].hand.length;
    applyAction(g, { type: "move", uid: valifrax.uid, lane: 3 });
    const hand = g.state.players[0].hand;
    expect(hand).toHaveLength(handBefore + 1);
    const gift = hand[hand.length - 1]!;
    expect(gift.defId).toBe("izteks-frost");
    expect(gift.level).toBe(2); // matches Valifrax's level
  });

  it("puts Iztek's Flame into hand when there is no opposing creature", () => {
    const g = gameWith("valifrax-izteks-champion");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/8 L1
    endRound(g);
    const valifrax = g.state.players[0].lanes[2]!;
    applyAction(g, { type: "move", uid: valifrax.uid, lane: 3 });
    const gift = g.state.players[0].hand[g.state.players[0].hand.length - 1]!;
    expect(gift.defId).toBe("izteks-flame");
    expect(gift.level).toBe(1);
  });
});

describe("Ice Grasp (player aura: your Tempys spells deal 2 damage to the enemy player)", () => {
  it("pings on Tempys spells (including its own cast — see header), not on other factions", () => {
    const g = gameWith("ice-grasp");
    addToHand(g, 0, "energy-surge"); // Alloyin spell
    applyAction(g, { type: "playCard", handIndex: 0 }); // the aura self-pings (see header note)
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].health).toBe(118);
    expect(g.state.playerEffects).toHaveLength(1);
    // non-Tempys spells do not trigger the aura
    applyAction(g, { type: "playCard", handIndex: 4 });
    expect(g.state.players[1].health).toBe(118);
    // end of turn discards the hand and redraws 5 (all Ice Grasps here)
    endRound(g);
    // the second cast: the first aura pings, and the new aura self-pings too
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].health).toBe(114);
    expect(g.state.playerEffects).toHaveLength(2);
    // Overload: both casts are removed from the game
    expect(g.state.players[0].removed.filter((i) => i.defId === "ice-grasp")).toHaveLength(2);
  });

  it("does not trigger on the opponent's Tempys spells", () => {
    const g = gameWith("ice-grasp");
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyAction(g, { type: "endTurn" }); // p1's turn
    const h0 = g.state.players[0].health;
    const h1 = g.state.players[1].health;
    addToHand(g, 1, "ice-grasp");
    applyAction(g, { type: "playCard", handIndex: 5 }); // p1's own aura self-pings p0
    expect(g.state.players[0].health).toBe(h0 - 2); // p1's aura only, not p0's
    expect(g.state.players[1].health).toBe(h1);
  });
});

describe("Patron of Kadras (Forge with 3+ Tempys cards in hand: friendlies get +N attack this turn)", () => {
  it("buffs each friendly creature including itself with a Tempys-heavy hand", () => {
    const g = gameWith("patron-of-kadras"); // all-Tempys hand
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/6
    const patron = g.state.players[0].lanes[2]!;
    expect(getStats(g, ally).attack).toBe(8); // 4 + 4 this turn
    expect(getStats(g, patron).attack).toBe(8); // itself included
    expect(ally.attack).toBe(4); // temp only
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, ally).attack).toBe(4); // wore off
  });

  it("does not trigger with fewer than 3 Tempys cards in hand", () => {
    const g = gameWith("cavern-hydra"); // non-Tempys hand
    addToHand(g, 0, "patron-of-kadras");
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    expect(getStats(g, ally).attack).toBe(4);
    expect(getStats(g, g.state.players[0].lanes[2]!).attack).toBe(4);
  });
});

describe("Phoenix Call (Spawn a Cryophoenix at the spell's level)", () => {
  it("spawns a 3/6 Cryophoenix that immediately burns the enemy player for 3 (no opposition)", () => {
    const g = gameWith("phoenix-call");
    applyAction(g, { type: "playCard", handIndex: 0 });
    const phoenix = g.state.players[0].lanes.find((c) => c?.defId === "cryophoenix");
    expect(phoenix).toBeTruthy();
    expect(phoenix!.attack).toBe(3);
    expect(phoenix!.health).toBe(6);
    expect(g.state.players[1].health).toBe(117); // enterPlay trigger, no opposing creature
  });

  it("L2 spawns a 7/10 that hits the opposing creature instead of the player", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "phoenix-call", 2);
    // fill every friendly lane except lane 2 so the Spawn lands there deterministically
    for (const lane of [0, 1, 3, 4]) spawnCreature(g, [], 0, "cavern-hydra", 1, { lane });
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!; // 4/7 opposing lane 2
    applyAction(g, { type: "playCard", handIndex: 5 });
    const phoenix = g.state.players[0].lanes[2]!;
    expect(phoenix.defId).toBe("cryophoenix");
    expect(phoenix.level).toBe(2);
    expect(foe.damage).toBe(7); // dealt its attack to the opposing creature
    expect(g.state.players[1].health).toBe(120); // player not hit
  });
});

describe("Cryophoenix (support: on enter/move, deal its attack to the opposition)", () => {
  it("deals its attack to the opposing creature when it moves", () => {
    const g = gameWith("cavern-hydra");
    // L3 has Mobility 1 (inherent), so it can move; 11/14
    const initial = collectInto(() => spawnCreature(g, [], 0, "cryophoenix", 3, { lane: 2 }));
    runBatches(g, [], initial); // the enterPlay burn fires inside the batch
    expect(g.state.players[1].health).toBe(109); // lane 2 unopposed -> enemy player
    const phoenix = g.state.players[0].lanes[2]!;
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 3 })!; // 11/15
    endRound(g);
    applyAction(g, { type: "move", uid: phoenix.uid, lane: 3 });
    expect(foe.damage).toBe(11); // dealt its attack to the opposing creature
    expect(g.state.players[1].health).toBe(109); // no extra player damage
  });
});

describe("Trial by Combat (friendly +N attack this turn, then mutual damage with an enemy)", () => {
  it("buffs the friendly creature, then the two deal their attacks to each other", () => {
    const g = gameWith("trial-by-combat");
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    const foe = spawnCreature(g, [], 1, "lightning-wyrm", 1, { lane: 1 })!; // 4/2
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    expect(req1.options).toEqual([ally.uid]);
    applyChoice(g, { id: req1.id, accepted: true, targetUid: ally.uid });
    expect(getStats(g, ally).attack).toBe(7); // 4 + 3 this turn
    const req2 = g.state.pending!.request; // chained enemy-creature pick
    expect(req2.kind).toBe("enemyCreature");
    expect(req2.options).toEqual([foe.uid]);
    applyChoice(g, { id: req2.id, accepted: true, targetUid: foe.uid });
    // the wyrm takes the hydra's 7 (buffed) attack and dies; the hydra takes 4
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(ally.damage).toBe(4);
    expect(g.state.players[0].lanes[0]).not.toBeNull();
    applyAction(g, { type: "endTurn" });
    expect(getStats(g, ally).attack).toBe(4); // the +3 wore off
  });

  it("only buffs when there is no enemy creature to fight", () => {
    const g = gameWith("trial-by-combat");
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: ally.uid });
    expect(g.state.pending).toBeNull(); // no second prompt
    expect(getStats(g, ally).attack).toBe(7);
  });
});
