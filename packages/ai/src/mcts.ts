/**
 * MCTS (Monte Carlo Tree Search) — the "expert" difficulty.
 *
 * Classic UCB1 tree search over cloned games:
 * - node = cloned game state; children = legal actions;
 * - selection: UCB1, zero-sum oriented (values are always stored from the
 *   root player's perspective, so the opponent minimizes);
 * - expansion: apply one untried action on a fresh clone, auto-answering any
 *   pending choices with the shared answerChoice policy;
 * - simulation (rollout): cheap policy (the "easy" heuristic, with a small
 *   random mix for diversity) until game over or the depth cap; unfinished
 *   games are scored with evaluateState normalized to [-1, 1] via tanh;
 * - actions that throw RuleError in simulation are skipped.
 *
 * RNG note: cloneGame rebuilds a fixed-seed rng, which would make every
 * rollout identical. Every clone made here gets a fresh makeRng from an
 * advancing seed stream so card effects/reshuffles stay varied.
 */
import {
  applyAction, applyChoice, legalActions, makeRng, RuleError,
  type Action, type Game, type PlayerId, type Rng,
} from "@solforge/engine";
import { answerChoice, choiceOwner, chooseAction, cloneGame, evaluateState } from "./index.js";

export interface MctsOptions {
  /** Max tree iterations (default 200). */
  iterations?: number;
  /** Wall-clock budget in ms (default 500); checked between iterations. */
  timeMs?: number;
  /** Max actions per rollout before falling back to evaluateState (default 10). */
  rolloutDepth?: number;
  /** Probability of a uniformly random move in rollouts (default 0.1). */
  rolloutRandom?: number;
  /** Base seed for the internal rng streams (default fixed — deterministic). */
  seed?: number;
}

const DEFAULT_ITERATIONS = 200;
const DEFAULT_TIME_MS = 500;
const DEFAULT_ROLLOUT_DEPTH = 10;
const DEFAULT_SEED = 0x5f3759df;

const UCB_C = Math.SQRT2;
/** evaluateState scale: tanh(score / EVAL_SCALE) maps a position to (-1, 1). */
const EVAL_SCALE = 50;
/** Probability of a uniformly random move instead of the heuristic in rollouts. */
const ROLLOUT_RANDOM_PROB = 0.1;
/** Safety bound when auto-answering chained choices. */
const CHOICE_GUARD = 100;

interface Node {
  game: Game;
  /** Action that led from parent to this node (null at the root). */
  action: Action | null;
  parent: Node | null;
  children: Node[];
  untried: Action[];
  visits: number;
  /** Total rollout value, always from the ROOT player's perspective. */
  total: number;
}

/** Advanceable seed stream so every simulated clone gets a distinct rng. */
interface SeedStream {
  value: number;
}

function nextSeed(seeds: SeedStream): number {
  const s = seeds.value >>> 0;
  seeds.value = (Math.imul(seeds.value, 1664525) + 1013904223) | 0;
  return s;
}

/** cloneGame + a fresh rng from the seed stream (keeps rollouts diverse). */
function freshClone(game: Game, seeds: SeedStream): Game {
  const sim = cloneGame(game);
  sim.rng = makeRng(nextSeed(seeds));
  return sim;
}

/** Auto-answer pending choices until the game is ready for the next action. */
function settle(sim: Game): void {
  let guard = CHOICE_GUARD;
  while (sim.state.pending && guard-- > 0) {
    try {
      applyChoice(sim, answerChoice(sim, choiceOwner(sim)));
    } catch {
      break; // a script blew up on a degenerate simulated state — stop here
    }
  }
}

function terminalValue(game: Game, root: PlayerId): number {
  const winner = game.state.winner;
  if (winner === null) return 0;
  return winner === root ? 1 : -1;
}

function sameAction(a: Action, b: Action): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Cheap rollout policy: mostly the "easy" heuristic, sometimes uniform random. */
function rolloutAction(sim: Game, pool: Action[], dice: Rng, randomProb: number): number {
  if (pool.length > 1 && dice.next() < randomProb) return dice.int(pool.length);
  const heuristic = chooseAction(sim, sim.state.active, "easy");
  const idx = pool.findIndex((a) => sameAction(a, heuristic));
  return idx >= 0 ? idx : dice.int(pool.length);
}

/**
 * Play out the game from `node.game` on a private clone; returns a value in
 * [-1, 1] from the root player's perspective.
 */
