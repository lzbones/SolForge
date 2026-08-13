import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, loadCards, makeRng,
  type Game, type PlayerId, type ScrapedSet,
} from "@solforge/engine";
import { answerChoice, choiceOwner, chooseAction } from "./src/index.js";
import { mctsAction, type MctsOptions } from "./src/mcts.js";

const set1 = JSON.parse(readFileSync(new URL("../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8")) as ScrapedSet;
const set15 = JSON.parse(readFileSync(new URL("../../tools/scraper/build/cards_Set_1.5.json", import.meta.url), "utf8")) as ScrapedSet;
const cards = loadCards(set1, set15);

function randomDeck(rng: ReturnType<typeof makeRng>): string[] {
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

// 1) single-move timing at several stages
const rng = makeRng(42 * 7919);
const g = createGame(cards, randomDeck(rng), randomDeck(rng), 42);
for (let stage = 0; stage < 3; stage++) {
  const t = Date.now();
  const a = mctsAction(g, g.state.active as PlayerId, { iterations: 200, timeMs: 5000 });
  console.log(`stage ${stage}: 200 iters in ${Date.now() - t}ms -> ${JSON.stringify(a)}`);
  // advance the game a few actions with hard AI to reach midgame
  for (let k = 0; k < 8 && g.state.phase !== "gameOver"; k++) {
    let guard = 100;
    while (g.state.pending && guard-- > 0) applyChoice(g, answerChoice(g, choiceOwner(g)));
    if (g.state.winner !== null) break;
    applyAction(g, chooseAction(g, g.state.active, "hard"));
  }
}

// 2) expert vs hard quick match with given budget
function playOut(gm: Game, expertSide: PlayerId, opts: MctsOptions): { winner: PlayerId; steps: number; ms: number } {
  let steps = 0;
  let ms = 0;
  while (gm.state.phase !== "gameOver" && steps < 5000) {
    let guard = 100;
    while (gm.state.pending && guard-- > 0) applyChoice(gm, answerChoice(gm, choiceOwner(gm)));
    if (gm.state.winner !== null) break;
    if (gm.state.active === expertSide) {
      const t = Date.now();
      applyAction(gm, mctsAction(gm, gm.state.active, opts));
      ms += Date.now() - t;
    } else {
      applyAction(gm, chooseAction(gm, gm.state.active, "hard"));
    }
    steps++;
  }
  return { winner: gm.state.winner!, steps, ms };
}

const budget: MctsOptions = {
  iterations: Number(process.env.ITERS ?? 120),
  timeMs: 60000,
  rolloutDepth: Number(process.env.DEPTH ?? 30),
  rolloutRandom: Number(process.env.RAND ?? 0.2),
};
const games = Number(process.env.GAMES ?? 10);
let wins = 0;
const t0 = Date.now();
for (let i = 0; i < games; i++) {
  const seed = 42 + i * 977;
  const r = makeRng(seed * 7919);
  const deckA = randomDeck(r);
  const deckB = randomDeck(r);
  const expertSide = (i % 2) as PlayerId;
  const gm = createGame(cards, deckA, deckB, seed);
  const res = playOut(gm, expertSide, budget);
  if (res.winner === expertSide) wins++;
  console.log(`game ${i}: expert=p${expertSide} winner=p${res.winner} steps=${res.steps} expertMs=${res.ms} ${res.winner === expertSide ? "EXPERT" : "hard"}`);
}
console.log(`expert wins: ${wins}/${games} in ${((Date.now() - t0) / 1000).toFixed(1)}s (budget ${JSON.stringify(budget)})`);
