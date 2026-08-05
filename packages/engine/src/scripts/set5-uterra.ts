/**
 * Set 5 (Reign of Varna) + 5.1 + 5.2 — Uterra card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set4-uterra.ts / set5-nekrium.ts):
 *  - Ancestral Echoes: UNIMPLEMENTED. "At the end of this turn and your next
 *    turn" (L1/L2) and "at the end of each of your turns" (L3) are deferred
 *    player-level effects; the engine has no such hook and no persistent
 *    effect state (same gap as Immortal Echoes in set5-nekrium.ts / Draconic
 *    Echoes in set5-tempys.ts). Registered so the defId resolves; playing it
 *    is currently a no-op. TODO.
 *  - Cavern Serpent: the scraped text has no Forge prefix ("The enemy player
 *    gets Poison N"), so the grant fires on enterPlay — any entry, including
 *    Spawned copies. Player poison is a persistent stacking counter (wiki
 *    Poison rulings), granted as a one-shot `poison += N` (venomous-netherscale
 *    convention — silent, no GameEvent for player poison). Corner: if the real
 *    client treated this as from-hand only, Spawned copies should not apply it.
 *  - Shardplate Behemoth: "attack is equal to its health" is a static (Advanced
 *    Rules) that SETS attack to the current health (damage included) at its
 *    lane-order position: it overwrites attack deltas accumulated so far and
 *    neutralizes one-time attack modifiers (wiki ruling: Electro Net does not
 *    affect it), while later-applied statics (e.g. a General to its right)
 *    still add on top. getStats() reads it; raw `attack` stays 0.
 *  - Malice Hermit: "when a creature with Poison is destroyed" — the death
 *    broadcast (anyCreatureDestroyed) carries no keywords and the dead
 *    creature is already out of its lane, so the Hermit cannot inspect it
 *    directly. Approximated by a per-game uid census of poisoned creatures,
 *    maintained by a no-op static ("poison-census"): computeStatics runs on
 *    every getStats/refreshStatics, and both are reached on every damage,
 *    destroy, death check, battle and legalActions pass, so anything that had
 *    Poison when it died is effectively always recorded. Creatures with
 *    inherent (printed) Poison are also matched from the def data as a
 *    fallback. Corners: (a) the census is provider-gated — a dead/silenced
 *    Hermit records nothing (but a dead Hermit's growth trigger would be
 *    dropped anyway); (b) a negateKeyword("Poison") would leave a stale census
 *    entry (nothing in the engine negates Poison today); (c) poison granted
 *    and lethal damage landing between the death check's getStats and the
 *    death-trigger collection in the same instant is not observable — no such
 *    sequence exists in the current engine.
 *  - Snowdrift Alpha: "an available space" is a random open space (Spawn
 *    convention — no lane-choice kind exists). The Hunting Pack is the real
 *    Set 1 card (scraped 3/2, 6/4, 12/8 match the text), so its own enterPlay
 *    50%-chain fires when it enters (faithful).
 *  - Torrent Soldier: Spore Torrent is already scripted in set2-uterra.ts
 *    (unlike Torrent Witch's Spirit Torrent), so the Forge just puts the card
 *    into hand. Load cards_Set_2.json for the def. L1 is vanilla.
 *  - Stinging Invocation: "1 to 3" is a uniform rng count (Category: RNG on
 *    the wiki); the Bees enter at the spell's level (spiritstone-sentry
 *    convention — same-named spawns come in at the source's level).
 *  - Everflow Eidolon: creatureHealed covers actual heals (including
 *    Regenerate ticks); "+N health" buffs do NOT fire it — buffCreature has
 *    no broadcast, so Lysian Rain-style health gains never trigger Everflow
 *    (engine gap; same family as Iniog L3's missing heal-ping).
 *  - Killer Bee L3: "that much Poison" is the post-armor damage dealt
 *    (evt.amount), per the Poison rulings (armor prevents the damage, and
 *    zero damage dealt fires no trigger at all).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, grantKeyword, healPlayer, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, keywordValue, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Game } from "../game.js";
import type { Ability, ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function req(
  prompt: string, kind: ChoiceRequest["kind"], options: number[], optional = false,
): Omit<ChoiceRequest, "id"> | null {
  if (!options.length) return null;
  return optional ? { kind, prompt, options, optional: true } : { kind, prompt, options };
}

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function boardUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

function openLanes(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
}

// ============================================================
// Creatures
// ============================================================

// --- Cavern Serpent: when it enters play, the enemy player gets Poison N
//     (persistent player counter — see header note). ---
registerCard({
  defId: "cavern-serpent",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "venomous-entry",
        trigger: "enterPlay" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[opposing(self.owner)].poison += n; // silent: no GameEvent
        },
      }],
    }]),
  ),
});

// --- Everflow Eidolon (Set 5.2): "When Everflow Eidolon gains health, you
//     gain that much health" (L3: 2x). creatureHealed = actual heals only. ---
registerCard({
  defId: "everflow-eidolon",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "everflow",
        trigger: "creatureHealed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const healed = evt.amount ?? 0;
          if (healed > 0) healPlayer(ctx.game, ctx.events, self.owner, healed * (lvl === 3 ? 2 : 1));
        },
      }],
    }]),
  ),
});

// --- Killer Bee: when it deals battle damage to a creature or player, they
//     get Poison N (L3: that much Poison). Mobility 1 is inherent. ---
function beeAbilities(n: number | null): { abilities: Ability[] } {
  const value = (evt: TriggerPayload): number => n ?? evt.amount ?? 0;
  return {
    abilities: [
      {
        id: "sting-player",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
          if (evt.targetPlayer === undefined) return;
          ctx.game.state.players[evt.targetPlayer].poison += value(evt); // silent: no GameEvent
        },
      },
      {
        id: "sting-creature",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          const v = value(evt);
          if (t && v > 0) grantKeyword(ctx.events, t, { keyword: "Poison", value: v });
        },
      },
    ],
  };
}
registerCard({
  defId: "killer-bee",
  levels: { 1: beeAbilities(1), 2: beeAbilities(3), 3: beeAbilities(null) },
});

// --- Leyline Golem (Ambush: enemy creature moves; engine handles spawn +
//     discard/level). ---
registerCard({
  defId: "leyline-golem",
  ambush: { watch: "enemyMove" },
});

// --- Malice Hermit (Set 5.1): Forge — each other creature gets Poison N;
//     when a creature with Poison is destroyed, this gets +N/+N (poison
//     census approximation — see header note). ---
const poisonCensus = new WeakMap<Game, Set<number>>();

function censusAdd(game: Game, uid: number): void {
  let set = poisonCensus.get(game);
  if (!set) { set = new Set(); poisonCensus.set(game, set); }
  set.add(uid);
}

/** Printed Poison on the destroyed creature's def (census fallback). */
function inherentPoison(game: Game, defId: string | undefined, level: number | undefined): boolean {
  if (defId === undefined) return false;
  const lvl = game.state.cards[defId]?.levels.find((l) => l.level === (level ?? 1));
  return lvl?.keywords?.some((k) => k.keyword === "Poison") ?? false;
}

