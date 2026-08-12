import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, collectInto, createGame, dealCreatureDamage, destroyCreature,
  getCardScript, hasKeyword, keywordValue, loadCards, runBatches, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "../src/index.js";

const set6 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.json", import.meta.url), "utf8")) as ScrapedSet;
const set61 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.1.json", import.meta.url), "utf8")) as ScrapedSet;
const set62 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_6.2.json", import.meta.url), "utf8")) as ScrapedSet;
const set1 = JSON.parse(readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet; // cavern-hydra + lightning-wyrm + ashurian-mystic
const cards = loadCards(set6, set61, set62, set1);

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
  "ariadne-spider-queen", "blood-bindings", "darkheart-conjurer", "darkshard-witch",
  "demonweb-watcher", "grimgaunt-betrayer", "nether-decay", "plunder-imp",
  "shadeclaw-zombie", "xerxes-the-executioner", "zombie-dreadknight",
  "infernal-ritual", "patron-of-tarsus", "grimgaunt-warrior", "remembrance",
  // support cards scripted in the same file
  "spiderling", "dysian-infusion",
];

describe("Set 6 Nekrium registration", () => {
  it("all 15 cards + 2 support cards have data and a registered script", () => {
    for (const id of IDS) {
      expect(cards[id], id).toBeTruthy();
      expect(getCardScript(id), id).toBeTruthy();
    }
  });
});

describe("Ariadne, Spider Queen (Solbind 2x Spiderling; Activate: destroy a Web, gain its stats)", () => {
  it("adds exactly two Spiderlings to the deck at game start", () => {
    const g = gameWith("ariadne-spider-queen");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand];
    expect(all).toHaveLength(32);
    expect(all.filter((i) => i.defId === "spiderling")).toHaveLength(2);
  });

  it("Activate destroys an enemy Web and gains its current stats", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "ariadne-spider-queen");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 3/8
    const web = spawnCreature(g, [], 1, "web", 1, { lane: 1, overrideStats: { attack: 5, health: 6 } })!;
    endRound(g);
    const ariadne = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: ariadne.uid });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("anyCreature");
    expect(req.options).toEqual([web.uid]);
    applyChoice(g, { id: req.id, accepted: true, targetUid: web.uid });
    expect(ariadne.attack).toBe(8); // 3 + 5
    expect(ariadne.health).toBe(14); // 8 + 6
    expect(g.state.players[1].lanes[1]).toBeNull(); // the Web was destroyed
    expect(g.state.players[1].discard.some((i) => i.defId === "web")).toBe(true);
  });

  it("cannot activate with no Web in play", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "ariadne-spider-queen");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    endRound(g);
    const ariadne = g.state.players[0].lanes[0]!;
    expect(() => applyAction(g, { type: "activate", uid: ariadne.uid })).toThrow();
  });
});

describe("Spiderling (Forge: replace the opposing level-capped creature with a Web)", () => {
  it("replaces an opposing level 1 creature with a Web that copies its stats and has Defender", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 }); // 4/7
    addToHand(g, 0, "spiderling");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    const web = g.state.players[1].lanes[2]!;
    expect(web.defId).toBe("web");
    expect(web.owner).toBe(1); // the Web belongs to the replaced creature's owner
    expect(web.attack).toBe(4); // copied from the hydra
    expect(web.health).toBe(7);
    expect(hasKeyword(web, "Defender")).toBe(true);
    // a replace, not a death: the hydra is in the discard but not in the death log
    expect(g.state.players[1].discard.some((i) => i.defId === "cavern-hydra" && i.level === 1)).toBe(true);
    expect(g.state.deathLog).toHaveLength(0);
  });

  it("L1 cannot replace a level 2 creature", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 }); // level 2
    addToHand(g, 0, "spiderling");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    expect(g.state.players[1].lanes[2]!.defId).toBe("cavern-hydra");
  });

  it("L2 replaces a level 2 creature and grants Defender (scraper gap at L2)", () => {
    const g = gameWith("cavern-hydra");
    spawnCreature(g, [], 1, "cavern-hydra", 2, { lane: 2 }); // 7/10
    addToHand(g, 0, "spiderling", 2);
    applyAction(g, { type: "playCard", handIndex: 5, lane: 2 });
    const web = g.state.players[1].lanes[2]!;
    expect(web.defId).toBe("web");
    expect(web.level).toBe(2);
    expect(web.attack).toBe(7);
    expect(web.health).toBe(10);
    expect(hasKeyword(web, "Defender")).toBe(true);
  });
});

