/**
 * Effect primitives + batch/trigger resolution engine.
 *
 * Batches (see triggers.ts header): triggered abilities are collected into a
 * queue, ordered (active-untargeted, inactive-untargeted, active-targeted,
 * inactive-targeted; random within a group), then resolved. Death is checked
 * at the end of each batch; death triggers form the next batch. Resolution
 * pauses when an ability prompts for a choice and resumes via resumeWithChoice().
 *
 * Primitives (damage/spawn/buff/...) push new triggers into the queue of the
 * batch currently being processed via an internal "current queue" pointer, so
 * card scripts never handle queue plumbing.
 */
import type { Game } from "./game.js";
import {
  allCreatures, effectiveHealth, findCreature, hasKeyword, isDead, keywordValue, opposing,
  type CardInstance, type CreatureState, type KeywordValue,
  type PlayerId, type PlayerState,
} from "./state.js";
import type { GameEvent } from "./triggers.js";
import type {
  Ability, ChoiceAnswer, ChoiceRequest, Ctx, ResolveResult, StaticAbility, TriggerEvent, TriggerPayload,
} from "./triggers.js";
import { getGrantedAbility, getLevelScript } from "./scripts/registry.js";

// ---------- draw / reshuffle (shared primitives, also used by game.ts) ----------

export function drawCardsEffect(game: Game, events: GameEvent[], p: PlayerId, n: number): void {
  const pl = game.state.players[p];
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (pl.deck.length === 0) {
      reshuffleEffect(game, p, events, Infinity); // mid-draw: no rank gating
      if (pl.deck.length === 0) break;
    }
    pl.hand.push(pl.deck.pop()!);
    drawn++;
  }
  if (drawn) events.push({ type: "draw", player: p, count: drawn });
}

/**
 * Shuffle discard into deck. Rank-up shuffles gate out cards above the
 * player's rank. Consistent cards go into the top 20 of the new deck.
 */
export function reshuffleEffect(game: Game, p: PlayerId, events: GameEvent[], rankGate: number): void {
  const pl: PlayerState = game.state.players[p];
  const staying: CardInstance[] = [];
  const normal: CardInstance[] = [];
  const consistent: CardInstance[] = [];
  for (const c of pl.discard) {
    if (c.level > rankGate) { staying.push(c); continue; }
    const def = game.state.cards[c.defId];
    const lvl = def?.levels.find((l) => l.level === c.level);
    (lvl?.keywords?.some((k) => k.keyword === "Consistent") ? consistent : normal).push(c);
  }
  pl.discard = staying;
  const deck = game.rng.shuffle([...pl.deck, ...normal]);
  for (const c of game.rng.shuffle(consistent)) {
    const pos = Math.max(0, deck.length - game.rng.int(Math.min(20, deck.length + 1)));
    deck.splice(pos, 0, c);
  }
  pl.deck = deck;
  if (normal.length || consistent.length) events.push({ type: "reshuffle", player: p });
}

// ---------- stats ----------

export interface Stats { attack: number; health: number; }

/**
 * Compute static-ability contributions for creature `c`: stat deltas and
 * granted keywords. Providers apply in lane order, controller's side first
 * (Advanced Rules: "applied in left to right order").
 */
function computeStatics(game: Game, c: CreatureState): { attack: number; health: number; keywords: KeywordValue[] } {
  const out = { attack: 0, health: 0, keywords: [] as KeywordValue[] };
  for (const side of [c.owner, opposing(c.owner)] as PlayerId[]) {
    for (const other of game.state.players[side].lanes) {
      if (!other || isDead(other)) continue; // raw check: avoids getStats recursion
      const script = getLevelScript(other.defId, other.level);
      for (const s of script?.statics ?? []) s.apply(game, other, c, out);
    }
  }
  return out;
}

/** Recompute static keyword grants on every creature (call before reads). */
export function refreshStatics(game: Game): void {
  for (const c of allCreatures(game.state)) {
    c.staticKeywords = computeStatics(game, c).keywords;
  }
}

