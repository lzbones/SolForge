/**
 * Set 7 (Raiders Unchained) + 7.1 + 7.2 + 7.3 — Uterra card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set7-nekrium.ts / set7-tempys.ts):
 *  - Raid (new Set 7 keyword): turnEnd + condition (own turn ending, 3+
 *    friendly creatures hasBattled) per CARD_SCRIPTING.md — the raidReady
 *    helper is the set7-tempys.ts convention. hasBattled is only reset at the
 *    flagged creature's own turn start, so it still reads true at end of turn.
 *  - Player Poison grants (Hive Empress, Bottomless Puncture) are silent:
 *    players[p].poison += n with no GameEvent (set5/set6-uterra convention).
 *    The Poison keyword itself stacks — keywordValue sums entries, so repeated
 *    grants accumulate (set2-uterra.ts "double the Poison" note).
 *  - Demara's Pitguard: "The opposing creature has Poison N" is continuous, so
 *    it is a static keyword grant targeting the enemy creature in the
 *    Pitguard's lane. The tick reads staticKeywords at the POISONED creature's
 *    controller's turn start (game.ts startOfTurn), i.e. the enemy's turn —
 *    matching the card. Statics recompute on the legalActions/batch path, so a
 *    creature moving into/out of the lane picks up / drops the Poison.
 *  - Living Hive L3: "+attack and +health equal to the enemy player's Poison"
 *    is continuous — a self-targeted static. The Killer Bee Spawn comes from
 *    "damaged", which is a DEATHBLOW trigger, so a lethal hit still Spawns.
 *  - Lightbringer Council: "a friendly Uterra creature" includes the Council
 *    itself, so it listens to both battleDamageToPlayer (its own hits) and
 *    friendlyBattleDamageToPlayer (allies' hits) — Rageborn Hellion
 *    convention (set1-tempys.ts). The ally trigger filters on Uterra faction.
 *  - Lorus, the Unrivaled L1/L2: the Raid replace is a fresh copy at the next
 *    level in the same space (Othra convention); the old card hits the
 *    discard (engine replace semantics).
 *  - Relentless Wanderers: "Spawn a Relentless Wanderers" is a same-level copy
 *    (Undying Legacy convention) in a random open space. It enters during the
 *    turnEnd batch, after Raid triggers were collected, so the copy does not
 *    chain its own Raid the turn it appears.
 *  - Scatterspore Tiller: the Seedling/Sapling/Treefolk tokens have scraped
 *    "*" stats, so overrideStats (set4-uterra convention).
 *  - Ramble, Eternal Witness: "shuffle into your deck" is a random-position
 *    deck insert (no deck-shuffle primitive exists; first script to add a
 *    card to a deck). L3 "Spawn a random creature from your deck" Spawns a
 *    COPY at the deck card's level — the card stays in the deck (Lichmane
 *    discard-pool convention: Spawn = copy). Fizzles on a creature-less deck.
 *  - Wegu's Embrace: the "this turn" battle-damage drain is a granted ability
 *    (uterra:wegus-drain) plus a second granted turnEnd ability
 *    (uterra:wegus-expire) that removes both refs at the next end of turn —
 *    Ebonskull self-removal convention. The stat buff is permanent.
 *  - Leyline Vermin: UNIMPLEMENTED. Its Ambush watch ("an enemy creature with
 *    Poison is destroyed on the enemy player's turn") is not one of the four
 *    engine-supported watches (thirdEnemyCard / enemyMove / enemyUnForgedEntry
 *    / enemyHeal — triggers.ts, hardcoded in game.ts checkAmbush). Needs a new
 *    watch (e.g. "enemyPoisonDeath") plus a per-turn flag set from deathCheck
 *    for poisoned enemy deaths. Registered so the defId resolves; the card is
 *    a vanilla 6/3, 12/5, 18/8 in play. TODO.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, grantKeyword, healPlayer, spawnCreature,
} from "../effects.js";
import {
  findCreature, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import { isCreature } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

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

/** Raid: own turn ending and 3+ friendly creatures initiated battle this turn. */
function raidReady(game: Game, self: CreatureState): boolean {
  return game.state.active === self.owner
    && game.state.players[self.owner].lanes.filter((c) => !!c && c.hasBattled).length >= 3;
}

// ---------- granted abilities ----------

// Wegu's Embrace: "When this creature deals battle damage to the enemy player
// this turn, you gain that much health." Level-independent (heals the dealt
// amount); removed at the next end of turn by uterra:wegus-expire.
registerGranted("uterra:wegus-drain", {
  id: "uterra:wegus-drain",
  trigger: "battleDamageToPlayer",
  resolve(ctx, self, evt) {
    if (evt.targetPlayer === undefined || evt.targetPlayer === self.owner) return;
    healPlayer(ctx.game, ctx.events, self.owner, evt.amount ?? 0);
  },
});

