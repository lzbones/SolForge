/**
 * Game setup, actions, and turn-flow driver.
 *
 * Integrates the batch/trigger engine (effects.ts): playing cards, battle,
 * and turn phases collect triggers which resolve in batches; abilities that
 * need input pause via state.pending and resume through applyChoice().
 */
import { makeRng, type Rng } from "./rng.js";
import {
  DECK_SIZE, HAND_DRAW, PLAYS_PER_TURN, TURNS_PER_RANK,
  emptyPlayer, findCreature, hasKeyword, isDead, keywordValue, opposing,
  type CardInstance, type CreatureState, type GameState, type PendingChoice,
  type PlayerId, type PlayerState,
} from "./state.js";
import { maxLevel, typeAt, type CardDef, type Keyword } from "./types.js";
import {
  canAttack, collectAll, collectFor, collectInto, dealCreatureDamage, dealPlayerDamage,
  drawCardsEffect, getStats, healCreature, isOffensive, refreshStatics, reshuffleEffect, resumeWithChoice,
  runBatches, spawnCreature, type RunResult,
} from "./effects.js";
import { getCardScript, getLevelScript } from "./scripts/registry.js";
import type { ChoiceAnswer, ChoiceRequest, GameEvent as GameEventT, ResolveResult } from "./triggers.js";
export type { GameEvent } from "./triggers.js";
type GameEvent = GameEventT;

export type Action =
  | { type: "playCard"; handIndex: number; lane?: number }
  | { type: "discardToLevel"; handIndex: number }
  | { type: "battle" }
  | { type: "activate"; uid: number }
  | { type: "move"; uid: number; lane: number }
  | { type: "endTurn" };

export class RuleError extends Error {}

export interface Game {
  state: GameState;
  rng: Rng;
}

// ---------- setup ----------

export function createGame(
  cards: Record<string, CardDef>,
  deckA: string[],
  deckB: string[],
  seed = 1,
  opts: { startingHealth?: number | [number, number] } = {},
): Game {
  if (deckA.length !== DECK_SIZE || deckB.length !== DECK_SIZE) {
    throw new RuleError(`decks must have exactly ${DECK_SIZE} cards`);
  }
  const rng = makeRng(seed);
  let uid = 1;
  const makeInstance = (defId: string, owner: PlayerId): CardInstance => {
    if (!cards[defId]) throw new RuleError(`unknown card: ${defId}`);
    return { uid: uid++, defId, level: 1, owner };
  };
  const players: [PlayerState, PlayerState] = [emptyPlayer(), emptyPlayer()];
  if (opts.startingHealth !== undefined) {
    const [h0, h1] = Array.isArray(opts.startingHealth)
      ? opts.startingHealth
      : [opts.startingHealth, opts.startingHealth];
    players[0].health = h0;
    players[1].health = h1;
  }
  players[0].deck = rng.shuffle(deckA.map((id) => makeInstance(id, 0)));
  players[1].deck = rng.shuffle(deckB.map((id) => makeInstance(id, 1)));
  const state: GameState = {
    cards, players, active: 0, turnNumber: 1, phase: "main",
    playsLeft: PLAYS_PER_TURN, battlesLeft: 1, winner: null, nextUid: uid,
    deathCounter: 0, pending: null, pendingQueue: [],
    cardsPlayedThisTurn: 0, turnFlags: { moved: false, unForgedEntry: false, healed: false },
    deathsThisTurn: [0, 0],
    deathLog: [],
  };
  const game = { state, rng };
  // Solbind: bound cards are added before the first draw.
  for (const p of [0, 1] as const) {
    const seen = new Set<string>();
    const extra: CardInstance[] = [];
    for (const inst of players[p].deck) {
      if (seen.has(inst.defId)) continue;
      seen.add(inst.defId);
      for (const boundId of getCardScript(inst.defId)?.solbind ?? []) {
        if (!cards[boundId]) throw new RuleError(`solbind: unknown card ${boundId}`);
        extra.push({ uid: state.nextUid++, defId: boundId, level: 1, owner: p });
      }
    }
    if (extra.length) players[p].deck = rng.shuffle([...players[p].deck, ...extra]);
  }
  const events: GameEvent[] = [];
  drawCards(game, 0, HAND_DRAW, events);
  drawCards(game, 1, HAND_DRAW, events);
  return game;
}

