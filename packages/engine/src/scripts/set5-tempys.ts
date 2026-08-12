/**
 * Set 5 (Reign of Varna) + 5.1 + 5.2 — Tempys card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set4-tempys.ts / set5-nekrium.ts):
 *  - Blizzard Shaman: both picks (the moved creature and its destination) are
 *    random, so there is no choice; moveCreature no-ops on a blocked landing.
 *  - Draconic Echoes: the deferred burn is a player-level effect (registry
 *    ref tempys:draconic-echoes-N). L1/L2 attach it with 2 applications
 *    ("this turn and your next turn" — opponent turn ends fail the
 *    active-player condition and do not count down); L3 attaches it
 *    permanently. "1 to N damage" is a uniform rng roll (Stinging Invocation
 *    convention).
 *  - Everflame Aura: the two modes share one anyCreature choice and branch on
 *    the target's owner (Vigor Leech / Countermeasure convention).
 *  - Shatterbolt: "Negate Armor from a creature or player this turn" is
 *    modeled by maxing out armorUsed — the Armor pool is
 *    max(0, value - armorUsed), and startOfTurn resets armorUsed for everyone,
 *    so Armor (including Armor gained later that turn) absorbs nothing for the
 *    rest of the turn and returns next turn. Creature Armor granted only by
 *    static abilities is covered too (the pool is computed from keywordValue).
 *  - Sparkstone Elemental: the scraped text has no Forge prefix and the wiki
 *    confirms a continuous effect ("creatures cannot have Defender while
 *    Sparkstone Elemental is in play ... gain it after Sparkstone leaves
 *    play"). Static abilities can only grant, never remove, so it is emulated
 *    with watchers: on its own entry and on every later entry
 *    (anyCreatureEnterPlay) Defender is stripped via negateKeyword, and the
 *    stripped uids are tracked per Sparkstone so a destroyed/wasReplaced
 *    trigger can hand Defender back when it leaves. Corners: (a) Defender from
 *    static auras cannot be stripped (negateKeyword cannot touch
 *    staticKeywords); (b) Defender granted to a creature already in play while
 *    Sparkstone is in play sticks (no grant broadcast to watch); (c) banish /
 *    bounce removal does not trigger the restore; (d) with two Sparkstones in
 *    play, the first to leave restores Defender even though the second is
 *    still around.
 *  - Torrent Valkyrie: puts an Ice Torrent (a Set 2.2 card — load
 *    cards_Set_2.2.json) into hand. Ice Torrent is not scripted in the set2
 *    files, so it is scripted below as a support card (spirit-torrent
 *    convention from set5-nekrium.ts); its Free at L2/L3 is inherent.
 *  - Windspark Elemental: UNIMPLEMENTED. "When an enemy creature takes
 *    non-battle damage" needs a board-wide damage broadcast; damage only
 *    fires triggers on the source (dealtDamageToCreature) and the target
 *    (damaged), and Windspark is normally neither. Registered so the defId
 *    resolves; it currently has no abilities. TODO: needs e.g. an
 *    "anyCreatureDamaged" broadcast carrying evt.battle.
 *  - Dragonwake: "Search your deck for a Dragon" is a random pick from the
 *    matching deck cards (Aeromind Squadron convention — there is no
 *    deck-search choice kind); the original stays in the deck and the copy is
 *    Spawned at the deck card's level. The L1/L2 "At the end of your turn,
 *    destroy this" reuses tempys:set2-binben-expire from set2-tempys.ts
 *    (identical rules text, Glaceus/frozen-solid precedent).
 *  - Primordial Invoker: the N damage is split one point at a time, each point
 *    hitting a random target among the enemy creatures and the enemy player.
 *    Creatures with fatal damage stay in their lane until the batch ends, so
 *    they remain eligible for later points (overkill is possible).
 *  - Zarox, the Raging: the Allied Nekrium growth is gated continuously on a
 *    Nekrium card in hand (hasFactionInHand, Spite Hydra convention) and fires
 *    on any creature's destruction, enemy or friendly.
 */
import { registerCard, registerPlayerEffect } from "./registry.js";
import {
  addPlayerEffect, buffCreature, dealCreatureDamage, dealPlayerDamage, grantKeyword, moveCreature,
  negateKeyword, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import { typeAt } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

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

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

function hasFactionInHand(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

// ============================================================
// Creatures
// ============================================================

// --- Ash Maiden (friendly battle damage to a player -> that creature +N/+N) ---
registerCard({
  defId: "ash-maiden",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "maiden-self",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
        {
          id: "maiden-other",
          trigger: "friendlyBattleDamageToPlayer" as const,
          resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
            const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
            if (c) buffCreature(ctx.game, ctx.events, c, n, n);
          },
        },
      ],
    }]),
  ),
});

// --- Blizzard Shaman (Forge: move a random other friendly creature to a
//     random friendly open space) ---
registerCard({
  defId: "blizzard-shaman",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-flurry",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const others = pl.lanes.filter((c): c is CreatureState => !!c && c.uid !== self.uid);
          const open = pl.lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
          if (!others.length || !open.length) return;
          moveCreature(ctx.game, ctx.events, ctx.rng.pick(others), ctx.rng.pick(open));
        },
      }],
    }]),
  ),
});

