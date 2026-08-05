import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, buffCreature, collectInto, createGame, destroyCreature, getCardScript,
  grantKeyword, keywordValue, legalActions, loadCards, runBatches, spawnCreature,
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

/** Inject extra cards into a hand (level-gated plays, Allied conditions). */
function addToHand(g: Game, p: PlayerId, defId: string, level = 1): void {
  g.state.players[p].hand.push({ uid: g.state.nextUid++, defId, level, owner: p });
}

/** Destroy a creature outside of combat, resolving its trigger batch (set3 helper). */
function slay(g: Game, uid: number): void {
  const c = g.state.players.flatMap((p) => p.lanes).find((x) => x?.uid === uid)!;
  const initial = collectInto(() => destroyCreature(g, [], c));
  runBatches(g, [], initial);
}

const IDS = [
  "abyssal-brute", "calamity-fiend", "crypt-slime", "dirge-banshee",
  "fell-strider", "howl-of-xith", "infernal-visage", "misery-demon",
  "necroflay", "portal-shade", "scythe-of-chiron", "sorrow-maiden",
  "soulreap", "soulscourge-grimgaunt", "spite-hydra", "tarsus-necrolord",
  "duskmaw-twilight-drake", "progeny-of-xith", "tendrils-of-twilight",
];

describe("Set 4 Nekrium registration", () => {
  it("all 19 cards (incl. the Solbind spell) have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Abyssal Brute (side-space entries get +N/+N and Regenerate N)", () => {
  it("buffs itself when played into a side space", () => {
    const g = gameWith("abyssal-brute");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const brute = g.state.players[0].lanes[0]!;
    expect([brute.attack, brute.health]).toEqual([5, 5]); // 4/4 + 1/1
    expect(keywordValue(brute, "Regenerate")).toBe(1);
  });

  it("buffs a friendly creature entering a side space, but not a middle space", () => {
    const g = gameWith("abyssal-brute");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // brute mid: no self-buff
    const brute = g.state.players[0].lanes[2]!;
    expect([brute.attack, brute.health]).toEqual([4, 4]);
    addToHand(g, 0, "technognome");
    applyAction(g, { type: "playCard", handIndex: 4, lane: 4 }); // side space
    const side = g.state.players[0].lanes[4]!;
    expect([side.attack, side.health]).toEqual([4, 4]); // 3/3 + 1/1
    expect(keywordValue(side, "Regenerate")).toBe(1);
    endRound(g);
    addToHand(g, 0, "technognome");
    const hi = g.state.players[0].hand.findIndex((c) => c.defId === "technognome");
    applyAction(g, { type: "playCard", handIndex: hi, lane: 3 }); // middle space
    const mid = g.state.players[0].lanes[3]!;
    expect([mid.attack, mid.health]).toEqual([3, 3]);
    expect(keywordValue(mid, "Regenerate")).toBe(0);
  });

  it("buffs friendly creatures that move into a side space (and itself)", () => {
    const g = gameWith("abyssal-brute");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // brute, not side
    addToHand(g, 0, "technognome");
    applyAction(g, { type: "playCard", handIndex: 4, lane: 3 }); // gnome, not side
    const brute = g.state.players[0].lanes[1]!;
    const gnome = g.state.players[0].lanes[3]!;
    expect([brute.attack, gnome.attack]).toEqual([4, 3]); // unbuffed
    grantKeyword([], gnome, { keyword: "Mobility", value: 1 });
    grantKeyword([], brute, { keyword: "Mobility", value: 1 });
    endRound(g);
    applyAction(g, { type: "move", uid: gnome.uid, lane: 4 }); // into a side space
    expect([gnome.attack, gnome.health]).toEqual([4, 4]);
    expect(keywordValue(gnome, "Regenerate")).toBe(1);
    applyAction(g, { type: "move", uid: brute.uid, lane: 0 }); // itself into a side space
    expect([brute.attack, brute.health]).toEqual([5, 5]);
    expect(keywordValue(brute, "Regenerate")).toBe(1);
  });
});

describe("Calamity Fiend (Assault: enemy creature -N/-N)", () => {
  it("debuffs a chosen enemy creature when its lane is unopposed", () => {
    const g = gameWith("calamity-fiend");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // lane 2 unopposed
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([foe.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: foe.uid });
    expect([foe.attack, foe.health]).toEqual([1, 1]); // 3/3 - 2/2
  });

  it("does not trigger when opposed", () => {
    const g = gameWith("calamity-fiend");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // opposed lane
    expect(g.state.pending).toBeNull();
    expect([g.state.players[1].lanes[2]!.attack]).toEqual([3]);
  });
});

describe("Crypt Slime (Vengeance: 1/1 Oozeling into this space)", () => {
  it("leaves a 1/1 Oozeling in its own space", () => {
    const g = gameWith("crypt-slime");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    slay(g, g.state.players[0].lanes[2]!.uid);
    const ooze = g.state.players[0].lanes[2];
    expect(ooze).toBeTruthy();
    expect(ooze!.defId).toBe("oozeling-green");
    expect([ooze!.attack, ooze!.health]).toEqual([1, 1]);
  });
});

describe("Dirge Banshee (Forge/Flank: opposing -N attack, this +N attack)", () => {
  it("drains the opposing creature on Forge and again after moving (Flank)", () => {
    const g = gameWith("dirge-banshee");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 3 });
    const [f2, f3] = [g.state.players[1].lanes[2]!, g.state.players[1].lanes[3]!];
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(f2.attack).toBe(1); // 3 - 2
    const banshee = g.state.players[0].lanes[2]!;
    expect(banshee.attack).toBe(4); // 2 + 2
    grantKeyword([], banshee, { keyword: "Mobility", value: 1 });
    endRound(g);
    applyAction(g, { type: "move", uid: banshee.uid, lane: 3 }); // Flank
    expect(f3.attack).toBe(1);
    expect(banshee.attack).toBe(6); // drains stack
  });

  it("does nothing when unopposed", () => {
    const g = gameWith("dirge-banshee");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes[2]!.attack).toBe(2);
  });
});