// Wegu's Embrace: "this turn" expiry — strips the drain (and itself) at the
// first end of turn after the grant (the spell is only playable on your turn,
// so that end of turn is yours).
registerGranted("uterra:wegus-expire", {
  id: "uterra:wegus-expire",
  trigger: "turnEnd",
  resolve(_ctx, self) {
    self.grantedAbilities = self.grantedAbilities
      .filter((r) => r !== "uterra:wegus-drain" && r !== "uterra:wegus-expire");
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Demara's Pitguard: the creature opposing it has Poison N (continuous
//     static keyword grant — see header). ---
registerCard({
  defId: "demaras-pitguard",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "opposing-poison",
        apply: (_g: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.owner !== self.owner && target.lane === self.lane) {
            out.keywords.push({ keyword: "Poison", value: n });
          }
        },
      }],
    }]),
  ),
});

// --- Harbinger of Spring: when another friendly creature enters play un-
//     Forged, Harbinger gets +N/+N. ---
registerCard({
  defId: "harbinger-of-spring",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "unforged-growth",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceUid !== self.uid && evt.fromHand !== true,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Herd Mother: Raid — Herd Mother gets +N/+N. ---
registerCard({
  defId: "herd-mother",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "raid-growth",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Hive Empress: Raid — give the enemy player Poison N (silent — see
//     header). ---
registerCard({
  defId: "hive-empress",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "raid-venom",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[opposing(self.owner)].poison += n; // silent: no GameEvent
        },
      }],
    }]),
  ),
});

// --- Lightbringer Council: when a friendly Uterra creature (itself included —
//     see header) deals battle damage to the enemy player, you gain N health. ---
function councilHeal(n: number): (ctx: Ctx, self: CreatureState) => void {
  return (ctx, self) => healPlayer(ctx.game, ctx.events, self.owner, n);
}
registerCard({
  defId: "lightbringer-council",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "council-self",
          trigger: "battleDamageToPlayer" as const,
          resolve: councilHeal(n),
        },
        {
          id: "council-ally",
          trigger: "friendlyBattleDamageToPlayer" as const,
          condition: (game: Game, _self: CreatureState, evt: TriggerPayload) =>
            !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Uterra",
          resolve: councilHeal(n),
        },
      ],
    }]),
  ),
});

// --- Living Hive: when dealt damage, Spawn a Killer Bee at the Hive's level.
//     L3: also +attack/+health equal to the enemy player's Poison (self static). ---
registerCard({
  defId: "living-hive",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "hive-defend",
        trigger: "damaged" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "killer-bee", self.level, { lane: "random" });
        },
      }],
      ...(lvl === 3
        ? {
          statics: [{
            id: "poison-fueled",
            apply: (game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
              if (target.uid !== self.uid) return;
              const poison = game.state.players[opposing(self.owner)].poison;
              out.attack += poison;
              out.health += poison;
            },
          }],
        }
        : {}),
    }]),
  ),
});

// --- Lorus, the Unrivaled: Raid — L1/L2 replace this with the next-level
//     Lorus (fresh copy, old one discarded — see header); L3 each friendly
//     creature gets +3/+3 (itself included: "each friendly creature"). ---
registerCard({
  defId: "lorus-the-unrivaled",
  levels: {
    ...Object.fromEntries(
      ([1, 2] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "raid-evolve",
          trigger: "turnEnd" as const,
          condition: (game: Game, self: CreatureState) => raidReady(game, self),
          resolve: (ctx: Ctx, self: CreatureState) => {
            spawnCreature(ctx.game, ctx.events, self.owner, "lorus-the-unrivaled", self.level + 1,
              { lane: self.lane, replace: true });
          },
        }],
      }]),
    ),
    3: {
      abilities: [{
        id: "raid-rally",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, 3, 3);
          }
        },
      }],
    },
  },
});

