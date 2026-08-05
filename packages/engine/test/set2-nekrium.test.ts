import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, destroyCreature, getCardScript,
  healPlayer, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set2 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.json", import.meta.url), "utf8")) as ScrapedSet;
const set22 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_2.2.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set2, set22);

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

describe("Set 2 Nekrium script registration", () => {
  it("registers every Set 2 Nekrium card", () => {
    const scripted = [
      "byzerak-drake", "cercee-hand-of-varna", "corpulent-shambler", "crypt-conjurer",
      "darkfrost-reaper", "death-current", "ebonskull-knight", "ghastly-renewal",
      "gloomfiend", "gloomspire-wurm", "group-meal", "nightgaunt", "nyrali-ooze",
      "onyxium-phantasm", "organ-harvester", "shallow-grave", "spiritleash",
      "varnas-pact", "vyrics-embrace", "xithian-rotfiend", "xraths-will",
    ];
    for (const id of scripted) expect(getCardScript(id), id).not.toBeNull();
  });
});

describe("Byzerak Drake (Allied Tempys: Mobility N)", () => {
  it("gains Mobility 1 when a Tempys card is in hand", () => {
    const g = gameWith("byzerak-drake");
    g.state.players[0].hand.push({ uid: 9001, defId: "lightning-spark", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const drake = g.state.players[0].lanes[2]!;
    expect(keywordValue(drake, "Mobility")).toBe(1);
    expect(keywordValue(drake, "Regenerate")).toBe(1); // inherent
  });

  it("gets no Mobility without a Tempys card in hand", () => {
    const g = gameWith("byzerak-drake");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(keywordValue(g.state.players[0].lanes[2]!, "Mobility")).toBe(0);
  });
});

describe("Cercee, Hand of Varna (battle damage destroys creatures)", () => {
  it("L1 destroys the level 1 creature it battles", () => {
    const g = gameWith("cercee-hand-of-varna");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // cercee 1/6
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // p1 hydra L1 4/7
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    expect(g.state.players[1].lanes[0]).toBeNull(); // destroyed with 6 health left
    expect(g.state.players[0].lanes[0]!.damage).toBe(4); // cercee survives
  });

  it("L1 does not destroy a level 2 creature", () => {
    const g = gameWith("cercee-hand-of-varna");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyAction(g, { type: "endTurn" });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 0 }); // 7/10 level 2, defensive
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "battle" });
    const hydra = g.state.players[1].lanes[0];
    expect(hydra).not.toBeNull();
    expect(hydra!.damage).toBe(1); // only the battle damage
  });

  it("L4 deals damage equal to the player's health when it hits them", () => {
    const g = gameWith("cercee-hand-of-varna");
    spawnCreature(g, [], 0, "cercee-hand-of-varna", 4, { lane: 2 }); // 7/40
    passTurns(g, 2); // back to p0, cercee offensive
    g.state.players[1].health = 20;
    applyAction(g, { type: "battle" }); // 7 battle damage, then 13 more
    expect(g.state.players[1].health).toBe(0);
    expect(g.state.winner).toBe(0);
  });
});

describe("Corpulent Shambler (Vengeance: 3/3 Zombie)", () => {
  it("puts a 3/3 Zombie into its space", () => {
    const g = gameWith("corpulent-shambler");
    spawnCreature(g, [], 0, "corpulent-shambler", 1, { lane: 3 });
    slay(g, g.state.players[0].lanes[3]!.uid);
    const token = g.state.players[0].lanes[3];
    expect(token?.defId).toBe("zombie");
    expect([token?.attack, token?.health]).toEqual([3, 3]);
  });
});

describe("Crypt Conjurer (Nekrium spellPlayed: drain N)", () => {
  it("drains 2 when you play a Nekrium spell, ignores other factions", () => {
    const g = gameWith("nether-embrace");
    spawnCreature(g, [], 0, "crypt-conjurer", 1, { lane: 0 });
    applyAction(g, { type: "playCard", handIndex: 0 }); // nether-embrace L1: 4 dmg, +4 health
    expect(g.state.players[1].health).toBe(120 - 4 - 2);
    expect(g.state.players[0].health).toBe(120 + 4 + 2);
    g.state.players[0].hand.push({ uid: 9002, defId: "energy-surge", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: g.state.players[0].hand.length - 1 }); // Alloyin: no drain
    expect(g.state.players[1].health).toBe(120 - 4 - 2);
    expect(g.state.players[0].health).toBe(120 + 4 + 2);
  });
});