registerCard({
  defId: "malice-hermit",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "forge-plague",
          trigger: "enterFromHand" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of allCreatures(ctx.game.state)) {
              if (c.uid !== self.uid) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
            }
          },
        },
        {
          id: "malice-grow",
          trigger: "anyCreatureDestroyed" as const,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceUid !== undefined && evt.sourceUid !== self.uid
            && ((poisonCensus.get(game)?.has(evt.sourceUid) ?? false)
              || inherentPoison(game, evt.sourceDefId, evt.sourceLevel)),
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
      ],
      statics: [{
        // no-op on stats: records poisoned creatures' uids on every statics
        // pass so "malice-grow" can tell the dead creature had Poison.
        id: "poison-census",
        apply: (game: Game, _s: CreatureState, target: CreatureState) => {
          if (keywordValue(target, "Poison") > 0) censusAdd(game, target.uid);
        },
      }],
    }]),
  ),
});

// --- Shardplate Behemoth: static — its attack is set to its current health
//     (Advanced Rules lane-order semantics — see header note). ---
registerCard({
  defId: "shardplate-behemoth",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      statics: [{
        id: "attack-equals-health",
        apply: (_g: Game, self: CreatureState, target: CreatureState, out: { attack: number; health: number }) => {
          if (target.uid !== self.uid) return;
          const tempH = target.tempMods.reduce((s, m) => s + m.health, 0);
          const tempA = target.tempMods.reduce((s, m) => s + m.attack, 0);
          out.attack = (target.health + tempH + out.health - target.damage) - (target.attack + tempA);
        },
      }],
    }]),
  ),
});