describe("Blood Bindings (-N/-N, doubled if a creature was destroyed this turn)", () => {
  it("gives -3/-3 with no deaths this turn", () => {
    const g = gameWith("blood-bindings");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(1);
    expect(foe.health).toBe(4);
  });

  it("gives -6/-6 after a creature was destroyed this turn", () => {
    const g = gameWith("blood-bindings");
    const doomed = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    destroyCreature(g, [], doomed);
    runBatches(g, [], []); // death check -> deathLog
    expect(g.state.deathLog).toHaveLength(1);
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.attack).toBe(-2); // 4 - 6
    expect(foe.health).toBe(1); // 7 - 6
  });
});

describe("Darkheart Conjurer (Solbind Dysian Infusion; when you play a spell, friendly creature gets Regenerate N)", () => {
  it("adds one Dysian Infusion to the deck at game start", () => {
    const g = gameWith("darkheart-conjurer");
    const all = [...g.state.players[0].deck, ...g.state.players[0].hand];
    expect(all).toHaveLength(31);
    expect(all.filter((i) => i.defId === "dysian-infusion")).toHaveLength(1);
  });

  it("triggers on your spell after it resolves; can target itself", () => {
    // neutral deck + injected cards: the Solbind copy would shuffle into the hand
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "darkheart-conjurer");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 4/7
    const conjurer = g.state.players[0].lanes[0]!;
    addToHand(g, 0, "dysian-infusion");
    applyAction(g, { type: "playCard", handIndex: 5 });
    // the spell's own prompt comes first
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: conjurer.uid });
    expect(conjurer.attack).toBe(8); // 4 + 4 from the infusion
    expect(conjurer.health).toBe(11); // 7 + 4
    expect(keywordValue(conjurer, "Regenerate")).toBe(1);
    // then the conjurer's spellPlayed trigger prompts
    const req = g.state.pending!.request;
    expect(req.kind).toBe("friendlyCreature");
    applyChoice(g, { id: req.id, accepted: true, targetUid: conjurer.uid });
    expect(keywordValue(conjurer, "Regenerate")).toBe(2); // 1 + 1
  });

  it("does not trigger on the enemy player's spells", () => {
    const g = gameWith("cavern-hydra", "blood-bindings");
    addToHand(g, 0, "darkheart-conjurer");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // conjurer
    const conjurer = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "endTurn" }); // p1's turn, hand is 5 Blood Bindings
    applyAction(g, { type: "playCard", handIndex: 0 }); // enemy spell targeting prompt
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: conjurer.uid });
    expect(g.state.pending).toBeNull(); // no conjurer prompt
    expect(keywordValue(conjurer, "Regenerate")).toBe(0);
  });
});

describe("Darkshard Witch (Forge: N damage to the enemy player, gain N health per friendly Darkforged)", () => {
  it("deals 2 to the enemy player and gains 2 per friendly Darkforged including itself", () => {
    const g = gameWith("darkshard-witch");
    spawnCreature(g, [], 0, "shadeclaw-zombie", 1, { lane: 0 }); // Darkforged Zombie
    spawnCreature(g, [], 0, "grimgaunt-betrayer", 1, { lane: 1 }); // Darkforged Grimgaunt
    spawnCreature(g, [], 1, "shadeclaw-zombie", 1, { lane: 0 }); // enemy Darkforged: not counted
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5/4, Darkforged Human
    const witch = g.state.players[0].lanes[2]!;
    expect(g.state.players[1].health).toBe(118); // 120 - 2
    expect(witch.health).toBe(10); // 4 + 2*3 friendly Darkforged
  });
});