describe("Fell Strider (Vengeance: Spawn an N/M Zombie)", () => {
  it("spawns a 4/3 Zombie", () => {
    const g = gameWith("fell-strider");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    slay(g, g.state.players[0].lanes[1]!.uid);
    const zombie = g.state.players[0].lanes.find((c) => c?.defId === "zombie");
    expect(zombie).toBeTruthy();
    expect([zombie!.attack, zombie!.health]).toEqual([4, 3]);
  });
});

describe("Howl of Xith (3x Rank damage and lifegain)", () => {
  it("deals 3 and heals 3 at rank 1", () => {
    const g = gameWith("howl-of-xith", "technognome", 100);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.players[1].health).toBe(97);
    expect(g.state.players[0].health).toBe(103);
  });
});

describe("Infernal Visage (friendly side-space creatures +2N/+2N, Regenerate N)", () => {
  it("buffs only creatures in side spaces", () => {
    const g = gameWith("infernal-visage");
    spawnCreature(g, [], 0, "technognome", 1, { lane: 0 }); // side
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 }); // middle
    const [side, mid] = [g.state.players[0].lanes[0]!, g.state.players[0].lanes[2]!];
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect([side.attack, side.health]).toEqual([5, 5]); // 3/3 + 2/2
    expect(keywordValue(side, "Regenerate")).toBe(1);
    expect([mid.attack, mid.health]).toEqual([4, 7]);
    expect(keywordValue(mid, "Regenerate")).toBe(1); // inherent only — no Visage grant
  });
});

describe("Misery Demon (Assault: drain the enemy player)", () => {
  it("deals 3 to the enemy player and heals 3 when unopposed", () => {
    const g = gameWith("misery-demon", "technognome", 100);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[1].health).toBe(97);
    expect(g.state.players[0].health).toBe(103);
  });

  it("does not trigger when opposed", () => {
    const g = gameWith("misery-demon", "technognome", 100);
    spawnCreature(g, [], 1, "technognome", 1, { lane: 2 });
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[1].health).toBe(100);
    expect(g.state.players[0].health).toBe(100);
  });
});

describe("Necroflay (debuff + extra play)", () => {
  it("gives a creature -3/-3 and refunds the play", () => {
    const g = gameWith("necroflay");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 });
    const foe = g.state.players[1].lanes[0]!;
    expect(g.state.playsLeft).toBe(2);
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect([foe.attack, foe.health]).toEqual([1, 4]); // 4/7 - 3/3
    expect(g.state.playsLeft).toBe(2); // 2 - 1 + 1 extra play
  });
});

describe("Portal Shade (rank up: Spawn a random destroyed creature)", () => {
  it("spawns a copy from the discard pool when its controller gains a rank", () => {
    const g = gameWith("portal-shade", "technognome");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    slay(g, g.state.players[1].lanes[0]!.uid); // into the enemy discard
    for (let t = 0; t < 4; t++) endRound(g);
    expect(g.state.players[0].rank).toBe(2);
    const raised = g.state.players[0].lanes.find((c) => c?.defId === "technognome");
    expect(raised).toBeTruthy();
    expect([raised!.attack, raised!.health, raised!.level]).toEqual([3, 3, 1]);
    // never triggers on the opponent's rank-up: the enemy board stays empty
    expect(g.state.players[1].lanes.every((c) => c === null)).toBe(true);
  });
});