describe("Darkfrost Reaper (Forge: destroy each creature with <=1 attack)", () => {
  it("destroys 1-attack creatures on both sides, spares the rest", () => {
    const g = gameWith("darkfrost-reaper");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0, overrideStats: { attack: 1, health: 5 } });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1, overrideStats: { attack: 2, health: 5 } });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 2, overrideStats: { attack: 1, health: 4 } });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 4 }); // reaper 6/5
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[0].lanes[1]).not.toBeNull();
    expect(g.state.players[0].lanes[4]!.defId).toBe("darkfrost-reaper"); // itself survives
  });
});

describe("Death Current (random enemy destruction)", () => {
  it("L1 only destroys a level 2 or lower enemy creature", () => {
    const g = gameWith("death-current");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[2]).not.toBeNull();
  });

  it("L3 destroys two enemy creatures", () => {
    const g = gameWith("death-current");
    g.state.players[0].hand[0]!.level = 3;
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 3, { lane: 3 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].lanes.filter(Boolean)).toHaveLength(1);
  });
});

describe("Ebonskull Knight (destroyed when you gain a Rank)", () => {
  it("is destroyed at your rank-up", () => {
    const g = gameWith("ebonskull-knight");
    spawnCreature(g, [], 0, "ebonskull-knight", 1, { lane: 0 });
    g.state.players[0].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // p0 ranks up
    expect(g.state.players[0].rank).toBe(2);
    expect(g.state.players[0].lanes[0]).toBeNull();
  });

  it("survives the opponent's rank-up", () => {
    const g = gameWith("ebonskull-knight");
    spawnCreature(g, [], 0, "ebonskull-knight", 1, { lane: 0 });
    applyAction(g, { type: "endTurn" }); // p1's turn
    g.state.players[1].turnInRank = 4;
    applyAction(g, { type: "endTurn" }); // p1 ranks up
    expect(g.state.players[1].rank).toBe(2);
    expect(g.state.players[0].lanes[0]).not.toBeNull();
  });
});

describe("Ghastly Renewal (two friendly creatures get Regenerate N)", () => {
  it("chains two targets and grants Regenerate 2 to each", () => {
    const g = gameWith("ghastly-renewal");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const a = g.state.players[0].lanes[0]!;
    const b = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: a.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("friendlyCreature");
    expect(req2.options).toEqual([b.uid]); // first target excluded
    applyChoice(g, { id: req2.id, accepted: true, targetUid: b.uid });
    expect(g.state.pending).toBeNull();
    expect(keywordValue(a, "Regenerate")).toBe(2);
    expect(keywordValue(b, "Regenerate")).toBe(2);
  });

  it("grants Regenerate only once with a single friendly creature", () => {
    const g = gameWith("ghastly-renewal");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    const a = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: a.uid });
    expect(g.state.pending).toBeNull();
    expect(keywordValue(a, "Regenerate")).toBe(2); // not 4
  });
});

describe("Gloomfiend (Forge: optional enemy -N/-N)", () => {
  it("accepted: gives the enemy creature -1/-1", () => {
    const g = gameWith("gloomfiend");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.optional).toBe(true);
    expect(req.options).toEqual([hydra.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([3, 6]);
  });

  it("declined: no debuff", () => {
    const g = gameWith("gloomfiend");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: false });
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([4, 7]);
  });
});

describe("Gloomspire Wurm (Forge: +4/+4 when no enemy creatures)", () => {
  it("grows to 8/8 with an empty enemy board", () => {
    const g = gameWith("gloomspire-wurm");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([8, 8]);
  });

  it("stays 4/4 when an enemy creature is present", () => {
    const g = gameWith("gloomspire-wurm");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([4, 4]);
  });
});

describe("Group Meal (enemy -N attack, friendly +N attack)", () => {
  it("shifts 2 attack at L1, health untouched", () => {
    const g = gameWith("group-meal");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect([g.state.players[0].lanes[0]!.attack, g.state.players[0].lanes[0]!.health]).toEqual([6, 7]);
    expect([g.state.players[1].lanes[1]!.attack, g.state.players[1].lanes[1]!.health]).toEqual([2, 7]);
  });
});

describe("Nightgaunt (creature destroyed -> Regenerate 1)", () => {
  it("gains stacking Regenerate 1 per creature destroyed", () => {
    const g = gameWith("nightgaunt");
    spawnCreature(g, [], 0, "nightgaunt", 1, { lane: 0 });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 1 });
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 2 });
    const ng = g.state.players[0].lanes[0]!;
    slay(g, g.state.players[1].lanes[1]!.uid);
    expect(keywordValue(ng, "Regenerate")).toBe(1);
    slay(g, g.state.players[1].lanes[2]!.uid);
    expect(keywordValue(ng, "Regenerate")).toBe(2);
  });
});

