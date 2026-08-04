import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, loadCards, makeRng, spawnCreature,
  type Game, type PlayerId, type ScrapedSet,
} from "@solforge/engine";
import {
  answerChoice, choiceOwner, chooseAction, cloneGame, evaluateState, type Difficulty,
} from "../src/index.js";

const set1 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8"),
) as ScrapedSet;
const set15 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.5.json", import.meta.url), "utf8"),
) as ScrapedSet;
const cards = loadCards(set1, set15);

function deckOf(id: string): string[] {
  return Array(30).fill(id);
}

function randomDeck(rng: ReturnType<typeof makeRng>): string[] {
  // Legal-ish deck: 30 cards, <=2 factions, <=3 copies (same as engine fullgame test).
  const factions = ["Alloyin", "Nekrium", "Tempys", "Uterra"];
  const picked = [factions[rng.int(4)]!, factions[rng.int(4)]!];
  const pool = Object.values(cards).filter(
    (c) => c.rarity !== "Token" && picked.includes(c.faction) && c.levels.length >= 3
      && c.levels.every((l) => l.attack !== null || c.types.includes("Spell")),
  );
  const deck: string[] = [];
  const counts = new Map<string, number>();
  while (deck.length < 30) {
    const c = pool[rng.int(pool.length)]!;
    const n = counts.get(c.id) ?? 0;
    if (n >= 3) continue;
    counts.set(c.id, n + 1);
    deck.push(c.id);
  }
  return deck;
}

/** Drive a full game AI vs AI; both sides answer choices via answerChoice. */
function playOut(g: Game, diffs: [Difficulty, Difficulty]): PlayerId {
  let steps = 0;
  while (g.state.phase !== "gameOver" && steps < 5000) {
    let guard = 100;
    while (g.state.pending && guard-- > 0) {
      applyChoice(g, answerChoice(g, choiceOwner(g)));
    }
    if (g.state.winner !== null) break; // a choice resolution ended the game
    applyAction(g, chooseAction(g, g.state.active, diffs[g.state.active]));
    steps++;
  }
  expect(steps).toBeLessThan(5000);
  expect(g.state.winner === 0 || g.state.winner === 1).toBe(true);
  return g.state.winner!;
}

describe("AI vs AI", () => {
  it("plays 10 easy-vs-hard games to completion; hard wins at least 7", () => {
    let hardWins = 0;
    const summary: string[] = [];
    for (let i = 0; i < 10; i++) {
      const seed = 42 + i * 977;
      const rng = makeRng(seed * 7919);
      const deckA = randomDeck(rng);
      const deckB = randomDeck(rng);
      // alternate sides to cancel any first-player advantage
      const hardSide = (i % 2) as PlayerId;
      const diffs: [Difficulty, Difficulty] = hardSide === 0 ? ["hard", "easy"] : ["easy", "hard"];
      const g = createGame(cards, deckA, deckB, seed);
      const winner = playOut(g, diffs);
      if (winner === hardSide) hardWins++;
      summary.push(`game ${i}: hard=p${hardSide} winner=p${winner} ${winner === hardSide ? "HARD" : "easy"}`);
    }
    console.log(`hard wins: ${hardWins}/10\n${summary.join("\n")}`);
    expect(hardWins).toBeGreaterThanOrEqual(7);
  }, 120000);
});

describe("targeted play", () => {
  it("hard AI uses Lightning Spark on a 10/10 threat instead of going face", () => {
    const g = createGame(cards, deckOf("lightning-spark"), deckOf("cavern-hydra"), 7);
    const threat = spawnCreature(g, [], 1, "cavern-hydra", 1, {
      lane: 2,
      overrideStats: { attack: 10, health: 10 },
    })!;

    const action = chooseAction(g, 0, "hard");
    expect(action.type).toBe("playCard");
    if (action.type !== "playCard") return;
    expect(g.state.players[0].hand[action.handIndex]!.defId).toBe("lightning-spark");

    applyAction(g, action);
    expect(g.state.pending).not.toBeNull();
    expect(g.state.pending!.request.kind).toBe("anyCreatureOrPlayer");

    const answer = answerChoice(g, 0);
    expect(answer.targetUid).toBe(threat.uid);

    applyChoice(g, answer);
    // L1 Spark deals 6: the 10/10 survives but is heavily damaged
    expect(g.state.players[1].lanes[2]?.uid).toBe(threat.uid);
    expect(g.state.players[1].lanes[2]?.damage).toBe(6);
    expect(g.state.players[1].health).toBe(120); // not face
  });

  it("cloneGame produces an independent copy for simulation", () => {
    const g = createGame(cards, deckOf("cavern-hydra"), deckOf("lightning-spark"), 3);
    const sim = cloneGame(g);
    const before = g.state.players[0].hand.length;
    applyAction(sim, { type: "discardToLevel", handIndex: 0 });
    expect(g.state.players[0].hand.length).toBe(before);
    expect(g.state.playsLeft).toBe(2);
    expect(evaluateState(g, 0) + evaluateState(g, 1)).toBe(0); // symmetric start
  });
});