describe("Demonweb Watcher (enemy Aggressive creature deals battle damage: it gets -N/-N)", () => {
  it("debuffs an enemy Aggressive creature that deals battle damage to another friendly creature", () => {
    const g = gameWith("demonweb-watcher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 4/7
    spawnCreature(g, [], 0, "web", 1, { lane: 2 }); // 0/1 Defender blocker
    const wyrm = spawnCreature(g, [], 1, "lightning-wyrm", 1, { lane: 2 })!; // 4/2 Aggressive
    applyAction(g, { type: "battle" });
    // the wyrm dealt 4 battle damage to the web; the watcher debuffed it -2/-2 -> 2/0 -> dead
    expect(g.state.players[1].lanes[2]).toBeNull();
    expect(g.state.deathLog.some((d) => d.defId === "lightning-wyrm")).toBe(true);
    expect(g.state.players[0].lanes[1]!.defId).toBe("demonweb-watcher"); // watcher unharmed
    expect(wyrm.health).toBe(0); // debuff landed before it died
  });

  it("debuffs an enemy Aggressive creature that deals battle damage to the Watcher itself", () => {
    const g = gameWith("demonweb-watcher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 }); // 4/7
    const watcher = g.state.players[0].lanes[1]!;
    const mystic = spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 1 })!; // 3/5 Aggressive
    const initial = collectInto(() => dealCreatureDamage(g, [], watcher, 3, mystic, true));
    runBatches(g, [], initial);
    expect(watcher.damage).toBe(3);
    expect(mystic.attack).toBe(1); // 3 - 2
    expect(mystic.health).toBe(3); // 5 - 2
  });

  it("ignores non-battle damage and attackers without Aggressive", () => {
    const g = gameWith("demonweb-watcher");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const watcher = g.state.players[0].lanes[1]!;
    const mystic = spawnCreature(g, [], 1, "ashurian-mystic", 1, { lane: 1 })!;
    // non-battle damage from an Aggressive creature: no trigger
    const a = collectInto(() => dealCreatureDamage(g, [], watcher, 2, mystic));
    runBatches(g, [], a);
    expect(mystic.attack).toBe(3);
    expect(mystic.health).toBe(5);
    // battle damage from a creature without Aggressive: no trigger
    const hydra = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!; // 4/7, no Aggressive
    const b = collectInto(() => dealCreatureDamage(g, [], watcher, 2, hydra, true));
    runBatches(g, [], b);
    expect(hydra.attack).toBe(4);
    expect(hydra.health).toBe(7);
  });
});

describe("Grimgaunt Betrayer (friendly Darkforged destroyed: the creature opposing it gets -N/-N)", () => {
  it("debuffs the enemy creature opposing the destroyed Darkforged", () => {
    const g = gameWith("grimgaunt-betrayer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const darkforged = spawnCreature(g, [], 0, "shadeclaw-zombie", 1, { lane: 2 })!;
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!; // 4/7, opposing it
    destroyCreature(g, [], darkforged);
    runBatches(g, [], []);
    expect(foe.attack).toBe(3); // 4 - 1
    expect(foe.health).toBe(6); // 7 - 1
  });

  it("ignores non-Darkforged deaths and empty opposing spaces", () => {
    const g = gameWith("grimgaunt-betrayer");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 1 });
    const plain = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!; // not Darkforged
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 2 })!;
    destroyCreature(g, [], plain);
    runBatches(g, [], []);
    expect(foe.attack).toBe(4); // unchanged
    expect(foe.health).toBe(7);
    const darkforged = spawnCreature(g, [], 0, "shadeclaw-zombie", 1, { lane: 4 })!; // no opposition
    destroyCreature(g, [], darkforged);
    runBatches(g, [], []);
    expect(g.state.pending).toBeNull(); // nothing targeted, nothing to resolve
  });
});

describe("Nether Decay (target gets 'when a creature is destroyed, this gets -N/-N')", () => {
  it("grants the ability; any creature's death triggers it", () => {
    const g = gameWith("nether-decay");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    const fodder = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: foe.uid });
    expect(foe.grantedAbilities).toEqual(["nekrium:nether-decay-5"]);
    destroyCreature(g, [], fodder);
    runBatches(g, [], []);
    expect(foe.attack).toBe(-1); // 4 - 5
    expect(foe.health).toBe(2); // 7 - 5
    // no Overload: the spell goes to the discard
    expect(g.state.players[0].discard.some((i) => i.defId === "nether-decay")).toBe(true);
  });
});

describe("Plunder Imp (Forge: enemy discards a chosen creature with N or less attack from hand)", () => {
  it("offers the eligible enemy hand cards and discards the chosen one without leveling it", () => {
    const g = gameWith("plunder-imp", "ashurian-mystic"); // 3/5: attack 3 <= 3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInHand");
    expect(req.options).toEqual([0, 1, 2, 3, 4]); // the enemy hand indexes
    applyChoice(g, { id: req.id, accepted: true, handIndex: 2 });
    expect(g.state.players[1].hand).toHaveLength(4);
    const discard = g.state.players[1].discard;
    expect(discard).toHaveLength(1); // no level-up copy (Aetherphage convention)
    expect(discard[0]!.defId).toBe("ashurian-mystic");
    expect(discard[0]!.level).toBe(1);
  });

  it("offers nothing when no enemy hand creature is cheap enough", () => {
    const g = gameWith("plunder-imp", "cavern-hydra"); // attack 4 > 3
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(g.state.pending).toBeNull();
    expect(g.state.players[1].hand).toHaveLength(5);
  });
});