describe("Nyrali Ooze (Vengeance: N/N Oozeling)", () => {
  it("L1 puts a 4/4 Oozeling into its space", () => {
    const g = gameWith("nyrali-ooze");
    spawnCreature(g, [], 0, "nyrali-ooze", 1, { lane: 1 });
    slay(g, g.state.players[0].lanes[1]!.uid);
    const token = g.state.players[0].lanes[1];
    expect(token?.defId).toBe("oozeling-green");
    expect([token?.attack, token?.health]).toEqual([4, 4]);
  });

  it("L3 puts an 11/11 Oozeling", () => {
    const g = gameWith("nyrali-ooze");
    spawnCreature(g, [], 0, "nyrali-ooze", 3, { lane: 2 });
    slay(g, g.state.players[0].lanes[2]!.uid);
    const token = g.state.players[0].lanes[2];
    expect(token?.defId).toBe("oozeling-green");
    expect([token?.attack, token?.health]).toEqual([11, 11]);
  });
});

describe("Onyxium Phantasm (Allied Alloyin: Activate -N attack)", () => {
  it("gains the Activate with an Alloyin card in hand and uses it", () => {
    const g = gameWith("onyxium-phantasm");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[1].lanes[1]!;
    g.state.players[0].hand.push({ uid: 9003, defId: "energy-surge", level: 1, owner: 0 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const phantasm = g.state.players[0].lanes[0]!;
    phantasm.defensive = false;
    applyAction(g, { type: "activate", uid: phantasm.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.attack).toBe(0); // 4 - 4
  });

  it("has no Activate without an Alloyin card in hand", () => {
    const g = gameWith("onyxium-phantasm");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const phantasm = g.state.players[0].lanes[0]!;
    expect(keywordValue(phantasm, "Regenerate")).toBe(1); // inherent stays
    phantasm.defensive = false;
    expect(() => applyAction(g, { type: "activate", uid: phantasm.uid })).toThrow();
  });
});

describe("Organ Harvester (Activate, destroy itself: destroy a low-level creature)", () => {
  it("L1 destroys itself and the chosen level 1 creature", () => {
    const g = gameWith("organ-harvester");
    spawnCreature(g, [], 0, "organ-harvester", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 3 });
    const harvester = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[2]!;
    harvester.defensive = false;
    applyAction(g, { type: "activate", uid: harvester.uid });
    const req = g.state.pending!.request;
    expect(req.options).toContain(foe.uid);
    expect(req.options).not.toContain(g.state.players[1].lanes[3]!.uid); // level 2 ineligible
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect(g.state.players[0].lanes[0]).toBeNull();
    expect(g.state.players[1].lanes[2]).toBeNull();
  });
});

describe("Shallow Grave (friendly creature gets Vengeance: Spawn this this turn)", () => {
  it("respawns the creature when destroyed this turn", () => {
    const g = gameWith("shallow-grave");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect(hydra.grantedAbilities).toContain("shared:vengeance-spawn-self");
    slay(g, hydra.uid);
    const back = g.state.players[0].lanes[1];
    expect(back?.defId).toBe("cavern-hydra");
    expect(back?.uid).not.toBe(hydra.uid);
  });

  it("the granted Vengeance expires at end of turn", () => {
    const g = gameWith("shallow-grave");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    const hydra = g.state.players[0].lanes[1]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    applyAction(g, { type: "endTurn" }); // keeper-expire cleans up
    expect(hydra.grantedAbilities).not.toContain("shared:vengeance-spawn-self");
    slay(g, hydra.uid);
    expect(g.state.players[0].lanes[1]).toBeNull();
  });

  it("L1 cannot target a level 3 creature", () => {
    const g = gameWith("shallow-grave");
    spawnCreature(g, [], 0, "cavern-hydra", 3, { lane: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no legal target: fizzle
  });
});

describe("Spirit Reaver (Set 2.2; when the enemy player gains health: +N/+N)", () => {
  it("has data and a registered script", () => {
    expect(cards["spirit-reaver"]).toBeTruthy();
    expect(getCardScript("spirit-reaver")).not.toBeNull();
  });

  it("grows on enemy heals only", () => {
    const g = gameWith("spirit-reaver");
    spawnCreature(g, [], 0, "spirit-reaver", 1, { lane: 2 });
    const reaver = g.state.players[0].lanes[2]!;
    const heal = (p: PlayerId, n: number) =>
      runBatches(g, [], collectInto(() => healPlayer(g, [], p, n)));
    heal(0, 5); // its own controller: no trigger
    expect([reaver.attack, reaver.health]).toEqual([4, 6]);
    heal(1, 3); // enemy heal: +2/+2
    expect([reaver.attack, reaver.health]).toEqual([6, 8]);
    heal(1, 10); // flat +2/+2 per heal event, not per point
    expect([reaver.attack, reaver.health]).toEqual([8, 10]);
  });
});

describe("Spiritleash (destroy a friendly creature, buff a creature +N/+N)", () => {
  it("chains the sacrifice into a +5/+5 buff on any creature", () => {
    const g = gameWith("spiritleash");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const friend = g.state.players[0].lanes[0]!;
    const foe = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req1 = g.state.pending!.request;
    expect(req1.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req1.id, accepted: true, targetUid: friend.uid });
    const req2 = g.state.pending!.request;
    expect(req2.kind).toBe("anyCreature");
    expect(req2.options).toEqual([foe.uid]); // sacrifice excluded
    applyChoice(g, { id: req2.id, accepted: true, targetUid: foe.uid });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[0].lanes[0]).toBeNull(); // sacrifice destroyed
    expect([foe.attack, foe.health]).toEqual([9, 12]); // 4/7 + 5/5
  });

  it("fizzles with no friendly creature on board", () => {
    const g = gameWith("spiritleash");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect([g.state.players[1].lanes[2]!.attack, g.state.players[1].lanes[2]!.health]).toEqual([4, 7]);
  });
});

describe("Varna's Pact (raise random destroyed creatures)", () => {
  it("puts a creature from a discard pile into one of your spaces", () => {
    const g = gameWith("varnas-pact");
    g.state.players[1].discard.push({ uid: 9004, defId: "cavern-hydra", level: 2, owner: 1 });
    applyAction(g, { type: "playCard", handIndex: 0 });
    const raised = g.state.players[0].lanes.find((c) => c?.defId === "cavern-hydra");
    expect(raised).toBeDefined();
    expect(raised?.owner).toBe(0);
    expect(raised?.level).toBe(2);
  });

  it("does nothing when no creature was destroyed this game", () => {
    const g = gameWith("varnas-pact");
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[0].lanes.every((c) => !c)).toBe(true);
  });
});

describe("Vyric's Embrace (-N/-N and gain N health)", () => {
  it("gives a creature -4/-4 and heals you for 4", () => {
    const g = gameWith("vyrics-embrace");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 });
    const hydra = g.state.players[1].lanes[2]!;
    g.state.players[0].health = 100;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: hydra.uid });
    expect([hydra.attack, hydra.health]).toEqual([0, 3]);
    expect(g.state.players[0].health).toBe(104);
  });
});