// --- Leyline Tyrant (Ambush: enemy heal; engine handles spawn + discard/level) ---
registerCard({
  defId: "leyline-tyrant",
  ambush: { watch: "enemyHeal" },
});

// --- Primordial Invoker (Set 5.1; Forge: N damage split one point at a time
//     at random between enemy creatures and the enemy player — see header) ---
registerCard({
  defId: "primordial-invoker",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-scatter",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = opposing(self.owner);
          const targets: (CreatureState | null)[] = [
            ...ctx.game.state.players[foe].lanes.filter((c): c is CreatureState => !!c),
            null, // the enemy player
          ];
          for (let i = 0; i < n; i++) {
            const t = ctx.rng.pick(targets);
            if (t) dealCreatureDamage(ctx.game, ctx.events, t, 1, self);
            else dealPlayerDamage(ctx.game, ctx.events, foe, 1, self);
          }
        },
      }],
    }]),
  ),
});

// --- Smolderscale Dragon (end of your turn: N damage to each enemy creature;
//     Defender / Mobility 2 are inherent from the data) ---
registerCard({
  defId: "smolderscale-dragon",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "end-burn",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
          }
        },
      }],
    }]),
  ),
});

// --- Sparkstone Elemental (continuous: creatures cannot have Defender while
//     it is in play — watcher emulation with tracked restore, see header) ---
const sparkNegated = new WeakMap<Game, Map<number, Set<number>>>(); // spark uid -> stripped uids

function sparkStrip(ctx: Ctx, self: CreatureState, c: CreatureState): void {
  const had = c.keywords.some((k) => k.keyword === "Defender")
    || c.tempKeywords.some((k) => k.keyword === "Defender");
  if (!had) return; // static-aura Defender cannot be stripped (see header)
  negateKeyword(ctx.events, c, "Defender");
  let m = sparkNegated.get(ctx.game);
  if (!m) { m = new Map(); sparkNegated.set(ctx.game, m); }
  let set = m.get(self.uid);
  if (!set) { set = new Set(); m.set(self.uid, set); }
  set.add(c.uid);
}

function sparkRestore(ctx: Ctx, self: CreatureState): void {
  const m = sparkNegated.get(ctx.game);
  const set = m?.get(self.uid);
  if (!set) return;
  for (const uid of set) {
    const c = findCreature(ctx.game.state, uid);
    if (c && !hasKeyword(c, "Defender")) grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
  }
  m!.delete(self.uid);
}

registerCard({
  defId: "sparkstone-elemental",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "aura-strip-board",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of allCreatures(ctx.game.state)) sparkStrip(ctx, self, c);
          },
        },
        {
          id: "aura-strip-entry",
          trigger: "anyCreatureEnterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
            if (c) sparkStrip(ctx, self, c);
          },
        },
        {
          id: "aura-restore",
          trigger: "destroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => sparkRestore(ctx, self),
        },
        {
          id: "aura-restore-replace",
          trigger: "wasReplaced" as const,
          resolve: (ctx: Ctx, self: CreatureState) => sparkRestore(ctx, self),
        },
      ],
    }]),
  ),
});

// --- Torrent Valkyrie (L2/L3 Forge: put a level 2/3 Ice Torrent into hand) ---
registerCard({
  defId: "torrent-valkyrie",
  levels: {
    1: {}, // vanilla — explicit so the registry fallback never hands L1 the L3 script
    2: {
      abilities: [{
        id: "forge-ice-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "ice-torrent", level: 2, owner: self.owner,
          });
        },
      }],
    },
    3: {
      abilities: [{
        id: "forge-ice-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "ice-torrent", level: 3, owner: self.owner,
          });
        },
      }],
    },
  },
});

// --- Windspark Elemental: UNIMPLEMENTED — no non-battle-damage broadcast
//     exists for third-party watchers (see header note). TODO. ---
registerCard({ defId: "windspark-elemental" });

// --- Zarox, the Raging (battle damage to a player on your turn -> you may
//     deal that much to an enemy creature; Allied Nekrium: any destruction
//     gives it +N attack — see header) ---
registerCard({
  defId: "zarox-the-raging",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "raging-strike",
          trigger: "battleDamageToPlayer" as const,
          targeted: true,
          // "on your turn" excludes battle damage dealt during the enemy's battle
          condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
          prompt: (game: Game, self: CreatureState, evt: TriggerPayload) => req(
            `You may deal ${evt.amount ?? 0} damage to an enemy creature`,
            "enemyCreature",
            enemyUids(game, self.owner),
            true,
          ),
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c && c.owner !== self.owner) dealCreatureDamage(ctx.game, ctx.events, c, evt.amount ?? 0, self);
          },
        },
        {
          id: "allied-nekrium",
          trigger: "anyCreatureDestroyed" as const,
          condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Nekrium"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, 0);
          },
        },
      ],
    }]),
  ),
});