describe("Shadeclaw Zombie (another friendly Darkforged enters: +N/+N)", () => {
  it("grows when another friendly Darkforged enters play", () => {
    const g = gameWith("shadeclaw-zombie");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 }); // 4/5
    const zombie = g.state.players[0].lanes[0]!;
    const initial = collectInto(() => spawnCreature(g, [], 0, "grimgaunt-betrayer", 1, { lane: 1 }));
    runBatches(g, [], initial);
    expect(zombie.attack).toBe(5);
    expect(zombie.health).toBe(6);
  });

  it("ignores enemy entries and non-Darkforged friendlies", () => {
    const g = gameWith("shadeclaw-zombie");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    const zombie = g.state.players[0].lanes[0]!;
    const a = collectInto(() => spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 1 })); // not Darkforged
    runBatches(g, [], a);
    const b = collectInto(() => spawnCreature(g, [], 1, "grimgaunt-betrayer", 1, { lane: 0 })); // enemy
    runBatches(g, [], b);
    expect(zombie.attack).toBe(4);
    expect(zombie.health).toBe(5);
  });
});

describe("Xerxes, the Executioner (Activate: non-Nekrium creatures get -N/-N; Spawn a destroyed enemy)", () => {
  it("debuffs all non-Nekrium creatures and spawns a fresh copy of a destroyed enemy", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "xerxes-the-executioner");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 }); // 5/7
    const ally = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 2 })!; // non-Nekrium friendly
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7, survives
    const doomed = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 1 })!;
    endRound(g); // the doomed hydra's Regenerate heals it during the enemy turn...
    doomed.damage = 6; // ...so wound it afterwards: at 1 health, the -1/-1 destroys it
    const xerxes = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: xerxes.uid });
    expect(xerxes.attack).toBe(5); // Nekrium: not debuffed
    expect(ally.attack).toBe(3); // 4 - 1
    expect(foe.attack).toBe(3);
    expect(foe.health).toBe(6);
    expect(g.state.players[1].lanes[1]).toBeNull(); // destroyed this way
    const copies = g.state.players[0].lanes.filter((c) => c?.defId === "cavern-hydra");
    expect(copies).toHaveLength(2); // the ally + the fresh copy of the destroyed enemy
    const copy = copies.find((c) => c!.uid !== ally.uid)!;
    expect(copy.level).toBe(1);
    expect(copy.attack).toBe(4); // fresh copy at base stats
    expect(copy.health).toBe(7);
  });

  it("does not spawn anything when no enemy creature is destroyed", () => {
    const g = gameWith("cavern-hydra");
    addToHand(g, 0, "xerxes-the-executioner");
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 }); // 4/7 survives -1/-1
    endRound(g);
    const xerxes = g.state.players[0].lanes[0]!;
    applyAction(g, { type: "activate", uid: xerxes.uid });
    expect(g.state.players[0].lanes.filter((c) => c && c.defId !== "xerxes-the-executioner")).toHaveLength(0);
  });
});

describe("Zombie Dreadknight (Forge: each friendly creature with Regenerate gets +N/+N)", () => {
  it("buffs only friendly creatures with Regenerate", () => {
    const g = gameWith("zombie-dreadknight");
    const regen = spawnCreature(g, [], 0, "shadeclaw-zombie", 1, { lane: 0 })!; // 4/5, Regenerate 1
    const plain = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 1 })!; // 7/5, no Regenerate
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 5/3, no Regenerate itself
    expect(regen.attack).toBe(6); // 4 + 2
    expect(regen.health).toBe(7); // 5 + 2
    expect(plain.attack).toBe(7); // unchanged
    expect(g.state.players[0].lanes[2]!.attack).toBe(5); // itself unchanged
  });
});

describe("Infernal Ritual (UNIMPLEMENTED player aura — no-op, Overload still applies)", () => {
  it("resolves as a no-op and is removed from the game", () => {
    const g = gameWith("infernal-ritual");
    const side = spawnCreature(g, [], 0, "shadeclaw-zombie", 1, { lane: 0 })!; // side-space Nekrium
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull();
    expect(keywordValue(side, "Regenerate")).toBe(1); // only its inherent Regenerate 1 — TODO
    expect(g.state.players[0].removed.some((i) => i.defId === "infernal-ritual")).toBe(true);
  });
});