/** Effective stats: permanent values + temp mods + static abilities. */
export function getStats(game: Game, c: CreatureState): Stats {
  const st = computeStatics(game, c);
  return {
    attack: c.attack + c.tempMods.reduce((s, m) => s + m.attack, 0) + st.attack,
    health: c.health + c.tempMods.reduce((s, m) => s + m.health, 0) + st.health,
  };
}

/** Death check uses effective health (static +health keeps creatures alive). */
export function isDeadEffective(game: Game, c: CreatureState): boolean {
  return getStats(game, c).health - c.damage <= 0;
}

export function isOffensive(c: CreatureState): boolean {
  return !c.defensive || hasKeyword(c, "Aggressive");
}

export function canAttack(c: CreatureState): boolean {
  return isOffensive(c) && !hasKeyword(c, "Defender");
}

// ---------- batch items & the current queue ----------

export interface BatchItem {
  defId: string;
  abilityId: string;
  selfUid: number;
  /** Snapshot of the self creature's level at queue time (for resume). */
  selfLevel: number;
  evt: TriggerPayload;
}

let currentQueue: BatchItem[] | null = null;
function q(item: BatchItem): void {
  if (currentQueue) currentQueue.push(item);
}

/** Run fn while capturing its triggered items into a fresh array. */
export function collectInto(fn: () => void): BatchItem[] {
  const prev = currentQueue;
  const buf: BatchItem[] = [];
  currentQueue = buf;
  try {
    fn();
  } finally {
    currentQueue = prev;
  }
  return buf;
}

/** Collect `event` abilities of one creature into the current queue. */
export function collectFor(
  game: Game, self: CreatureState, event: TriggerEvent, evt: TriggerPayload,
): void {
  if (self.silenced) return;
  const script = getLevelScript(self.defId, self.level);
  for (const a of script?.abilities ?? []) {
    if (a.trigger === event && (!a.condition || a.condition(game, self, evt))) {
      q({ defId: self.defId, abilityId: a.id, selfUid: self.uid, selfLevel: self.level, evt });
    }
  }
  for (const ref of self.grantedAbilities) {
    const a = getGrantedAbility(ref);
    if (a && a.trigger === event && (!a.condition || a.condition(game, self, evt))) {
      q({ defId: self.defId, abilityId: ref, selfUid: self.uid, selfLevel: self.level, evt });
    }
  }
}

/** Collect `event` abilities of every creature on the board. */
export function collectAll(
  game: Game, event: TriggerEvent, evtFor: (c: CreatureState) => TriggerPayload,
): void {
  for (const c of allCreatures(game.state)) collectFor(game, c, event, evtFor(c));
}

// ---------- damage / heal / buff ----------

function pushDamageTriggers(
  game: Game, source: CreatureState | null,
  target: CreatureState | null, targetPlayer: PlayerId | null, amount: number, battle: boolean,
): void {
  if (amount <= 0) return;
  if (source) {
    const evt: TriggerPayload = {
      sourceUid: source.uid, sourceDefId: source.defId, sourceOwner: source.owner,
      amount, lane: target?.lane, targetPlayer: targetPlayer ?? undefined,
    };
    if (battle && targetPlayer !== null) {
      collectFor(game, source, "battleDamageToPlayer", evt);
      // board-wide: "when a friendly creature deals battle damage to a player"
      for (const c of game.state.players[source.owner].lanes) {
        if (c && c.uid !== source.uid) collectFor(game, c, "friendlyBattleDamageToPlayer", evt);
      }
    }
    if (battle && target) collectFor(game, source, "battleDamageToCreature", evt);
    if (target) collectFor(game, source, "dealtDamageToCreature", evt);
  }
  if (target) {
    collectFor(game, target, "damaged", {
      sourceUid: source?.uid, sourceDefId: source?.defId, sourceOwner: source?.owner,
      amount, lane: target.lane,
    });
  }
}