describe("Xithian Rotfiend (-N/-N when it becomes opposed)", () => {
  it("gets -1/-1 when an enemy creature enters the opposing space, not other lanes", () => {
    const g = gameWith("xithian-rotfiend", "ashurian-mystic");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // rotfiend 7/8
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 }); // enemy elsewhere: no debuff
    const rot = g.state.players[0].lanes[2]!;
    expect([rot.attack, rot.health]).toEqual([7, 8]);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // enemy opposed: -1/-1
    expect([rot.attack, rot.health]).toEqual([6, 7]);
  });

  it("gets -1/-1 when played into an opposed space", () => {
    const g = gameWith("xithian-rotfiend", "ashurian-mystic");
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // p1 mystic
    applyAction(g, { type: "endTurn" });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // rotfiend opposed
    const rot = g.state.players[0].lanes[1]!;
    expect([rot.attack, rot.health]).toEqual([6, 7]);
  });
});

describe("Xrath's Will (destroy low-attack enemy, extra play)", () => {
  it("destroys an enemy creature with 3 or less attack and refunds the play", () => {
    const g = gameWith("xraths-will");
    spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 2 }); // 3 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 }); // 4 attack: too big
    const mystic = g.state.players[1].lanes[2]!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.playsLeft).toBe(1);
    const req = g.state.pending!.request;
    expect(req.options).toEqual([mystic.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: mystic.uid });
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.players[1].lanes[3]).not.toBeNull();
    expect(g.state.playsLeft).toBe(2); // additional (Zombie) play granted
  });
});
