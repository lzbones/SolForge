/**
 * Set 5 (Reign of Varna) + 5.1 + 5.2 — Nekrium card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set4-nekrium.ts):
 *  - Cacklebones: "the enemy player may play an additional card next turn" has
 *    no engine hook (playsLeft is reset to PLAYS_PER_TURN at every endTurn;
 *    nothing carries over). Emulated with a script-side tracker: the Forge
 *    records this Cacklebones' uid, and a turnStart trigger on it grants the
 *    extra play (state.playsLeft += 1) when the enemy's turn starts. Corners:
 *    the bonus is lost if Cacklebones leaves the field or is silenced before
 *    the enemy's turn starts (the real effect is player-level and persists).
 *  - Immortal Echoes: UNIMPLEMENTED. "At the end of this turn and your next
 *    turn" (L1/L2) and "at the end of each of your turns" (L3) need deferred
 *    player-level effects; the engine has no such hook and no persistent
 *    effect state (same gap as Lucid Echoes in set5-alloyin.ts). Registered
 *    so the defId resolves; playing it is currently a no-op. TODO.
 *  - Iniog, Carrion Demon L3: "When Iniog gains health, deal that much damage
 *    to the enemy player" is UNIMPLEMENTED — healCreature fires no trigger,
 *    and the Regenerate heal at turn start lands before turnStart triggers
 *    are even collected, so there is nothing to hook. TODO: needs a
 *    "creatureHealed" trigger (evt.amount) fired from healCreature. The L3
 *    Vengeance (put a level 1 Iniog into this space) IS implemented.
 *  - Iniog L1/L2: "replace this with a level N Iniog" uses spawnCreature with
 *    replace: true — the old Iniog goes to the discard without death triggers
 *    (engine replace semantics, Doppelbot precedent).
 *  - Varna, Immortal King: "a random friendly creature that was destroyed
 *    this turn" — the engine keeps only a per-turn death COUNT
 *    (state.deathsThisTurn), not an identity log. The pool is approximated
 *    from the discard pile: the last deathsThisTurn[owner] non-token creature
 *    cards in Varna's owner's discard, excluding Varna's own level-up copy
 *    (pushed onto the discard right before the Forge resolves). Corners:
 *    (a) level-up copies / discard-to-level cards pushed between deaths
 *    pollute the recency window; (b) Overload and Token deaths are counted
 *    but leave no card in the discard; (c) creatures killed earlier in the
 *    same batch chain as the Forge are missed. L4's own wipe is added to the
 *    pool explicitly (those creatures reach the discard only at batch end);
 *    its Spawn picks a random OPEN space at resolve time — spaces of the
 *    just-destroyed creatures are still occupied until the batch ends, so on
 *    a full board no copy is Spawned.
 *  - Spiritstone Sentry: "Spawn a Spiritstone Sentry" comes in at the level
 *    of the destroyed Sentry, in a random open space (Suruzal precedent).
 *  - Necromoeba: the purple Oozeling token is oozeling-purple (Set 3 data —
 *    load cards_Set_3.json); its scraped stats are "* / *", so overrideStats
 *    supplies the 1/1, 3/3, 5/5 bodies. Random open space.
 *  - Torrent Witch: puts a Spirit Torrent (a Set 2.1 card — load
 *    cards_Set_2.1.json) into hand. Spirit Torrent is not scripted in the
 *    set2 files, so it is scripted below as a support card (power-torrent
 *    convention from set5-alloyin.ts).
 *  - Scourge Hydra's Forge can target itself ("a friendly creature"); the
 *    Hydra is the damage source.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, destroyCreature, getStats, grantKeyword, isDeadEffective,
  spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, isDead, keywordValue, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import { isCreature } from "../types.js";
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

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

function boardUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

const isSide = (lane: number | undefined): boolean => lane === 0 || lane === 4;

// ============================================================
// Creatures
// ============================================================

// --- Abyssal Maw: Forge — if there is another friendly Abomination, give an
//     enemy creature -N attack and -N health. ---
registerCard({
  defId: "abyssal-maw",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].lanes.some((c) =>
            !!c && c.uid !== self.uid && hasSubtype(game, c.defId, "Abomination")),
        prompt: (game: Game, self: CreatureState) => req(
          `Give an enemy creature -${n} attack and -${n} health`,
          "enemyCreature",
          enemyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Brood Horror: when another friendly creature enters play, that creature
//     gets +N/+N, then Brood Horror gets -N/-N. ---
registerCard({
  defId: "brood-horror",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "brood-transfer",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceUid !== self.uid,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c && !isDead(c)) buffCreature(ctx.game, ctx.events, c, lvl, lvl);
          buffCreature(ctx.game, ctx.events, self, -lvl, -lvl); // shrinks even if the buff fizzled
        },
      }],
    }]),
  ),
});

// --- Cacklebones: Forge — destroy an enemy level cap-or-lower creature; if
//     you do, the enemy player may play an additional card next turn (tracker
//     approximation — see header note). ---
const cacklePending = new WeakMap<Game, Set<number>>();

function cackleAbilities(cap: number): Ability[] {
  return [
    {
      id: "forge-destroy",
      trigger: "enterFromHand" as const,
      targeted: true,
      prompt: (game: Game, self: CreatureState) => req(
        cap >= 99 ? "Destroy an enemy creature" : `Destroy an enemy level ${cap} or lower creature`,
        "enemyCreature",
        enemyUids(game, self.owner, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === self.owner) return;
        destroyCreature(ctx.game, ctx.events, c);
        let set = cacklePending.get(ctx.game);
        if (!set) { set = new Set(); cacklePending.set(ctx.game, set); }
        set.add(self.uid);
      },
    },
    {
      id: "enemy-bonus-play",
      trigger: "turnStart" as const,
      condition: (game: Game, self: CreatureState) =>
        game.state.active !== self.owner && (cacklePending.get(game)?.has(self.uid) ?? false),
      resolve: (ctx: Ctx, self: CreatureState) => {
        cacklePending.get(ctx.game)?.delete(self.uid);
        ctx.game.state.playsLeft += 1;
      },
    },
  ];
}
registerCard({
  defId: "cacklebones",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, { abilities: cackleAbilities(cap) }]),
  ),
});

// --- Iniog, Carrion Demon: L1/L2 grow Regenerate 1 on every creature death
//     and replace themselves with the next level at end of turn once their
//     Regenerate crosses the threshold; L3's heal-ping is UNIMPLEMENTED (see
//     header note) but its Vengeance respawns a level 1 Iniog in its space. ---
function iniogGrowth(): Ability {
  return {
    id: "carrion-grow",
    trigger: "anyCreatureDestroyed" as const,
    resolve: (ctx: Ctx, self: CreatureState) => {
      grantKeyword(ctx.events, self, { keyword: "Regenerate", value: 1 });
    },
  };
}
function iniogReplace(threshold: number): Ability {
  return {
    id: "carrion-replace",
    trigger: "turnEnd" as const,
    condition: (game: Game, self: CreatureState) =>
      game.state.active === self.owner && keywordValue(self, "Regenerate") >= threshold,
    resolve: (ctx: Ctx, self: CreatureState) => {
      spawnCreature(ctx.game, ctx.events, self.owner, "iniog-carrion-demon", self.level + 1,
        { lane: self.lane, replace: true });
    },
  };
}
registerCard({
  defId: "iniog-carrion-demon",
  levels: {
    1: { abilities: [iniogGrowth(), iniogReplace(5)] }, // Defender is inherent
    2: { abilities: [iniogGrowth(), iniogReplace(10)] }, // Regenerate 5 / Mobility 1 inherent
    3: {
      abilities: [{
        id: "vengeance-iniog",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          // occupied at resolution -> nothing happens (Crypt Slime convention)
          spawnCreature(ctx.game, ctx.events, self.owner, "iniog-carrion-demon", 1, { lane: evt.lane });
        },
      }],
    },
  },
});

// --- Leyline Demon (Ambush: third enemy card; engine handles spawn + discard/level) ---
registerCard({
  defId: "leyline-demon",
  ambush: { watch: "thirdEnemyCard" },
});

// --- Necromoeba: when dealt damage, Spawn an N/N Oozeling (purple token —
//     Set 3 data, overrideStats bodies; see header note). ---
registerCard({
  defId: "necromoeba",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "split",
        trigger: "damaged" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "oozeling-purple", 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Rot Wanderer: Forge — destroy an enemy creature with cap or less attack. ---
registerCard({
  defId: "rot-wanderer",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-cull",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Destroy an enemy creature with ${cap} or less attack`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => getStats(game, c).attack <= cap),
        ),
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Scourge Hydra: Forge — deal 3 damage to a friendly creature. ---
registerCard({
  defId: "scourge-hydra",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-lash",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "Deal 3 damage to a friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner), // may target itself (see header)
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, 3, self);
        },
      }],
    }]),
  ),
});

// --- Spiritstone Sentry: Vengeance — if it was in a side space, Spawn a
//     Spiritstone Sentry (same level, random open space — see header note). ---
registerCard({
  defId: "spiritstone-sentry",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-respawn",
        trigger: "destroyed" as const,
        condition: (_g: Game, _s: CreatureState, evt: TriggerPayload) => isSide(evt.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "spiritstone-sentry", self.level,
            { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Torrent Witch: L2/L3 Forge — put a level 2/3 Spirit Torrent into hand. ---
registerCard({
  defId: "torrent-witch",
  levels: {
    1: {}, // vanilla — explicit so the registry fallback never hands L1 the L3 script
    2: {
      abilities: [{
        id: "forge-spirit-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "spirit-torrent", level: 2, owner: self.owner,
          });
        },
      }],
    },
    3: {
      abilities: [{
        id: "forge-spirit-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "spirit-torrent", level: 3, owner: self.owner,
          });
        },
      }],
    },
  },
});

// --- Xithian Tormentor: Forge — destroy each other friendly creature. ---
registerCard({
  defId: "xithian-tormentor",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-slaughter",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const mine = ctx.game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && c.uid !== self.uid);
          for (const c of mine) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Varna, Immortal King (4 levels): Forge — Spawn a copy of a random
//     friendly creature destroyed this turn (discard-pool approximation — see
//     header note); L4 first destroys each other creature. ---

/** Friendly non-token creature cards destroyed this turn (see header note). */
function destroyedThisTurnPool(game: Game, self: CreatureState): { defId: string; level: number }[] {
  const n = game.state.deathsThisTurn[self.owner];
  if (n <= 0) return [];
  const pl = game.state.players[self.owner];
  // the Forged card's own level-up copy sits on top of the discard — exclude it
  const top = pl.discard.at(-1);
  const list = top && top.defId === self.defId && top.level === self.level + 1
    ? pl.discard.slice(0, -1)
    : pl.discard;
  return list
    .filter((inst) => {
      const def = game.state.cards[inst.defId];
      return !!def && isCreature(def) && def.rarity !== "Token";
    })
    .slice(-n)
    .map((inst) => ({ defId: inst.defId, level: inst.level }));
}