export function dealCreatureDamage(
  game: Game, events: GameEvent[], c: CreatureState,
  amount: number, source: CreatureState | null = null, battle = false,
): void {
  if (amount <= 0) return; // negative-attack creatures deal no damage
  const armorPool = Math.max(0, keywordValue(c, "Armor") - c.armorUsed);
  const absorbed = Math.min(armorPool, amount);
  c.armorUsed += absorbed;
  const dealt = Math.max(0, amount - absorbed);
  c.damage += dealt;
  if (isDeadEffective(game, c) && c.deathSeq === 0) c.deathSeq = ++game.state.deathCounter;
  events.push({ type: "damage", target: { player: c.owner, lane: c.lane }, amount: dealt });
  pushDamageTriggers(game, source, c, null, dealt, battle);
}

export function dealPlayerDamage(
  game: Game, events: GameEvent[], p: PlayerId,
  amount: number, source: CreatureState | null = null, battle = false,
): void {
  if (amount <= 0) return;
  const pl = game.state.players[p];
  const absorbed = Math.min(Math.max(0, pl.armor - pl.armorUsed), amount);
  pl.armorUsed += absorbed;
  pl.health -= amount - absorbed;
  events.push({ type: "playerDamage", player: p, amount: amount - absorbed });
  pushDamageTriggers(game, source, null, p, amount - absorbed, battle);
}

export function healPlayer(game: Game, events: GameEvent[], p: PlayerId, amount: number): void {
  game.state.players[p].health += amount;
  game.state.turnFlags.healed = true; // Ambush watches enemy heals
  events.push({ type: "heal", player: p, amount });
  collectAll(game, "playerHealed", (c) => ({ sourceUid: c.uid, lane: c.lane, targetPlayer: p, amount }));
}

export function healCreature(game: Game, events: GameEvent[], c: CreatureState, amount: number): void {
  const healed = Math.min(amount, c.damage);
  c.damage -= healed;
  if (!isDead(c)) c.deathSeq = 0;
  events.push({ type: "healCreature", player: c.owner, lane: c.lane, amount: healed });
  if (healed > 0) collectFor(game, c, "creatureHealed", { sourceUid: c.uid, lane: c.lane, amount: healed });
}

export function buffCreature(
  game: Game, events: GameEvent[], c: CreatureState,
  attack: number, health: number, temp = false,
): void {
  if (temp) c.tempMods.push({ attack, health });
  else { c.attack += attack; c.health += health; }
  if (!isDead(c)) c.deathSeq = 0; // buffed back above 0 before the batch ends
  events.push({ type: "buff", player: c.owner, lane: c.lane, attack, health, temp });
}

export function grantKeyword(
  events: GameEvent[], c: CreatureState, kw: KeywordValue, temp = false,
): void {
  (temp ? c.tempKeywords : c.keywords).push(kw);
  events.push({
    type: "grantKeyword", player: c.owner, lane: c.lane,
    keyword: kw.keyword, value: kw.value, temp,
  });
}

export function negateKeyword(events: GameEvent[], c: CreatureState, kw: string): void {
  c.keywords = c.keywords.filter((k) => k.keyword !== kw);
  c.tempKeywords = c.tempKeywords.filter((k) => k.keyword !== kw);
  events.push({ type: "negateKeyword", player: c.owner, lane: c.lane, keyword: kw });
}

/** Direct destruction (Cull the Weak etc.) — removal happens at batch end. */
export function destroyCreature(game: Game, events: GameEvent[], c: CreatureState): void {
  c.damage = Math.max(c.damage, getStats(game, c).health);
  if (c.deathSeq === 0) c.deathSeq = ++game.state.deathCounter;
  events.push({ type: "marked", player: c.owner, lane: c.lane, defId: c.defId });
}

export interface SpawnOptions { lane?: number | "random"; replace?: boolean; fromHand?: boolean; overrideStats?: { attack: number; health: number }; }