describe("Scythe of Chiron (L1/L2 spell drain, L3 creature Forge)", () => {
  it("L1: enemies -2 attack, a friendly creature +2 per enemy", () => {
    const g = gameWith("scythe-of-chiron");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3/3
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4/7
    spawnCreature(g, [], 0, "technognome", 1, { lane: 2 }); // friendly 3/3
    const [gnome, hydra, friend] = [
      g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!, g.state.players[0].lanes[2]!,
    ];
    applyAction(g, { type: "playCard", handIndex: 0 }); // a spell at L1: no lane
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    expect(req.options).toEqual([friend.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: friend.uid });
    expect(gnome.attack).toBe(1); // 3 - 2
    expect(hydra.attack).toBe(2); // 4 - 2
    expect(friend.attack).toBe(7); // 3 + 2*2 enemies
  });

  it("L3: enters play as Chiron, Herald of Torment and drains on Forge", () => {
    const g = gameWith("scythe-of-chiron");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 });
    const [gnome, hydra] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    addToHand(g, 0, "scythe-of-chiron", 3);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 }); // a creature at L3
    const chiron = g.state.players[0].lanes[2]!;
    expect(chiron.defId).toBe("scythe-of-chiron");
    expect([chiron.attack, chiron.health]).toEqual([24, 6]); // 12 + 6*2 enemies
    expect(gnome.attack).toBe(-3); // 3 - 6
    expect(hydra.attack).toBe(-2); // 4 - 6
  });
});

describe("Sorrow Maiden (Activate: destroy an enemy creature with <=cap attack)", () => {
  it("offers only enemy creatures at or below the cap and destroys the pick", () => {
    const g = gameWith("sorrow-maiden");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4 attack
    spawnCreature(g, [], 1, "technognome", 2, { lane: 2 }); // 9 attack
    const [gnome, hydra, big] = [
      g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!, g.state.players[1].lanes[2]!,
    ];
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    endRound(g);
    const maiden = g.state.players[0].lanes[3]!;
    applyAction(g, { type: "activate", uid: maiden.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([gnome.uid, hydra.uid]); // 9-attack creature gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: hydra.uid });
    expect(g.state.players[1].lanes[1]).toBeNull();
    expect(g.state.players[1].lanes[2]!.uid).toBe(big.uid);
  });

  it("cannot activate without a legal target", () => {
    const g = gameWith("sorrow-maiden");
    spawnCreature(g, [], 1, "technognome", 2, { lane: 0 }); // 9 attack > 4
    applyAction(g, { type: "playCard", handIndex: 0, lane: 3 });
    endRound(g);
    const maiden = g.state.players[0].lanes[3]!;
    expect(legalActions(g).some((a) => a.type === "activate" && a.uid === maiden.uid)).toBe(false);
  });
});

describe("Soulreap (destroy a low-attack enemy, Spawn a copy)", () => {
  it("destroys a 2-or-less attack enemy and copies it to your side", () => {
    const g = gameWith("soulreap");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3 attack
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 }); // 4 attack
    const [gnome, hydra] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    buffCreature(g, [], gnome, -2, 0); // down to 1 attack: legal target
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("enemyCreature");
    expect(req.options).toEqual([gnome.uid]); // hydra gated out
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(g.state.players[1].lanes[0]).toBeNull(); // destroyed
    const copy = g.state.players[0].lanes.find((c) => c?.defId === "technognome");
    expect(copy).toBeTruthy();
    expect([copy!.attack, copy!.health]).toEqual([3, 3]); // fresh base stats
  });
});

describe("Soulscourge Grimgaunt (Forge: +N/+N per creature destroyed this turn)", () => {
  it("counts both sides' dead creatures", () => {
    const g = gameWith("soulscourge-grimgaunt");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 });
    slay(g, g.state.players[0].lanes[0]!.uid);
    slay(g, g.state.players[0].lanes[1]!.uid);
    slay(g, g.state.players[1].lanes[0]!.uid);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const gg = g.state.players[0].lanes[2]!;
    expect([gg.attack, gg.health]).toEqual([8, 8]); // 2/2 + 2*3 creatures
  });

  it("gets nothing when nothing died", () => {
    const g = gameWith("soulscourge-grimgaunt");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect([g.state.players[0].lanes[2]!.attack]).toEqual([2]);
  });
});

