import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyAction, applyChoice, createGame, legalActions, loadCards, makeRng,
  type ScrapedSet,
} from "../src/index.js";

const set1 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.json", import.meta.url), "utf8"),
) as ScrapedSet;
const set15 = JSON.parse(
  readFileSync(new URL("../../../tools/scraper/build/cards_Set_1.5.json", import.meta.url), "utf8"),
) as ScrapedSet;
const cards = loadCards(set1, set15);

function randomDeck(rng: ReturnType<typeof makeRng>): string[] {
  // Legal-ish deck: 30 cards, <=2 factions, <=3 copies.
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

describe("full random games with real Set 1 data", () => {
  it("plays 20 random games to completion without crashing", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeRng(seed * 7919);
      const g = createGame(cards, randomDeck(rng), randomDeck(rng), seed);
      let steps = 0;
      while (g.state.phase !== "gameOver" && steps < 2000) {
        // auto-answer any pending choice (random legal option)
        while (g.state.pending) {
          const req = g.state.pending.request;
          const targetUid = req.options?.length && rng.next() < 0.9
            ? req.options[rng.int(req.options.length)]
            : undefined;
          applyChoice(g, {
            id: req.id,
            accepted: req.optional ? rng.next() < 0.8 : true,
            ...(targetUid !== undefined ? { targetUid } : {}),
          });
        }
        const actions = legalActions(g);
        // bias: prefer plays and battle over endTurn
        const nonEnd = actions.filter((a) => a.type !== "endTurn");
        const action = nonEnd.length && rng.next() < 0.85
          ? nonEnd[rng.int(nonEnd.length)]!
          : actions[rng.int(actions.length)]!;
        applyAction(g, action);
        steps++;
      }
      expect(steps).toBeLessThan(2000);
      expect(g.state.winner === 0 || g.state.winner === 1).toBe(true);
    }
  }, 30000);
});