export function spawnCreature(
  game: Game, events: GameEvent[], owner: PlayerId,
  defId: string, level: number, opts: SpawnOptions = {},
): CreatureState | null {
  const pl = game.state.players[owner];
  let lane: number;
  if (opts.lane === undefined || opts.lane === "random") {
    const open = pl.lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
    if (!open.length) return null;
    lane = game.rng.pick(open);
  } else {
    lane = opts.lane;
  }
  const existing = pl.lanes[lane];
  if (existing && !opts.replace) return null;
  const replaced = existing && opts.replace
    ? { ...existing }
    : null;
  if (existing && opts.replace) {
    pl.discard.push({ uid: existing.uid, defId: existing.defId, level: existing.level, owner: existing.owner });
  }
  const def = game.state.cards[defId];
  if (!def) throw new Error(`unknown spawn defId ${defId}`);
  const lvl = def.levels[Math.min(level, def.levels.length) - 1]!;
  const c: CreatureState = {
    uid: game.state.nextUid++, defId, level: lvl.level, owner, lane,
    attack: opts.overrideStats?.attack ?? lvl.attack ?? 0,
    health: opts.overrideStats?.health ?? lvl.health ?? 0,
    damage: 0,
    defensive: true,
    keywords: (lvl.keywords ?? []).map((k) => ({ ...k })),
    tempKeywords: [], staticKeywords: [], silenced: false, grantedAbilities: [], tempMods: [],
    deathSeq: 0, extraBattles: 0, hasBattled: false,
    armorUsed: 0, movedThisTurn: false, activatedThisTurn: false,
  };
  pl.lanes[lane] = c;
  events.push({ type: "spawn", player: owner, uid: c.uid, defId, level: lvl.level, lane });
  if (!opts.fromHand) game.state.turnFlags.unForgedEntry = true; // Ambush watches un-Forged entries
  collectFor(game, c, "enterPlay", { sourceUid: c.uid, sourceDefId: defId, sourceOwner: owner, lane, fromHand: opts.fromHand ?? false });
  if (replaced) {
    // Upgrade triggers: evt carries the REPLACED creature's identity/base stats.
    collectFor(game, c, "enterReplace", {
      sourceUid: replaced.uid, sourceDefId: replaced.defId, sourceLevel: replaced.level,
      amount: replaced.attack, lane, fromHand: opts.fromHand ?? false,
    });
    // replaced creature's own "when this is replaced" + board-wide broadcast:
    // evt carries the NEW creature's identity.
    snapshots(game).set(replaced.uid, replaced); // keep it resolvable in the batch
    const enterEvt: TriggerPayload = {
      sourceUid: c.uid, sourceDefId: defId, sourceLevel: c.level, sourceOwner: owner, lane,
      fromHand: opts.fromHand ?? false,
    };
    collectFor(game, replaced, "wasReplaced", enterEvt);
    for (const other of allCreatures(game.state)) {
      if (other.uid !== c.uid) collectFor(game, other, "creatureReplaced", enterEvt);
    }
  }
  if (opts.fromHand) {
    collectFor(game, c, "enterFromHand", { sourceUid: c.uid, sourceDefId: defId, sourceOwner: owner, lane, fromHand: true });
  }
  // board-wide: "whenever a creature enters play" (justicar/deathweaver etc.)
  for (const other of allCreatures(game.state)) {
    if (other.uid !== c.uid) {
      collectFor(game, other, "anyCreatureEnterPlay", {
        sourceUid: c.uid, sourceDefId: defId, sourceOwner: owner, lane, fromHand: opts.fromHand ?? false,
      });
    }
  }
  return c;
}

/** Banish a card from a discard pile: it leaves the game (removed pile), no triggers. */
export function banishFromDiscard(
  game: Game, events: GameEvent[], p: PlayerId, discardIndex: number,
): void {
  const pl = game.state.players[p];
  const inst = pl.discard[discardIndex];
  if (!inst) return;
  pl.discard.splice(discardIndex, 1);
  pl.removed.push(inst);
  events.push({ type: "banished", player: p, defId: inst.defId, level: inst.level });
}