// ---------- helpers ----------

function defOf(game: Game, inst: CardInstance): CardDef {
  return game.state.cards[inst.defId]!;
}

function drawCards(game: Game, p: PlayerId, n: number, events: GameEvent[]): void {
  drawCardsEffect(game, events, p, n);
}

/** Rank-up reshuffle with level gating. */
function reshuffle(game: Game, p: PlayerId, events: GameEvent[], rankGate: number): void {
  reshuffleEffect(game, p, events, rankGate);
}

function levelUpCopy(game: Game, inst: CardInstance, events: GameEvent[]): void {
  const d = defOf(game, inst);
  if (inst.level >= maxLevel(d)) return;
  game.state.players[inst.owner].discard.push({
    uid: game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: inst.owner,
  });
  events.push({ type: "levelUp", player: inst.owner, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
}

function cardHasKeyword(game: Game, inst: CardInstance, kw: Keyword): boolean {
  const lvl = defOf(game, inst).levels.find((l) => l.level === inst.level);
  return lvl?.keywords?.some((k) => k.keyword === kw) ?? false;
}

function finishIfPaused(game: Game, events: GameEvent[], r: RunResult): GameEvent[] {
  if (r.paused && game.state.pending) {
    events.push({ type: "choiceRequest", request: game.state.pending.request });
  }
  return events;
}

// ---------- legal actions ----------

export function legalActions(game: Game): Action[] {
  const s = game.state;
  if (s.phase === "gameOver" || s.pending) return [];
  refreshStatics(game);
  const pl = s.players[s.active];
  const actions: Action[] = [{ type: "endTurn" }];
  if (s.battlesLeft > 0) actions.push({ type: "battle" });
  pl.hand.forEach((inst, i) => {
    const d = defOf(game, inst);
    const free = cardHasKeyword(game, inst, "Free");
    if (s.playsLeft > 0 || free) {
      if (typeAt(d, inst.level) === "Creature") {
        for (let lane = 0; lane < 5; lane++) actions.push({ type: "playCard", handIndex: i, lane });
      } else {
        actions.push({ type: "playCard", handIndex: i });
      }
    }
    if (s.playsLeft > 0) actions.push({ type: "discardToLevel", handIndex: i });
  });
  for (const c of pl.lanes) {
    if (!c || isDead(c)) continue;
    if (isOffensive(c) && !c.activatedThisTurn) {
      const script = getLevelScript(c.defId, c.level);
      const act = script?.activates?.[0];
      if (act && (!act.condition || act.condition(game, c))) {
        actions.push({ type: "activate", uid: c.uid });
      }
      const mobility = keywordValue(c, "Mobility");
      if (mobility > 0 && !c.movedThisTurn && isOffensive(c)) {
        for (let lane = 0; lane < 5; lane++) {
          if (lane !== c.lane && Math.abs(lane - c.lane) <= mobility && !pl.lanes[lane]) {
            actions.push({ type: "move", uid: c.uid, lane });
          }
        }
      }
    }
  }
  return actions;
}

// ---------- action application ----------

export function applyAction(game: Game, action: Action): GameEvent[] {
  const s = game.state;
  if (s.phase === "gameOver") throw new RuleError("game is over");
  if (s.pending) throw new RuleError("a choice is pending");
  const events: GameEvent[] = [];
  const p = s.active;
  const pl = s.players[p];
  let result: RunResult = { paused: false };

  switch (action.type) {
    case "playCard": {
      const inst = pl.hand[action.handIndex];
      if (!inst) throw new RuleError("bad hand index");
      const d = defOf(game, inst);
      const free = cardHasKeyword(game, inst, "Free");
      if (s.playsLeft <= 0 && !free) throw new RuleError("no plays left");
      pl.hand.splice(action.handIndex, 1);
      if (!free) s.playsLeft--;
      s.cardsPlayedThisTurn++;
      levelUpCopy(game, inst, events);
      if (typeAt(d, inst.level) === "Creature") {
        const lane = action.lane;
        if (lane === undefined || lane < 0 || lane >= 5) throw new RuleError("creature needs a lane 0..4");
        const initial = collectInto(() => {
          spawnCreature(game, events, p, inst.defId, inst.level, { lane, replace: true, fromHand: true });
          // "when an enemy creature enters play" triggers on the opposing side
          for (const c of s.players[opposing(p)].lanes) {
            if (c) collectFor(game, c, "enemyCreatureEntered", { sourceDefId: inst.defId, sourceOwner: p, lane });
          }
          // board-wide "when a creature enters play"
          collectAll(game, "creaturePlayed", (c) => ({ sourceUid: c.uid, sourceDefId: inst.defId, sourceOwner: p, lane }));
          collectAll(game, "cardPlayed", (c) => ({ sourceUid: c.uid, sourceDefId: inst.defId, sourceLevel: inst.level, sourceOwner: p, lane }));
        });
        result = runBatches(game, events, initial);
      } else {
        result = resolveSpell(game, events, inst, null, []);
      }
      break;
    }
    case "discardToLevel": {
      if (s.playsLeft <= 0) throw new RuleError("no plays left");
      const inst = pl.hand[action.handIndex];
      if (!inst) throw new RuleError("bad hand index");
      pl.hand.splice(action.handIndex, 1);
      s.playsLeft--;
      pl.discard.push(inst);
      events.push({ type: "discard", player: p, defId: inst.defId, level: inst.level });
      levelUpCopy(game, inst, events);
      result = runBatches(game, events, []);
      break;
    }
    case "battle": {
      if (s.battlesLeft <= 0) throw new RuleError("no battles left");
      s.battlesLeft--;
      events.push({ type: "battle" });
      result = runBattle(game, events);
      break;
    }
    case "activate": {
      const c = findCreature(s, action.uid);
      if (!c || c.owner !== p) throw new RuleError("no such creature");
      if (!isOffensive(c) || c.activatedThisTurn) throw new RuleError("cannot activate");
      const script = getLevelScript(c.defId, c.level);
      const ability = script?.activates?.[0];
      if (!ability) throw new RuleError("no activate ability");
      if (ability.condition && !ability.condition(game, c)) throw new RuleError("condition not met");
      events.push({ type: "activated", player: p, uid: c.uid, abilityId: ability.id });
      if (ability.prompt) {
        const req = ability.prompt(game, c);
        if (req) {
          s.pending = {
            resume: { kind: "activate", defId: c.defId, abilityId: ability.id, selfUid: c.uid },
            priorAnswers: [],
            request: { ...req, id: `c${s.nextUid++}` },
          };
          s.pendingQueue = [];
          return finishIfPaused(game, events, { paused: true });
        }
      }
      const actRet = ability.resolve({ game, events, rng: game.rng, priorAnswers: [], choose: neverChoose }, c, null);
      if (actRet) {
        s.pending = {
          resume: { kind: "activate", defId: c.defId, abilityId: ability.id, selfUid: c.uid },
          priorAnswers: [],
          request: { ...actRet, id: `c${s.nextUid++}` },
        };
        s.pendingQueue = [];
        return finishIfPaused(game, events, { paused: true });
      }
      c.activatedThisTurn = true;
      result = runBatches(game, events, []);
      break;
    }
    case "move": {
      const c = findCreature(s, action.uid);
      if (!c || c.owner !== p) throw new RuleError("no such creature");
      refreshStatics(game); // keyword grants may have changed since the last read
      const mobility = keywordValue(c, "Mobility");
      if (!isOffensive(c) || c.movedThisTurn || mobility <= 0) throw new RuleError("cannot move");
      if (Math.abs(action.lane - c.lane) > mobility || pl.lanes[action.lane]) {
        throw new RuleError("illegal lane");
      }
      const from = c.lane;
      pl.lanes[from] = null;
      pl.lanes[action.lane] = c;
      c.lane = action.lane;
      c.movedThisTurn = true;
      s.turnFlags.moved = true;
      events.push({ type: "moved", player: p, uid: c.uid, from, to: action.lane });
      const initial = collectInto(() => {
        collectFor(game, c, "moved", { sourceUid: c.uid, lane: action.lane });
        for (const other of pl.lanes) {
          if (other && other.uid !== c.uid) {
            collectFor(game, other, "friendlyCreatureMoved", { sourceUid: c.uid, sourceDefId: c.defId, lane: action.lane });
          }
        }
        for (const foe of s.players[opposing(p)].lanes) {
          if (foe) {
            collectFor(game, foe, "enemyCreatureMoved", { sourceUid: c.uid, sourceDefId: c.defId, lane: action.lane });
          }
        }
      });
      result = runBatches(game, events, initial);
      break;
    }
    case "endTurn": {
      endTurn(game, events);
      break;
    }
  }
  if (!result.paused) checkAmbush(game, events);
  return finishIfPaused(game, events, result);
}

function neverChoose(): never {
  throw new RuleError("internal: choose without prompt");
}

/**
 * Ambush: cards in the NON-active player's hand whose watch condition was met
 * this turn spawn a copy of themselves, then are discarded and leveled.
 */
function checkAmbush(game: Game, events: GameEvent[]): void {
  const s = game.state;
  const enemy = opposing(s.active);
  const hand = s.players[enemy].hand;
  for (let i = hand.length - 1; i >= 0; i--) {
    const inst = hand[i]!;
    const amb = getCardScript(inst.defId)?.ambush;
    if (!amb) continue;
    const matched =
      (amb.watch === "thirdEnemyCard" && s.cardsPlayedThisTurn === 3) ||
      (amb.watch === "enemyMove" && s.turnFlags.moved) ||
      (amb.watch === "enemyUnForgedEntry" && s.turnFlags.unForgedEntry) ||
      (amb.watch === "enemyHeal" && s.turnFlags.healed);
    if (!matched) continue;
    hand.splice(i, 1);
    const initial = collectInto(() => {
      spawnCreature(game, events, enemy, inst.defId, inst.level, {});
    });
    s.players[enemy].discard.push(inst);
    events.push({ type: "discard", player: enemy, defId: inst.defId, level: inst.level });
    levelUpCopy(game, inst, events);
    runBatches(game, events, initial);
  }
}

// ---------- spells ----------

function resolveSpell(
  game: Game, events: GameEvent[], inst: CardInstance,
  answer: ChoiceAnswer | null, priors: ChoiceAnswer[],
): RunResult {
  const s = game.state;
  const script = getCardScript(inst.defId);
  const spell = script?.spell?.[inst.level];
  if (spell?.prompt && answer === null) {
    const req = spell.prompt(game, inst.owner);
    if (req) {
      s.pending = {
        resume: { kind: "spell", defId: inst.defId, level: inst.level, player: inst.owner },
        priorAnswers: priors,
        request: { ...req, id: `c${s.nextUid++}` },
      };
      s.pendingQueue = [];
      return { paused: true };
    }
  }
  let chain: ResolveResult = undefined;
  if (spell && (answer === null || answer.accepted !== false)) {
    chain = spell.resolve({ game, events, rng: game.rng, priorAnswers: priors, choose: neverChoose }, inst.owner, answer);
  }
  if (chain) {
    s.pending = {
      resume: { kind: "spell", defId: inst.defId, level: inst.level, player: inst.owner },
      priorAnswers: priors,
      request: { ...chain, id: `c${s.nextUid++}` },
    };
    s.pendingQueue = [];
    return { paused: true };
  }
  // card goes to discard, or removed from the game with Overload
  const pl = s.players[inst.owner];
  if (cardHasKeyword(game, inst, "Overload")) pl.removed.push(inst);
  else pl.discard.push(inst);
  events.push({ type: "play", player: inst.owner, uid: inst.uid, defId: inst.defId, level: inst.level });
  // "when you play a card/spell" triggers fire after the card resolves
  const post = collectInto(() => {
    collectAll(game, "cardPlayed", (c) => ({ sourceUid: c.uid, sourceDefId: inst.defId, sourceLevel: inst.level, sourceOwner: inst.owner }));
    collectAll(game, "spellPlayed", (c) => ({ sourceUid: c.uid, sourceDefId: inst.defId, sourceLevel: inst.level, sourceOwner: inst.owner }));
  });
  return runBatches(game, events, post);
}

// wire spell resume (effects.ts -> here)
import { spellResume } from "./effects.js";
spellResume.resumeSpell = (game, events, defId, level, player, answer, priors) => {
  const inst: CardInstance = { uid: -1, defId, level, owner: player };
  // chained resume: resolveSpell handles discard/triggers once the chain ends
  const s = game.state;
  const script = getCardScript(defId);
  const spell = script?.spell?.[level];
  let chain: ResolveResult = undefined;
  if (spell && answer.accepted !== false) {
    chain = spell.resolve({ game, events, rng: game.rng, priorAnswers: priors, choose: neverChoose }, player, answer);
  }
  if (chain) return chain;
  const pl = s.players[player];
  if (cardHasKeyword(game, inst, "Overload")) pl.removed.push(inst);
  else pl.discard.push(inst);
  events.push({ type: "play", player, uid: inst.uid, defId, level });
  const post = collectInto(() => {
    collectAll(game, "cardPlayed", (c) => ({ sourceUid: c.uid, sourceDefId: defId, sourceLevel: level, sourceOwner: player }));
    collectAll(game, "spellPlayed", (c) => ({ sourceUid: c.uid, sourceDefId: defId, sourceLevel: level, sourceOwner: player }));
  });
  // these post-triggers are picked up by the runBatches call in resumeWithChoice
  game.state.pendingQueue = [...post, ...game.state.pendingQueue];
  return undefined;
};

export function applyChoice(game: Game, answer: ChoiceAnswer): GameEvent[] {
  const events: GameEvent[] = [];
  const r = resumeWithChoice(game, events, answer);
  if (!r.paused) checkAmbush(game, events);
  return finishIfPaused(game, events, r);
}

// ---------- battle ----------

function runBattle(game: Game, events: GameEvent[]): RunResult {
  const s = game.state;
  refreshStatics(game);
  // Batch 1: all combat damage, lanes left to right. Damage triggers are
  // collected and resolved as the following batch (death is checked at the
  // end of each batch inside runBatches).
  const initial = collectInto(() => {
    for (let lane = 0; lane < 5; lane++) {
    const a = s.players[0].lanes[lane];
    const b = s.players[1].lanes[lane];
    const aFights = a && canAttack(a);
    const bFights = b && canAttack(b);
    // Breakthrough: excess damage to the defending player.
    if (aFights) {
      a.hasBattled = true;
      if (b) {
        const stats = getStats(game, a);
        const remaining = Math.max(0, b.health - b.damage);
        dealCreatureDamage(game, events, b, stats.attack, a, true);
        if (hasKeyword(a, "Breakthrough")) {
          const excess = stats.attack - remaining;
          if (excess > 0) dealPlayerDamage(game, events, 1, excess, a, true);
        }
      } else {
        dealPlayerDamage(game, events, 1, getStats(game, a).attack, a, true);
      }
    }
    if (bFights) {
      b.hasBattled = true;
      if (a) {
        const stats = getStats(game, b);
        const remaining = Math.max(0, a.health - a.damage);
        dealCreatureDamage(game, events, a, stats.attack, b, true);
        if (hasKeyword(b, "Breakthrough")) {
          const excess = stats.attack - remaining;
          if (excess > 0) dealPlayerDamage(game, events, 0, excess, b, true);
        }
      } else {
        dealPlayerDamage(game, events, 0, getStats(game, b).attack, b, true);
      }
    }
    // Defenders hit back if attacked.
    if (a && b && aFights && !canAttack(b)) {
      dealCreatureDamage(game, events, a, getStats(game, b).attack, b, true);
    }
    if (a && b && bFights && !canAttack(a)) {
      dealCreatureDamage(game, events, b, getStats(game, a).attack, a, true);
    }
    }
  });
  // Batches 2+3 (damage triggers, then death triggers) run inside runBatches.
  return runBatches(game, events, initial);
}

// ---------- turn flow ----------

function startOfTurn(game: Game, events: GameEvent[]): void {
  const s = game.state;
  const p = s.active;
  const pl = s.players[p];
  s.cardsPlayedThisTurn = 0;
  s.turnFlags = { moved: false, unForgedEntry: false, healed: false };
  s.deathsThisTurn = [0, 0];
  s.deathLog = [];
  // reset per-turn flags for everyone
  for (const side of s.players) side.armorUsed = 0;
  for (const c of [...s.players[0].lanes, ...s.players[1].lanes]) {
    if (c) c.armorUsed = 0;
  }
  for (const c of pl.lanes) {
    if (!c) continue;
    c.defensive = false;
    c.movedThisTurn = false;
    c.activatedThisTurn = false;
    c.hasBattled = false;
  }
  // Poison first, then Regenerate; same batch — death checked after both.
  const initial = collectInto(() => {
    for (const c of pl.lanes) {
      if (!c) continue;
      const poison = keywordValue(c, "Poison");
      if (poison > 0) dealCreatureDamage(game, events, c, poison);
      const regen = keywordValue(c, "Regenerate");
      if (regen > 0) healCreature(game, events, c, regen);
    }
    if (pl.poison > 0) dealPlayerDamage(game, events, p, pl.poison);
    collectAll(game, "turnStart", (c) => ({ sourceUid: c.uid, lane: c.lane }));
  });
  runBatches(game, events, initial);
}

function endTurn(game: Game, events: GameEvent[]): void {
  const s = game.state;
  const p = s.active;
  const pl = s.players[p];

  for (const inst of pl.hand.splice(0)) {
    pl.discard.push(inst);
    events.push({ type: "discard", player: p, defId: inst.defId, level: inst.level });
  }

  // Raid + end-of-turn triggers happen before/with rank-up effects (same batch family).
  const initial = collectInto(() => {
    collectAll(game, "turnEnd", (c) => ({ sourceUid: c.uid, lane: c.lane }));

    if (pl.turnInRank === TURNS_PER_RANK) {
      pl.turnInRank = 1;
      pl.rank++;
      events.push({ type: "rankUp", player: p, rank: pl.rank });
      reshuffle(game, p, events, pl.rank);
      collectAll(game, "rankGained", (c) => ({ sourceUid: c.uid, lane: c.lane, amount: pl.rank }));
    } else {
      pl.turnInRank++;
    }
  });
  runBatches(game, events, initial);

  // temp effects wear off
  for (const side of s.players) {
    for (const c of side.lanes) {
      if (!c) continue;
      c.tempMods = [];
      c.tempKeywords = [];
    }
  }

  // Sudden Death: both at/below 0 — lowest life loses at end of turn.
  const other = s.players[opposing(p)];
  if (pl.health <= 0 && other.health <= 0 && pl.health !== other.health) {
    s.winner = pl.health < other.health ? opposing(p) : p;
    s.phase = "gameOver";
    events.push({ type: "gameOver", winner: s.winner });
    return;
  }

  drawCards(game, p, HAND_DRAW, events);

  s.active = opposing(p);
  if (s.active === 0) s.turnNumber++;
  s.playsLeft = PLAYS_PER_TURN;
  s.battlesLeft = 1;
  startOfTurn(game, events);
}