// --- Snowdrift Alpha: Activate — put a Hunting Pack (real Set 1 card, level
//     = Alpha's level) into a random open space. ---
registerCard({
  defId: "snowdrift-alpha",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "call-pack",
        condition: (game: Game, self: CreatureState) => openLanes(game, self.owner).length > 0,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "hunting-pack", self.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Toorgmai Mender: Forge — give a creature or player +N health
//     (Lysian Rain convention: creatures get a permanent +health buff,
//     players gain health). ---
registerCard({
  defId: "toorgmai-mender",
  levels: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-mend",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game) => ({
          kind: "anyCreatureOrPlayer" as const,
          prompt: `Give a creature or player +${n} health`,
          options: [-1, -2, ...boardUids(game)],
        }),
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const t = choice?.targetUid;
          if (t === undefined) return;
          if (t === -1) { healPlayer(ctx.game, ctx.events, 0, n); return; }
          if (t === -2) { healPlayer(ctx.game, ctx.events, 1, n); return; }
          const c = findCreature(ctx.game.state, t);
          if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
        },
      }],
    }]),
  ),
});

// --- Torrent Soldier: L2/L3 Forge — put a level 2/3 Spore Torrent into hand
//     (spore-torrent is scripted in set2-uterra.ts — see header note). ---
function soldierForge(lvl: number): Ability {
  return {
    id: "forge-spore-torrent",
    trigger: "enterFromHand" as const,
    resolve: (ctx: Ctx, self: CreatureState) => {
      ctx.game.state.players[self.owner].hand.push({
        uid: ctx.game.state.nextUid++, defId: "spore-torrent", level: lvl, owner: self.owner,
      });
    },
  };
}
registerCard({
  defId: "torrent-soldier",
  levels: {
    1: {}, // vanilla — explicit so the registry fallback never hands L1 the L3 script
    2: { abilities: [soldierForge(2)] },
    3: { abilities: [soldierForge(3)] },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Ancestral Echoes: UNIMPLEMENTED — deferred player-level end-of-turn
//     buffs need hooks the engine does not have (see header note). TODO. ---
registerCard({ defId: "ancestral-echoes" });

// --- Dendrify: replace a creature (L1: level 2 or lower) with a 7/7 Treefolk
//     under the same controller. L3 Free/Overload are inherent. ---
registerCard({
  defId: "dendrify",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap >= 99
          ? "Replace a creature with a 7/7 Treefolk"
          : `Replace a level ${cap} or lower creature with a 7/7 Treefolk`,
        "anyCreature",
        boardUids(game, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        // treefolk token stats are scraped "*", so overrideStats (7/7)
        spawnCreature(ctx.game, ctx.events, c.owner, "treefolk", 1,
          { lane: c.lane, replace: true, overrideStats: { attack: 7, health: 7 } });
      },
    }]),
  ),
});

// --- Stinging Invocation (Set 5.1): Spawn 1 to 3 Killer Bees at the spell's
//     level (see header note). ---
registerCard({
  defId: "stinging-invocation",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const count = 1 + ctx.rng.int(3);
        for (let i = 0; i < count; i++) {
          if (!spawnCreature(ctx.game, ctx.events, player, "killer-bee", lvl, { lane: "random" })) break;
        }
      },
    }]),
  ),
});

// --- Toxic Boon: give an enemy creature Poison N, or give a friendly
//     creature +N/+N (mode chosen implicitly by the target — Vigor Leech /
//     Countermeasure convention). ---
registerCard({
  defId: "toxic-boon",
  spell: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give an enemy creature Poison ${n}, or give a friendly creature +${n} attack and +${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        if (c.owner === player) buffCreature(ctx.game, ctx.events, c, n, n);
        else grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
      },
    }]),
  ),
});

// --- Ursine Strength: give a creature +N/+N, plus an extra +2/+2 at the
//     listed Rank or higher (L1: Rank 2+, L2: Rank 3+, L3: Rank 4+) —
//     Bitterfrost Totem convention. ---
registerCard({
  defId: "ursine-strength",
  spell: Object.fromEntries(
    ([[1, 3, 2], [2, 7, 3], [3, 11, 4]] as const).map(([lvl, n, rankReq]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${n} attack and +${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        const extra = ctx.game.state.players[player].rank >= rankReq ? 2 : 0;
        buffCreature(ctx.game, ctx.events, c, n + extra, n + extra);
      },
    }]),
  ),
});