/** Banish a creature from the board: removed from the game, NO death triggers. */
export function banishCreature(game: Game, events: GameEvent[], c: CreatureState): void {
  const pl = game.state.players[c.owner];
  if (pl.lanes[c.lane]?.uid === c.uid) pl.lanes[c.lane] = null;
  pl.removed.push({ uid: c.uid, defId: c.defId, level: c.level, owner: c.owner });
  events.push({ type: "banished", player: c.owner, defId: c.defId, level: c.level });
}

/**
 * Move a creature to another open lane (no Mobility/legality checks — those
 * live in game.ts's move action). Broadcasts moved / friendlyCreatureMoved /
 * enemyCreatureMoved.
 */
export function moveCreature(game: Game, events: GameEvent[], c: CreatureState, to: number): void {
  const pl = game.state.players[c.owner];
  if (to === c.lane || to < 0 || to >= pl.lanes.length || pl.lanes[to]) return;
  const from = c.lane;
  pl.lanes[from] = null;
  pl.lanes[to] = c;
  c.lane = to;
  c.movedThisTurn = true;
  game.state.turnFlags.moved = true;
  events.push({ type: "moved", player: c.owner, uid: c.uid, from, to });
  collectFor(game, c, "moved", { sourceUid: c.uid, lane: to });
  for (const other of pl.lanes) {
    if (other && other.uid !== c.uid) {
      collectFor(game, other, "friendlyCreatureMoved", { sourceUid: c.uid, sourceDefId: c.defId, lane: to });
    }
  }
  for (const foe of game.state.players[opposing(c.owner)].lanes) {
    if (foe) {
      collectFor(game, foe, "enemyCreatureMoved", { sourceUid: c.uid, sourceDefId: c.defId, lane: to });
    }
  }
}

// ---------- death ----------

export interface DeathInfo {
  uid: number; defId: string; level: number; owner: PlayerId; lane: number;
  snapshot: CreatureState;
}

export function deathCheck(game: Game, events: GameEvent[]): DeathInfo[] {
  const dead: CreatureState[] = [];
  for (const p of [0, 1] as const) {
    for (const c of game.state.players[p].lanes) {
      if (c && isDeadEffective(game, c)) {
        if (c.deathSeq === 0) c.deathSeq = ++game.state.deathCounter;
        dead.push(c);
      }
    }
  }
  dead.sort((a, b) => a.deathSeq - b.deathSeq);
  const infos: DeathInfo[] = [];
  for (const c of dead) {
    game.state.deathsThisTurn[c.owner]++;
    game.state.deathLog.push({ defId: c.defId, level: c.level, owner: c.owner });
    game.state.players[c.owner].lanes[c.lane] = null;
    // creature Overload: removed from the game instead of hitting the discard
    const cdef = game.state.cards[c.defId];
    const clvl = cdef?.levels.find((l) => l.level === c.level);
    const overloaded = clvl?.keywords?.some((k) => k.keyword === "Overload") ?? false;
    game.state.players[c.owner][overloaded ? "removed" : "discard"].push(
      { uid: c.uid, defId: c.defId, level: c.level, owner: c.owner });
    infos.push({
      uid: c.uid, defId: c.defId, level: c.level, owner: c.owner, lane: c.lane,
      snapshot: { ...c },
    });
    events.push({ type: "destroyed", player: c.owner, lane: c.lane, defId: c.defId });
  }
  const [a, b] = game.state.players;
  if (a.health <= 0 || b.health <= 0) {
    if (a.health !== b.health) {
      game.state.winner = a.health < b.health ? 1 : 0;
      game.state.phase = "gameOver";
      events.push({ type: "gameOver", winner: game.state.winner });
    }
    // equal: Sudden Death — resolved at end of turn (game.ts)
  }
  return infos;
}