// --- Relentless Wanderers: Raid — Spawn a same-level copy in a random open
//     space (no chain the turn it appears — see header). ---
registerCard({
  defId: "relentless-wanderers",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "raid-split",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "relentless-wanderers", self.level,
            { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Scatterspore Tiller: Activate — Spawn a 1/1 Seedling / 3/3 Sapling /
//     5/5 Treefolk (overrideStats: scraped token stats are "*" — see header). ---
registerCard({
  defId: "scatterspore-tiller",
  levels: Object.fromEntries(
    ([[1, "seedling", 1], [2, "sapling", 3], [3, "treefolk", 5]] as const).map(([lvl, token, n]) => [lvl, {
      activates: [{
        id: "till",
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Leyline Vermin: UNIMPLEMENTED Ambush (watch type unsupported — see
//     header). Registered so the defId resolves; vanilla stats in play. TODO. ---
registerCard({ defId: "leyline-vermin" });

// --- Shardplate Toxoid: Forge — give an enemy creature Poison N; at the end
//     of the enemy player's turn, each enemy creature gets Poison M (stacks). ---
registerCard({
  defId: "shardplate-toxoid",
  levels: Object.fromEntries(
    ([[1, 2, 1], [2, 4, 2], [3, 10, 5]] as const).map(([lvl, forge, tick]) => [lvl, {
      abilities: [
        {
          id: "forge-venom",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => req(
            `Give an enemy creature Poison ${forge}`,
            "enemyCreature",
            enemyUids(game, self.owner),
          ),
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c && c.owner !== self.owner) grantKeyword(ctx.events, c, { keyword: "Poison", value: forge });
          },
        },
        {
          id: "enemy-turn-venom",
          trigger: "turnEnd" as const,
          condition: (game: Game, self: CreatureState) => game.state.active !== self.owner,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
              if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: tick });
            }
          },
        },
      ],
    }]),
  ),
});

// --- Primeval Ancient: at the end of your turn, you gain N health. Forge —
//     if there are no enemy creatures, Spawn a copy of this (un-Forged, so the
//     copy does not chain its own Forge). ---
registerCard({
  defId: "primeval-ancient",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "endure",
          trigger: "turnEnd" as const,
          condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
          resolve: (ctx: Ctx, self: CreatureState) => {
            healPlayer(ctx.game, ctx.events, self.owner, n);
          },
        },
        {
          id: "forge-copy",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) =>
            game.state.players[opposing(self.owner)].lanes.every((c) => !c),
          resolve: (ctx: Ctx, self: CreatureState) => {
            spawnCreature(ctx.game, ctx.events, self.owner, "primeval-ancient", self.level,
              { lane: "random" });
          },
        },
      ],
    }]),
  ),
});

// --- Ramble, Eternal Witness: Forge — L1/L2 shuffle the next-level Ramble
//     into your deck (random-position insert — see header); L3 Spawn a random
//     creature from your deck (a copy — see header). ---
registerCard({
  defId: "ramble-eternal-witness",
  levels: {
    ...Object.fromEntries(
      ([1, 2] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "forge-shuffle",
          trigger: "enterFromHand" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const pl = ctx.game.state.players[self.owner];
            const inst = {
              uid: ctx.game.state.nextUid++, defId: "ramble-eternal-witness",
              level: self.level + 1, owner: self.owner,
            };
            pl.deck.splice(ctx.rng.int(pl.deck.length + 1), 0, inst);
          },
        }],
      }]),
    ),
    3: {
      abilities: [{
        id: "forge-spawn-deck",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pool = ctx.game.state.players[self.owner].deck
            .filter((inst) => {
              const def = ctx.game.state.cards[inst.defId];
              return !!def && isCreature(def);
            });
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
        },
      }],
    },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Ether Wolves (Overload inherent): Spawn two level 1 Ether Wolves (5/6
//     tokens from Set 7 data). ---
registerCard({
  defId: "ether-wolves",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        spawnCreature(ctx.game, ctx.events, player, "ether-wolf", 1, { lane: "random" });
        spawnCreature(ctx.game, ctx.events, player, "ether-wolf", 1, { lane: "random" });
      },
    },
  },
});

// --- Victory Rush: give a friendly creature +N/+N; an extra +N/+N if three
//     or more friendly creatures initiated battle this turn (hasBattled flags —
//     Crypt Wail convention, own side). ---
registerCard({
  defId: "victory-rush",
  spell: Object.fromEntries(
    ([[1, 4], [2, 5], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature +${n} attack and +${n} health`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        const battled = ctx.game.state.players[player].lanes.filter((x) => !!x && x.hasBattled).length;
        if (battled >= 3) buffCreature(ctx.game, ctx.events, c, n, n);
      },
    }]),
  ),
});

// --- Bottomless Puncture: give an enemy creature Poison N; if it is Tempys,
//     give the enemy player Poison M as well (player grant is silent — header). ---
registerCard({
  defId: "bottomless-puncture",
  spell: Object.fromEntries(
    ([[1, 3, 1], [2, 6, 2], [3, 9, 3]] as const).map(([lvl, n, playerN]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give an enemy creature Poison ${n}`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        if (ctx.game.state.cards[c.defId]?.faction === "Tempys") {
          ctx.game.state.players[opposing(player)].poison += playerN; // silent: no GameEvent
        }
      },
    }]),
  ),
});

// --- Wegu's Embrace: give a friendly creature +N/+N and, this turn, "when it
//     deals battle damage to the enemy player, you gain that much health"
//     (granted abilities — see the registry above and the header). ---
registerCard({
  defId: "wegus-embrace",
  spell: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature +${n} attack and +${n} health and "When this creature deals battle damage to the enemy player this turn, you gain that much health"`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        c.grantedAbilities.push("uterra:wegus-drain", "uterra:wegus-expire");
      },
    }]),
  ),
});

// --- Leyline Vermin: Ambush on enemy poison-creature death during their turn ---
// (engine watch "enemyPoisonDeath": deathCheck flags poisoned deaths on the
// controller's turn; spawn + discard-and-level are engine-handled)
registerCard({
  defId: "leyline-vermin",
  ambush: { watch: "enemyPoisonDeath" },
});
