/**
 * @solforge/ai — AI opponent for the SolForge engine.
 *
 * - evaluateState(game, player): heuristic position score from `player`'s view.
 * - chooseAction(game, player, difficulty): "easy" is a fixed heuristic;
 *   "hard" runs a 1-ply greedy search over all legal actions on cloned games.
 * - answerChoice(game, player): smart answers for pending ChoiceRequests.
 * - cloneGame(game): deep copy for simulation (state is pure data; the rng
 *   closure is rebuilt with a fixed seed — AI simulation does not need RNG
 *   continuity).
 */
import {
  applyAction, applyChoice, findCreature, getStats, hasKeyword, keywordValue,
  legalActions, makeRng, opposing, RuleError,
  type Action, type ChoiceAnswer, type CreatureState, type Game, type PlayerId,
} from "@solforge/engine";

export type Difficulty = "easy" | "hard";

// ---------- cloning ----------

/**
 * Deep-copy a game for search simulation. `GameState` is plain data, so
 * structuredClone works; the card definition table is immutable (scripts only
 * read it), so it is shared instead of cloned. The rng closure cannot be
 * cloned — a fresh deterministic one is installed instead.
 */
export function cloneGame(game: Game, seed = 0xa1): Game {
  const state = structuredClone(game.state);
  state.cards = game.state.cards;
  return { state, rng: makeRng(seed) };
}

/** Which player must answer the currently pending choice. */
export function choiceOwner(game: Game): PlayerId {
  const r = game.state.pending!.resume;
  if (r.kind === "spell") return r.player;
  // triggers/activates: owner of the source creature (may be dead — fall back)
  for (const side of game.state.players) {
    for (const c of side.lanes) if (c && "selfUid" in r && c.uid === r.selfUid) return c.owner;
  }
  return game.state.active;
}

// ---------- evaluation ----------

const W_HEALTH = 2; // per point of player HP difference
const W_RANK = 4; // per rank difference
const W_HAND = 2; // per card-in-hand difference
const W_LEVELED = 1.5; // per leveled-up copy waiting in the discard pile
const W_TRADE = 3; // winning the lane trade in combat

function effectiveHp(game: Game, c: CreatureState): number {
  return getStats(game, c).health - c.damage;
}

/** Heuristic worth of a creature on the board (0 if it is dying). */
function creatureValue(game: Game, c: CreatureState): number {
  const st = getStats(game, c);
  const hp = st.health - c.damage;
  if (hp <= 0) return 0;
  let v = 2 * st.attack + hp;
  // small keyword adjustments
  if (hasKeyword(c, "Breakthrough")) v += 3;
  if (hasKeyword(c, "Aggressive")) v += 2;
  if (hasKeyword(c, "Defender")) v -= 2;
  v += 0.5 * keywordValue(c, "Armor");
  v += 0.5 * keywordValue(c, "Regenerate");
  v += 0.5 * keywordValue(c, "Poison");
  v += 0.5 * keywordValue(c, "Mobility");
  return v;
}

/** Position score from `player`'s perspective; higher is better for them. */
export function evaluateState(game: Game, player: PlayerId): number {
  const s = game.state;
  if (s.winner !== null) return s.winner === player ? 1_000_000 : -1_000_000;
  const me = s.players[player];
  const foe = s.players[opposing(player)];
  let score = 0;
  score += W_HEALTH * (me.health - foe.health);
  score += W_RANK * (me.rank - foe.rank);
  score += W_HAND * (me.hand.length - foe.hand.length);
  const leveled = (p: typeof me): number => p.discard.reduce((n, c) => n + (c.level > 1 ? 1 : 0), 0);
  score += W_LEVELED * (leveled(me) - leveled(foe));
  for (let lane = 0; lane < 5; lane++) {
    const mine = me.lanes[lane];
    const theirs = foe.lanes[lane];
    if (mine) score += creatureValue(game, mine);
    if (theirs) score -= creatureValue(game, theirs);
    if (mine && theirs && effectiveHp(game, mine) > 0 && effectiveHp(game, theirs) > 0) {
      // who wins the trade if these two fight
      const iKill = getStats(game, mine).attack >= effectiveHp(game, theirs);
      const theyKill = getStats(game, theirs).attack >= effectiveHp(game, mine);
      if (iKill && !theyKill) score += W_TRADE;
      if (theyKill && !iKill) score -= W_TRADE;
    }
  }
  return score;
}

// ---------- choice answers ----------

/** Removal-style threat value: attack-weighted. */
function threat(game: Game, c: CreatureState): number {
  const st = getStats(game, c);
  return 2 * st.attack + Math.max(0, st.health - c.damage);
}

/** Enemy creatures whose attack is at or above this are always worth a burn spell. */
const BURN_THREAT_ATTACK = 6;

/** Prompts that hurt one of your own creatures (a cost, e.g. Grave Pact). */
const COST_ON_FRIENDLY = /destroy|sacrifice/i;
/** anyCreature prompts that are debuffs (go on enemies), not buffs. */
const DEBUFF_ON_ANY = /−|-|destroy|negate|defender/i;

function byThreatDesc(game: Game, a: CreatureState, b: CreatureState): number {
  return threat(game, b) - threat(game, a);
}

function byAttackDesc(game: Game, a: CreatureState, b: CreatureState): number {
  const d = getStats(game, b).attack - getStats(game, a).attack;
  return d !== 0 ? d : threat(game, b) - threat(game, a);
}