function deathTriggersFor(game: Game, info: DeathInfo): void {
  const evt: TriggerPayload = {
    sourceUid: info.uid, sourceDefId: info.defId, sourceLevel: info.level,
    sourceOwner: info.owner, lane: info.lane,
  };
  collectFor(game, info.snapshot, "destroyed", evt); // Vengeance
  for (const c of allCreatures(game.state)) {
    collectFor(game, c, "anyCreatureDestroyed", evt);
    if (c.owner === info.owner) collectFor(game, c, "friendlyCreatureDestroyed", evt);
    else collectFor(game, c, "creatureDied", evt);
    if (c.owner !== info.owner && c.lane === info.lane) {
      collectFor(game, c, "opposingCreatureDestroyed", evt);
    }
  }
}

// ---------- batch runner ----------

function abilityOf(item: BatchItem): Ability | null {
  const granted = getGrantedAbility(item.abilityId);
  if (granted) return granted;
  const script = getLevelScript(item.defId, item.selfLevel);
  return script?.abilities?.find((a) => a.id === item.abilityId) ?? null;
}

/** Ordered in-place per batch rules; random within groups. */
function ordered(game: Game, items: BatchItem[]): { item: BatchItem; ability: Ability }[] {
  const active = game.state.active;
  const pairs = items
    .map((item) => ({ item, ability: abilityOf(item) }))
    .filter((x): x is { item: BatchItem; ability: Ability } => x.ability !== null);
  const groups = new Map<number, typeof pairs>();
  for (const x of pairs) {
    const self = findCreature(game.state, x.item.selfUid);
    const owner = self?.owner ?? x.item.evt.sourceOwner ?? active;
    const g = (owner === active ? 0 : 2) + (x.ability.targeted ? 1 : 0);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(x);
  }
  const out: typeof pairs = [];
  for (const g of [0, 1, 2, 3]) out.push(...game.rng.shuffle(groups.get(g) ?? []));
  return out;
}

export interface RunResult { paused: boolean; }

/** Triggers that still resolve for a creature that died mid-batch. */
const DEATHBLOW_TRIGGERS = new Set<string>([
  "battleDamageToPlayer", "battleDamageToCreature", "dealtDamageToCreature", "damaged",
]);

const deadSnapshots = new WeakMap<Game, Map<number, CreatureState>>();
function snapshots(game: Game): Map<number, CreatureState> {
  let m = deadSnapshots.get(game);
  if (!m) { m = new Map(); deadSnapshots.set(game, m); }
  return m;
}

export function runBatches(game: Game, events: GameEvent[], initial: BatchItem[]): RunResult {
  let queue = initial;
  // Always run at least one death check (battle damage outside a batch, etc.)
  while (true) {
    const processing = ordered(game, queue);
    currentQueue = processing.map((p) => p.item); // new triggers append here
    const byItem = new Map(processing.map((p) => [p.item, p.ability]));
    queue = [];
    for (let i = 0; i < currentQueue.length; i++) {
      refreshStatics(game);
      const item = currentQueue[i]!;
      let ability = byItem.get(item);
      if (!ability) {
        ability = abilityOf(item) ?? undefined; // appended mid-batch
        if (!ability) continue;
        byItem.set(item, ability);
      }
      const self = findCreature(game.state, item.selfUid) ?? snapshots(game).get(item.selfUid);
      if (!self) continue;
      // Dead creatures lose their pending triggers — except damage-family
      // triggers: combat is simultaneous, so a creature that dealt/took fatal
      // damage still applies its "when this deals/is dealt damage" effects
      // (Ghostscale Cobra poisons the creature that killed it).
      if (isDeadEffective(game, self) && ability.trigger !== "destroyed"
        && !DEATHBLOW_TRIGGERS.has(ability.trigger) && self.lane >= 0) continue;
      if (ability.prompt) {
        const req = ability.prompt(game, self, item.evt);
        if (req) {
          pause(game, { kind: "trigger", defId: item.defId, abilityId: item.abilityId, selfUid: item.selfUid, selfLevel: item.selfLevel, evt: item.evt },
            req, [], currentQueue.slice(i + 1));
          currentQueue = null;
          return { paused: true };
        }
      }
      const ret = ability.resolve(makeCtx(game, events, []), self, item.evt, null);
      if (ret) { // multi-step chain: first resolve produced another request
        pause(game, { kind: "trigger", defId: item.defId, abilityId: item.abilityId, selfUid: item.selfUid, selfLevel: item.selfLevel, evt: item.evt },
          ret, [], currentQueue.slice(i + 1));
        currentQueue = null;
        return { paused: true };
      }
    }
    currentQueue = null;
    // end of batch: death check -> death triggers form the next batch
    const deaths = deathCheck(game, events);
    const next = collectInto(() => {
      for (const d of deaths) {
        snapshots(game).set(d.uid, d.snapshot);
        deathTriggersFor(game, d);
      }
    });
    if (!next.length) break;
    queue = next;
  }
  return { paused: false };
}