function rollout(
  game: Game, root: PlayerId, seeds: SeedStream, dice: Rng, maxDepth: number, randomProb: number,
): number {
  const sim = freshClone(game, seeds);
  let depth = maxDepth;
  while (sim.state.phase !== "gameOver" && depth-- > 0) {
    settle(sim);
    // TS narrowing can't see that settle()/applyAction may end the game.
    if ((sim.state.phase as string) === "gameOver" || sim.state.pending) break;
    const pool = legalActions(sim);
    let applied = false;
    while (pool.length > 0) {
      const idx = rolloutAction(sim, pool, dice, randomProb);
      const action = pool[idx]!;
      try {
        applyAction(sim, action);
        applied = true;
        break;
      } catch (e) {
        if (!(e instanceof RuleError)) break; // script crash on a degenerate state — evaluate as-is
        pool.splice(idx, 1); // illegal in practice — skip
      }
    }
    if (!applied) break; // no applicable action (shouldn't happen; endTurn always exists)
  }
  if (sim.state.winner !== null) return terminalValue(sim, root);
  return Math.tanh(evaluateState(sim, root) / EVAL_SCALE);
}

/** Pop one untried action (random order for diversity), apply on a clone. */
function expand(node: Node, seeds: SeedStream, dice: Rng): Node | null {
  while (node.untried.length > 0) {
    const idx = dice.int(node.untried.length);
    const [action] = node.untried.splice(idx, 1);
    const sim = freshClone(node.game, seeds);
    try {
      applyAction(sim, action!);
    } catch {
      // RuleError: illegal in practice. Anything else: an engine script blew
      // up mid-simulation (e.g. NaN-statted tokens circulated from the discard
      // pile — a latent engine corner). The clone is unusable either way.
      continue;
    }
    settle(sim);
    if (sim.state.pending) continue; // settle failed — discard this child
    const child: Node = {
      game: sim,
      action: action!,
      parent: node,
      children: [],
      untried: sim.state.phase === "gameOver" ? [] : legalActions(sim),
      visits: 0,
      total: 0,
    };
    node.children.push(child);
    return child;
  }
  return null;
}

/** Descend from `node` by UCB1 until reaching a terminal or expandable node. */
function ucbSelect(node: Node, root: PlayerId): Node {
  let current = node;
  while (
    current.game.state.phase !== "gameOver"
    && current.untried.length === 0
    && current.children.length > 0
  ) {
    const toMove = current.game.state.active;
    const logVisits = Math.log(current.visits);
    let best: Node | null = null;
    let bestScore = -Infinity;
    for (const child of current.children) {
      const mean = child.total / child.visits; // root player's perspective
      const oriented = toMove === root ? mean : -mean; // opponent minimizes
      const score = oriented + UCB_C * Math.sqrt(logVisits / child.visits);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    current = best!; // children all have finite values, so best is always set
  }
  return current;
}

/**
 * Pick an action for `player` by Monte Carlo Tree Search. The game must not
 * have a pending choice (answer it first, as with chooseAction).
 */
export function mctsAction(game: Game, player: PlayerId, opts: MctsOptions = {}): Action {
  if (game.state.pending) throw new Error("mctsAction: a choice is pending");
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const timeMs = opts.timeMs ?? DEFAULT_TIME_MS;
  const rolloutDepth = opts.rolloutDepth ?? DEFAULT_ROLLOUT_DEPTH;
  const rolloutRandom = opts.rolloutRandom ?? ROLLOUT_RANDOM_PROB;
  const seeds: SeedStream = { value: (opts.seed ?? DEFAULT_SEED) | 0 };
  const dice = makeRng(nextSeed(seeds) ^ 0x2545f491);

  const actions = legalActions(game);
  if (actions.length === 0) throw new Error("mctsAction: no legal actions");
  if (actions.length === 1) return actions[0]!; // forced move — skip the search

  const root: Node = {
    game: freshClone(game, seeds),
    action: null,
    parent: null,
    children: [],
    untried: [...actions],
    visits: 0,
    total: 0,
  };

  const deadline = Date.now() + timeMs;
  let done = 0;
  while (done < iterations) {
    if (done > 0 && (done & 7) === 0 && Date.now() > deadline) break;
    let node = ucbSelect(root, player);
    if (node.game.state.phase !== "gameOver" && node.untried.length > 0) {
      node = expand(node, seeds, dice) ?? node;
    }
    const value = node.game.state.phase === "gameOver"
      ? terminalValue(node.game, player)
      : rollout(node.game, player, seeds, dice, rolloutDepth, rolloutRandom);
    for (let n: Node | null = node; n; n = n.parent) {
      n.visits++;
      n.total += value;
    }
    done++;
  }

  // Robust child: most visited; ties broken by higher mean value.
  let best: Node | null = null;
  for (const child of root.children) {
    if (!best || child.visits > best.visits || (child.visits === best.visits && child.total > best.total)) {
      best = child;
    }
  }
  return best?.action ?? actions[0]!;
}
