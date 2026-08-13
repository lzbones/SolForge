import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, legalActions, loadCards, makeRng,
  type Game, type PlayerId, type ScrapedSet,
} from "@solforge/engine";
import { answerChoice, choiceOwner, chooseAction } from "../src/index.js";
import { mctsAction, type MctsOptions } from "../src/mcts.js";

const set1 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8"),
) as ScrapedSet;
const set15 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.5.json", import.meta.url), "utf8"),
) as ScrapedSet;
const cards = loadCards(set1, set15);

function randomDeck(rng: ReturnType<typeof makeRng>): string[] {
  // Legal-ish deck: 30 cards, <=2 factions, <=3 copies (same as ai.test.ts).
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

/** Drive a full game: expert side uses mctsAction, hard side uses chooseAction. */
function playOut(g: Game, expertSide: PlayerId, opts: MctsOptions): PlayerId {
  let steps = 0;
  while (g.state.phase !== "gameOver" && steps < 5000) {
    let guard = 100;
    while (g.state.pending && guard-- > 0) {
      applyChoice(g, answerChoice(g, choiceOwner(g)));
    }
    if (g.state.winner !== null) break; // a choice resolution ended the game
    const action = g.state.active === expertSide
      ? mctsAction(g, g.state.active, opts)
      : chooseAction(g, g.state.active, "hard");
    applyAction(g, action);
    steps++;
  }
  expect(steps).toBeLessThan(5000);
  expect(g.state.winner === 0 || g.state.winner === 1).toBe(true);
  return g.state.winner!;
}

describe("MCTS expert", () => {
  it("returns a legal move within 2s at 200 iterations", () => {
    const rng = makeRng(42 * 7919);
    const g = createGame(cards, randomDeck(rng), randomDeck(rng), 42);
    const start = Date.now();
    const action = mctsAction(g, g.state.active, { iterations: 200, timeMs: 2000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // the chosen action must be applicable to the real game
    const legal = legalActions(g).map((a) => JSON.stringify(a));
    expect(legal).toContain(JSON.stringify(action));
  });

  it("is wired up as the third chooseAction difficulty", () => {
    const g = createGame(cards, Array(30).fill("cavern-hydra"), Array(30).fill("lightning-spark"), 7);
    const action = chooseAction(g, 0, "expert");
    const legal = legalActions(g).map((a) => JSON.stringify(a));
    expect(legal).toContain(JSON.stringify(action));
  });

  it("plays 10 expert-vs-hard games to completion; expert wins at least 6", () => {
    // Iteration-bound (huge timeMs) so the run is deterministic. Tuned config:
    // short rollouts + more iterations beat deep noisy ones (see report).
    const opts: MctsOptions = { iterations: 300, rolloutDepth: 10, rolloutRandom: 0.1, timeMs: 60_000 };
    let expertWins = 0;
    const summary: string[] = [];
    for (let i = 0; i < 10; i++) {
      const seed = 42 + i * 977;
      const rng = makeRng(seed * 7919);
      const deckA = randomDeck(rng);
      const deckB = randomDeck(rng);
      // alternate sides to cancel any first-player advantage
      const expertSide = (i % 2) as PlayerId;
      const g = createGame(cards, deckA, deckB, seed);
      const winner = playOut(g, expertSide, opts);
      if (winner === expertSide) expertWins++;
      summary.push(`game ${i}: expert=p${expertSide} winner=p${winner} ${winner === expertSide ? "EXPERT" : "hard"}`);
    }
    console.log(`expert wins: ${expertWins}/10\n${summary.join("\n")}`);
    expect(expertWins).toBeGreaterThanOrEqual(6);
  }, 600000);
});