/**
 * Pick a smart answer for the pending choice, from `player`'s perspective:
 * removal hits the highest-threat enemy creature, buffs go to the friendly
 * creature with the highest attack, burn spells kill/dent big threats instead
 * of going face (unless face is lethal), beneficial optional effects are
 * accepted, sacrifice costs are paid with the weakest friendly creature.
 */
export function answerChoice(game: Game, player: PlayerId): ChoiceAnswer {
  const pending = game.state.pending;
  if (!pending) throw new Error("no pending choice");
  const req = pending.request;
  const options = req.options ?? [];
  const foe = opposing(player);
  const creatures = options
    .filter((uid) => uid > 0)
    .map((uid) => findCreature(game.state, uid))
    .filter((c): c is CreatureState => c !== null);
  const mine = creatures.filter((c) => c.owner === player);
  const theirs = creatures.filter((c) => c.owner === foe);
  const done = (targetUid?: number): ChoiceAnswer => ({
    id: req.id,
    accepted: true,
    ...(targetUid !== undefined ? { targetUid } : {}),
  });

  switch (req.kind) {
    case "yesNo":
      return { id: req.id, accepted: true };
    case "cardInHand":
    case "cardInDiscard":
      // options are pile indexes; the ChoiceAnswer field is still handIndex
      return { id: req.id, accepted: true, handIndex: options[0] ?? 0 };
    case "enemyCreature":
      return done((theirs.length ? theirs : creatures).sort((a, b) => byThreatDesc(game, a, b))[0]?.uid);
    case "friendlyCreature":
      if (COST_ON_FRIENDLY.test(req.prompt)) {
        // pay the cost with the weakest creature
        return done((mine.length ? mine : creatures).sort((a, b) => byThreatDesc(game, b, a))[0]?.uid);
      }
      return done((mine.length ? mine : creatures).sort((a, b) => byAttackDesc(game, a, b))[0]?.uid);
    case "anyCreature": {
      if (!req.prompt.includes("+") && DEBUFF_ON_ANY.test(req.prompt)) {
        return done((theirs.length ? theirs : mine).sort((a, b) => byThreatDesc(game, a, b))[0]?.uid);
      }
      return done((mine.length ? mine : theirs).sort((a, b) => byAttackDesc(game, a, b))[0]?.uid);
    }
    case "anyCreatureOrPlayer": {
      const faceUid = foe === 0 ? -1 : -2;
      const damage = Number(/deal (\d+) damage/i.exec(req.prompt)?.[1] ?? 0);
      // lethal to the face wins immediately
      if (damage > 0 && game.state.players[foe].health <= damage && options.includes(faceUid)) {
        return done(faceUid);
      }
      const top = theirs.sort((a, b) => byThreatDesc(game, a, b))[0];
      if (top) {
        const st = getStats(game, top);
        const dies = damage > 0 && damage >= st.health - top.damage;
        if (dies || st.attack >= BURN_THREAT_ATTACK) return done(top.uid);
      }
      if (options.includes(faceUid)) return done(faceUid);
      return done(options[0]);
    }
  }
}

// ---------- action selection ----------

export function chooseAction(game: Game, player: PlayerId, difficulty: Difficulty): Action {
  return difficulty === "hard" ? hardAction(game, player) : easyAction(game);
}

function firstOpenLane(game: Game): number {
  const me = game.state.players[game.state.active];
  for (let i = 0; i < 5; i++) if (!me.lanes[i]) return i;
  return 0;
}

/** Fixed heuristic: biggest creature, always battle, level with spare plays. */
function easyAction(game: Game): Action {
  const actions = legalActions(game);
  const me = game.state.players[game.state.active];
  let best: { action: Extract<Action, { type: "playCard" }>; score: number } | null = null;
  for (const a of actions) {
    if (a.type !== "playCard") continue;
    const inst = me.hand[a.handIndex]!;
    const def = game.state.cards[inst.defId]!;
    const lvl = def.levels.find((l) => l.level === inst.level) ?? def.levels[0]!;
    const score = (lvl.attack ?? 0) * 2 + (lvl.health ?? 0);
    if (!best || score > best.score) best = { action: a, score };
  }
  if (best) {
    // creatures: drop into the first open lane (avoid replacing our own)
    return best.action.lane === undefined
      ? best.action
      : { type: "playCard", handIndex: best.action.handIndex, lane: firstOpenLane(game) };
  }
  if (actions.some((a) => a.type === "battle")) return { type: "battle" };
  const level = actions.find((a) => a.type === "discardToLevel");
  if (level) return level;
  return { type: "endTurn" };
}

/** 1-ply greedy search: simulate every legal action on a clone, keep the best. */
function hardAction(game: Game, player: PlayerId): Action {
  const actions = legalActions(game);
  let best: Action = { type: "endTurn" };
  let bestScore = -Infinity;
  for (const action of actions) {
    const sim = cloneGame(game);
    try {
      applyAction(sim, action);
    } catch (e) {
      if (e instanceof RuleError) continue; // illegal in practice — skip
      throw e;
    }
    // auto-answer any choices the simulation runs into (fixed policy)
    let guard = 100;
    while (sim.state.pending && guard-- > 0) {
      applyChoice(sim, answerChoice(sim, choiceOwner(sim)));
    }
    const score = evaluateState(sim, player);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}