describe("Spite Hydra (battle-damage growth; Allied Tempys Activate)", () => {
  it("gets +1/+1 when it deals battle damage to a creature", () => {
    const g = gameWith("spite-hydra", "technognome");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3/3
    endRound(g);
    applyAction(g, { type: "battle" });
    const hydra = g.state.players[0].lanes[0]!;
    expect([hydra.attack, hydra.health]).toEqual([6, 6]); // 5/5 + 1/1
    expect(hydra.damage).toBe(3); // took the gnome's 3
    expect(g.state.players[1].lanes[0]).toBeNull(); // gnome died
  });

  it("Allied Tempys: Activate deals 1 to another creature and grows", () => {
    const g = gameWith("spite-hydra");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    spawnCreature(g, [], 1, "technognome", 1, { lane: 1 });
    const gnome = g.state.players[1].lanes[1]!;
    const hydra = g.state.players[0].lanes[0]!;
    endRound(g);
    expect(legalActions(g).some((a) => a.type === "activate" && a.uid === hydra.uid)).toBe(false);
    addToHand(g, 0, "lightning-spark"); // Allied Tempys
    applyAction(g, { type: "activate", uid: hydra.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([gnome.uid]); // "another creature": not itself
    applyChoice(g, { id: req.id, accepted: true, targetUid: gnome.uid });
    expect(gnome.damage).toBe(1);
    expect([hydra.attack, hydra.health]).toEqual([6, 6]);
  });
});

describe("Tarsus Necrolord (Forge zombie per friendly death; zombie-entry buff)", () => {
  it("spawns a 3/3 Zombie per friendly creature destroyed this turn and grows", () => {
    const g = gameWith("tarsus-necrolord");
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 });
    spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 });
    slay(g, g.state.players[0].lanes[0]!.uid);
    slay(g, g.state.players[0].lanes[1]!.uid);
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    const p0 = g.state.players[0];
    const zombies = p0.lanes.filter((c) => c?.defId === "zombie");
    expect(zombies).toHaveLength(2);
    for (const z of zombies) expect([z!.attack, z!.health]).toEqual([3, 3]);
    const tarsus = p0.lanes[2]!;
    expect([tarsus.attack, tarsus.health]).toEqual([6, 6]); // 4/4 + 1/1 per zombie entry
  });

  it("spawns nothing when no friendly creature died", () => {
    const g = gameWith("tarsus-necrolord");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    expect(g.state.players[0].lanes.filter((c) => c?.defId === "zombie")).toHaveLength(0);
    expect([g.state.players[0].lanes[2]!.attack]).toEqual([4]);
  });
});

describe("Duskmaw, Twilight Drake (Solbind Tendrils of Twilight)", () => {
  it("Solbind adds a Tendrils of Twilight to the deck at game start", () => {
    const g = gameWith("duskmaw-twilight-drake");
    const p0 = g.state.players[0];
    const all = [...p0.deck, ...p0.hand].map((c) => c.defId);
    expect(all).toHaveLength(31); // 30 + 1 bound
    expect(all).toContain("tendrils-of-twilight");
  });

  it("Tendrils: -7/-7 opposing a friendly Duskmaw, -1/-1 otherwise, and Free", () => {
    const g = gameWith("duskmaw-twilight-drake");
    spawnCreature(g, [], 1, "technognome", 1, { lane: 0 }); // 3/3, never opposed
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 1 }); // 7/10, will be opposed
    const [gnome, hydra] = [g.state.players[1].lanes[0]!, g.state.players[1].lanes[1]!];
    addToHand(g, 0, "tendrils-of-twilight");
    addToHand(g, 0, "tendrils-of-twilight");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // Duskmaw opposes the hydra
    expect(g.state.playsLeft).toBe(1);
    const play = (defId: string, target: number) => {
      const hi = g.state.players[0].hand.findIndex((c) => c.defId === defId);
      applyAction(g, { type: "playCard", handIndex: hi });
      applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: target });
    };
    play("tendrils-of-twilight", hydra.uid);
    play("tendrils-of-twilight", gnome.uid);
    expect(g.state.playsLeft).toBe(1); // both Tendrils were Free
    expect([hydra.attack, hydra.health]).toEqual([0, 3]); // 7/10 - 7/7
    expect([gnome.attack, gnome.health]).toEqual([2, 2]); // 3/3 - 1/1
  });
});

describe("Progeny of Xith (Vengeance: Spawn a level+1 copy)", () => {
  it("chains L1 -> L2 -> L3, then stops", () => {
    const g = gameWith("progeny-of-xith");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 });
    slay(g, g.state.players[0].lanes[2]!.uid);
    let progeny = g.state.players[0].lanes.find((c) => c?.defId === "progeny-of-xith");
    expect(progeny).toBeTruthy();
    expect([progeny!.level, progeny!.attack, progeny!.health]).toEqual([2, 4, 4]);
    slay(g, progeny!.uid);
    progeny = g.state.players[0].lanes.find((c) => c?.defId === "progeny-of-xith");
    expect([progeny!.level, progeny!.attack, progeny!.health]).toEqual([3, 6, 6]);
    slay(g, progeny!.uid); // L3 has no Vengeance
    expect(g.state.players[0].lanes.every((c) => c === null)).toBe(true);
  });
});