// ============================================================
// Spells (+ Ice Torrent support card for Torrent Valkyrie)
// ============================================================

// --- Draconic Echoes: deferred end-of-turn burn via a player-level effect.
//     "1 to N damage" is a uniform rng roll (Stinging Invocation convention);
//     L1/L2 attach the effect with 2 applications, L3 permanently. ---
for (const [ref, max] of [["tempys:draconic-echoes-1", 10], ["tempys:draconic-echoes-2", 20]] as const) {
  registerPlayerEffect(ref, {
    trigger: "turnEnd",
    condition: (game: Game, player: PlayerId) => game.state.active === player,
    resolve: (ctx: Ctx, player: PlayerId) => {
      dealPlayerDamage(ctx.game, ctx.events, opposing(player), ctx.rng.int(max) + 1);
    },
  });
}
registerCard({
  defId: "draconic-echoes",
  spell: Object.fromEntries(
    ([[1, 1, 2], [2, 2, 2], [3, 2, null]] as const).map(([lvl, tier, remaining]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        addPlayerEffect(ctx.game, ctx.events, player, `tempys:draconic-echoes-${tier}`, remaining);
      },
    }]),
  ),
});

// --- Everflame Aura (N damage to an enemy creature, or Mobility M to a
//     friendly creature — single choice, mode by target owner) ---
registerCard({
  defId: "everflame-aura",
  spell: Object.fromEntries(
    ([[1, 7, 1], [2, 8, 2], [3, 9, 3]] as const).map(([lvl, n, mob]) => [lvl, {
      prompt: (game: Game) => req(
        `Deal ${n} damage to an enemy creature, or give a friendly creature Mobility ${mob}`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        if (c.owner === player) grantKeyword(ctx.events, c, { keyword: "Mobility", value: mob });
        else dealCreatureDamage(ctx.game, ctx.events, c, n);
      },
    }]),
  ),
});

// --- Flame Jet (N damage to a creature, +3 more at the listed Rank or higher) ---
registerCard({
  defId: "flame-jet",
  spell: Object.fromEntries(
    ([[1, 3, 2], [2, 9, 3], [3, 15, 4]] as const).map(([lvl, n, rankReq]) => [lvl, {
      prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        const extra = ctx.game.state.players[player].rank >= rankReq ? 3 : 0;
        dealCreatureDamage(ctx.game, ctx.events, c, n + extra);
      },
    }]),
  ),
});

// --- Shatterbolt (Negate Armor from a creature or player this turn — armorUsed
//     saturation, see header — then N damage to that creature or player) ---
registerCard({
  defId: "shatterbolt",
  spell: Object.fromEntries(
    ([[1, 5], [2, 9], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: `Negate Armor from a creature or player this turn, then deal ${n} damage to it`,
        options: [-1, -2, ...boardUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const t = choice?.targetUid;
        if (t === undefined) return;
        if (t === -1 || t === -2) {
          const pid = (t === -1 ? 0 : 1) as PlayerId;
          ctx.game.state.players[pid].armorUsed = 999; // Armor negated this turn (see header)
          dealPlayerDamage(ctx.game, ctx.events, pid, n);
        } else {
          const c = findCreature(ctx.game.state, t);
          if (!c) return;
          c.armorUsed = 999; // Armor negated this turn (see header)
          ctx.events.push({ type: "negateKeyword", player: c.owner, lane: c.lane, keyword: "Armor" });
          dealCreatureDamage(ctx.game, ctx.events, c, n);
        }
      },
    }]),
  ),
});

// --- Dragonwake (Set 5.2; Spawn a copy of a random Dragon from your deck —
//     see header; L1 caps at level 2; L1/L2 copies die at end of your turn) ---
function dragonwake(levelCap: number, expires: boolean) {
  return {
    resolve: (ctx: Ctx, player: PlayerId) => {
      const pl = ctx.game.state.players[player];
      const pool = pl.deck.filter((inst) =>
        inst.level <= levelCap
        && hasSubtype(ctx.game, inst.defId, "Dragon")
        && typeAt(ctx.game.state.cards[inst.defId]!, inst.level) === "Creature");
      if (!pool.length) return;
      const pick = ctx.rng.pick(pool);
      const copy = spawnCreature(ctx.game, ctx.events, player, pick.defId, pick.level, {});
      if (!copy) return; // no open space
      grantKeyword(ctx.events, copy, { keyword: "Aggressive", value: 0 });
      if (expires) copy.grantedAbilities.push("tempys:set2-binben-expire");
    },
  };
}
registerCard({
  defId: "dragonwake",
  spell: {
    1: dragonwake(2, true),
    2: dragonwake(99, true),
    3: dragonwake(99, false),
  },
});

// --- Ice Torrent (Set 2.2 support card for Torrent Valkyrie — see header):
//     N damage to the enemy player; Free at L2/L3 is inherent from the data. ---
registerCard({
  defId: "ice-torrent",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), n);
      },
    }]),
  ),
});