function pause(
  game: Game, resume: import("./state.js").PendingChoice["resume"],
  req: Omit<ChoiceRequest, "id">, priorAnswers: ChoiceAnswer[], rest: BatchItem[],
): void {
  game.state.pending = {
    resume, priorAnswers,
    request: { ...req, id: `c${game.state.nextUid++}` },
  };
  game.state.pendingQueue = rest;
}

// ---------- ctx / choice resume ----------

export function makeCtx(game: Game, events: GameEvent[], priorAnswers: ChoiceAnswer[] = []): Ctx {
  return {
    game,
    events,
    rng: game.rng,
    priorAnswers,
    choose(req) {
      const request: ChoiceRequest = { ...req, id: `c${game.state.nextUid++}` };
      throw new Error("synchronous choose() is not supported; use prompt() — " + request.id);
    },
  };
}

/** Resume after a choice answer. May pause again (further prompts / chains). */
export function resumeWithChoice(game: Game, events: GameEvent[], answer: ChoiceAnswer): RunResult {
  const pending = game.state.pending;
  if (!pending) throw new Error("no pending choice");
  game.state.pending = null;
  const priors = [...pending.priorAnswers, answer];
  const ctx = makeCtx(game, events, priors);
  const r = pending.resume;
  const declined = answer.accepted === false;
  // Effects produced during the resumed resolve collect their triggers too.
  const box: { ret: ResolveResult } = { ret: undefined };
  const effectTriggers = collectInto(() => {
    if (r.kind === "trigger") {
      const self = findCreature(game.state, r.selfUid) ?? snapshots(game).get(r.selfUid);
      const ability = self ? abilityOf({ defId: r.defId, abilityId: r.abilityId, selfUid: r.selfUid, selfLevel: r.selfLevel, evt: r.evt }) : null;
      box.ret = self && ability && !declined ? ability.resolve(ctx, self, r.evt, answer) : undefined;
    } else if (r.kind === "activate") {
      const self = findCreature(game.state, r.selfUid);
      const script = self ? getLevelScript(r.defId, self.level) : null;
      const ability = script?.activates?.find((a) => a.id === r.abilityId);
      if (self && ability && !declined) {
        box.ret = ability.resolve(ctx, self, answer);
        self.activatedThisTurn = true;
      }
    } else {
      box.ret = spellResume.resumeSpell(game, events, r.defId, r.level, r.player, answer, priors);
    }
  });
  const ret = box.ret;
  if (effectTriggers.length) {
    game.state.pendingQueue = [...effectTriggers, ...game.state.pendingQueue];
  }
  if (ret) {
    pause(game, r, ret, priors, game.state.pendingQueue);
    return { paused: true };
  }
  const rest = game.state.pendingQueue;
  game.state.pendingQueue = [];
  return runBatches(game, events, rest);
}

/** Wired in game.ts to avoid a circular import. */
export const spellResume: {
  resumeSpell: (game: Game, events: GameEvent[], defId: string, level: number,
    player: PlayerId, answer: ChoiceAnswer, priors: ChoiceAnswer[]) => ResolveResult;
} = {
  resumeSpell: () => { throw new Error("spell resume not wired"); },
};