function varnaForge(wipe: boolean): Ability {
  return {
    id: wipe ? "forge-reclaim-wipe" : "forge-reclaim",
    trigger: "enterFromHand" as const,
    resolve: (ctx: Ctx, self: CreatureState) => {
      const pool = destroyedThisTurnPool(ctx.game, self);
      if (wipe) {
        const board: CreatureState[] = [];
        for (const c of allCreatures(ctx.game.state)) if (c.uid !== self.uid) board.push(c);
        for (const c of board) destroyCreature(ctx.game, ctx.events, c);
        // friendlies destroyed by this wipe are eligible immediately (see header)
        for (const c of board) {
          if (c.owner === self.owner && isDeadEffective(ctx.game, c)) {
            pool.push({ defId: c.defId, level: c.level });
          }
        }
      }
      if (!pool.length) return;
      const pick = ctx.rng.pick(pool);
      spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
    },
  };
}
registerCard({
  defId: "varna-immortal-king",
  levels: {
    1: { abilities: [varnaForge(false)] },
    2: { abilities: [varnaForge(false)] },
    3: { abilities: [varnaForge(false)] },
    4: { abilities: [varnaForge(true)] },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Bitterfrost Totem: give a creature -N/-N, plus an extra -2/-2 at the
//     listed Rank or higher (L1: Rank 2+, L2: Rank 3+, L3: Rank 4+). ---
registerCard({
  defId: "bitterfrost-totem",
  spell: Object.fromEntries(
    ([[1, 4, 2], [2, 8, 3], [3, 12, 4]] as const).map(([lvl, n, rankReq]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        const extra = ctx.game.state.players[player].rank >= rankReq ? 2 : 0;
        buffCreature(ctx.game, ctx.events, c, -(n + extra), -(n + extra));
      },
    }]),
  ),
});

// --- Immortal Echoes: UNIMPLEMENTED — deferred end-of-turn spawns need
//     player-level turn hooks the engine does not have (see header note). TODO. ---
registerCard({ defId: "immortal-echoes" });

// --- Vigor Leech: give an enemy creature -N/-N, or give a friendly creature
//     Regenerate N (mode chosen implicitly by the target — Countermeasure
//     convention from set5-alloyin.ts). ---
registerCard({
  defId: "vigor-leech",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give an enemy creature -${n} attack and -${n} health, or give a friendly creature Regenerate ${n}`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        if (c.owner === player) grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
        else buffCreature(ctx.game, ctx.events, c, -n, -n);
      },
    }]),
  ),
});

// --- Spirit Torrent (Set 2.1 support card for Torrent Witch — see header):
//     give a creature Regenerate N; Free at L2/L3 is inherent from the data. ---
registerCard({
  defId: "spirit-torrent",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Give a creature Regenerate ${n}`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
      },
    }]),
  ),
});