describe("Patron of Tarsus (Forge with 3+ Nekrium cards in hand: enemy creatures get -N/-N)", () => {
  it("debuffs each enemy creature with 3+ Nekrium cards in hand", () => {
    const g = gameWith("patron-of-tarsus"); // all-Nekrium hand
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!; // 4/7
    applyAction(g, { type: "playCard", handIndex: 0, lane: 0 });
    expect(foe.attack).toBe(3); // 4 - 1
    expect(foe.health).toBe(6); // 7 - 1
  });

  it("does not trigger with fewer than 3 Nekrium cards in hand", () => {
    const g = gameWith("cavern-hydra"); // non-Nekrium hand
    addToHand(g, 0, "patron-of-tarsus");
    const foe = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 0 })!;
    applyAction(g, { type: "playCard", handIndex: 5, lane: 0 });
    expect(foe.attack).toBe(4); // unchanged
    expect(foe.health).toBe(7);
  });
});

describe("Grimgaunt Warrior (adjacent friendly creature destroyed: +N/+N)", () => {
  it("grows only from adjacent friendly deaths", () => {
    const g = gameWith("grimgaunt-warrior");
    applyAction(g, { type: "playCard", handIndex: 0, lane: 2 }); // 4/5
    const warrior = g.state.players[0].lanes[2]!;
    const enemyAdjacent = spawnCreature(g, [], 1, "cavern-hydra", 1, { lane: 3 })!;
    const far = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    const adjacent = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 3 })!;
    // enemy creature in the adjacent lane: not a friendly adjacent creature
    destroyCreature(g, [], enemyAdjacent);
    runBatches(g, [], []);
    expect(warrior.attack).toBe(4);
    // friendly but two lanes away: not adjacent
    destroyCreature(g, [], far);
    runBatches(g, [], []);
    expect(warrior.attack).toBe(4);
    // friendly adjacent: +2/+2
    destroyCreature(g, [], adjacent);
    runBatches(g, [], []);
    expect(warrior.attack).toBe(6);
    expect(warrior.health).toBe(7);
  });
});

describe("Remembrance (Banish a level-capped creature from your discard, Spawn a copy)", () => {
  it("banishes a level 1 creature and spawns a fresh copy of it", () => {
    const g = gameWith("remembrance");
    const dead = spawnCreature(g, [], 0, "cavern-hydra", 1, { lane: 0 })!;
    destroyCreature(g, [], dead);
    runBatches(g, [], []); // hydra L1 hits the discard
    applyAction(g, { type: "playCard", handIndex: 0 });
    const req = g.state.pending!.request;
    expect(req.kind).toBe("cardInDiscard");
    expect(req.options).toEqual([0]); // the level-up copy of Remembrance is a spell: filtered out
    applyChoice(g, { id: req.id, accepted: true, handIndex: 0 });
    const p0 = g.state.players[0];
    expect(p0.removed.some((i) => i.defId === "cavern-hydra" && i.level === 1)).toBe(true);
    expect(p0.discard.some((i) => i.defId === "cavern-hydra")).toBe(false);
    const copy = p0.lanes.find((c) => c?.defId === "cavern-hydra");
    expect(copy).toBeTruthy();
    expect(copy!.attack).toBe(4); // fresh copy at base stats
    expect(copy!.health).toBe(7);
  });

  it("L1 cannot banish a level 2 creature", () => {
    const g = gameWith("remembrance");
    const dead = spawnCreature(g, [], 0, "cavern-hydra", 2, { lane: 0 })!;
    destroyCreature(g, [], dead);
    runBatches(g, [], []);
    applyAction(g, { type: "playCard", handIndex: 0 });
    expect(g.state.pending).toBeNull(); // no legal target: no prompt
    expect(g.state.players[0].discard.some((i) => i.defId === "cavern-hydra" && i.level === 2)).toBe(true);
  });
});

describe("Dysian Infusion (support: +N/+N and Regenerate M)", () => {
  it("gives a creature +4/+4 and Regenerate 1", () => {
    const g = gameWith("dysian-infusion");
    const c = spawnCreature(g, [], 0, "vault-intruder", 1, { lane: 0 })!; // 7/5
    applyAction(g, { type: "playCard", handIndex: 0 });
    applyChoice(g, { id: g.state.pending!.request.id, accepted: true, targetUid: c.uid });
    expect(c.attack).toBe(11); // 7 + 4
    expect(c.health).toBe(9); // 5 + 4
    expect(keywordValue(c, "Regenerate")).toBe(1);
  });
});
