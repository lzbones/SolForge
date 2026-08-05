/**
 * Set 4 (Imprisoned Heralds) + 4.1 + 4.2 — Nekrium card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set3-nekrium.ts):
 *  - Soulscourge Grimgaunt / Tarsus Necrolord ("destroyed this turn"): the
 *    engine keeps no per-turn death log, so deaths are approximated by a
 *    per-game tracker (see deathsThisTurn) that counts the growth of the
 *    discard piles' creature cards between Forge resolutions. Corners:
 *    (a) deaths from turns in which no Soulscourge/Tarsus Forge resolved are
 *    counted into the next observation; (b) creature level-up copies and
 *    discard-to-level creature cards pollute the count (the level-up copy of
 *    the Forged card itself is excluded — it is always the top of the
 *    discard); (c) same-batch kills are missed, because destroyed creatures
 *    are only marked dead and reach the discard at batch end.
 *  - Portal Shade ("a random creature that was destroyed this game") uses the
 *    Lyria/Varna's Pact pool: creature-type, non-Token cards in either
 *    player's discard pile (leveled-up and discard-to-level copies pollute
 *    the pool). Note the rank-up reshuffle empties the ranking player's
 *    discard before rankGained fires, so the pool is usually the opponent's
 *    discard.
 *  - Necroflay's "you may play an additional Necroflay this turn" grants an
 *    unrestricted extra play (playsLeft += 1) — legalActions cannot gate the
 *    bonus play by card (Anatomize / Xrath's Will convention).
 *  - Crypt Slime's Oozeling goes "into this space"; if the space is occupied
 *    at resolution (another respawn took it), nothing happens — the Grimgaunt
 *    Doomrider convention from set3-nekrium.ts.
 *  - Soulreap / Fell Strider / Progeny of Xith Spawn into a random open
 *    space (Suruzal precedent); the copy is spawned while the destroyed
 *    creature is only marked dead, but it lands on the caster's own side.
 *  - Abyssal Brute's "enters a side space" covers both entering play and
 *    moving into lane 0 or 4, for itself and other friendly creatures.
 *  - Scythe of Chiron is a spell at L1/L2 and a creature at L3 (per-level
 *    types via typeAt); the L3 creature is "Chiron, Herald of Torment" but
 *    keeps the scythe-of-chiron defId.
 *  - Spite Hydra's Allied Tempys Activate is gated continuously on a Tempys
 *    card in hand (Epoch Hawk convention), not just on entry.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, destroyCreature, getStats, grantKeyword,
  healPlayer, spawnCreature,
} from "../effects.js";
import {
  findCreature, isDead, opposing,
  type CardInstance, type CreatureState, type PlayerId,
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
  for (const side of [0, 1] as const) {
    for (const c of game.state.players[side].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  }
  return out;
}

function hasFactionInHand(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

/** Assault: the opposing space of this creature's lane is empty. */
function unopposed(game: Game, self: CreatureState): boolean {
  return !game.state.players[opposing(self.owner)].lanes[self.lane];
}

/** Creature cards that left play this game (Portal Shade's pool — see header note). */
function destroyedPool(game: Game): CardInstance[] {
  const out: CardInstance[] = [];
  for (const p of [0, 1] as const) {
    for (const inst of game.state.players[p].discard) {
      const def = game.state.cards[inst.defId];
      if (def && isCreature(def) && def.rarity !== "Token") out.push(inst);
    }
  }
  return out;
}

// ---------- "destroyed this turn" tracker (see header note) ----------

interface DeathTrack { base: [number, number] }
const deathTracks = new WeakMap<Game, DeathTrack>();

function creatureDiscards(game: Game): [number, number] {
  const out: [number, number] = [0, 0];
  for (const p of [0, 1] as const) {
    for (const inst of game.state.players[p].discard) {
      const def = game.state.cards[inst.defId];
      if (def && isCreature(def)) out[p]++;
    }
  }
  return out;
}

/**
 * Approximate count of creatures destroyed "this turn", per player (see
 * header note). `self` is the Forging creature: its own level-up copy, pushed
 * to the discard right before the Forge resolves, is excluded.
 */
function deathsThisTurn(game: Game, self: CreatureState): [number, number] {
  const cur = creatureDiscards(game);
  const rec = deathTracks.get(game) ?? { base: [0, 0] as [number, number] };
  const delta: [number, number] = [
    Math.max(0, cur[0] - rec.base[0]),
    Math.max(0, cur[1] - rec.base[1]),
  ];
  const top = game.state.players[self.owner].discard.at(-1);
  if (top && top.defId === self.defId && top.level === self.level + 1) {
    delta[self.owner] = Math.max(0, delta[self.owner] - 1);
  }
  rec.base = cur;
  deathTracks.set(game, rec);
  return delta;
}

// ============================================================
// Creatures
// ============================================================

// --- Abyssal Brute: when it or another friendly creature enters a side space
//     (lanes 0/4, by play or by move), that creature gets +N/+N and Regenerate N. ---
const isSide = (lane: number | undefined): boolean => lane === 0 || lane === 4;

function bruteAbilities(n: number): Ability[] {
  const buffTarget = (ctx: Ctx, uid: number | undefined): void => {
    if (uid === undefined) return;
    const c = findCreature(ctx.game.state, uid);
    if (!c || isDead(c)) return;
    buffCreature(ctx.game, ctx.events, c, n, n);
    grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
  };
  return [
    {
      id: "side-entry-self",
      trigger: "enterPlay" as const,
      condition: (_g: Game, self: CreatureState) => isSide(self.lane),
      resolve: (ctx: Ctx, self: CreatureState) => buffTarget(ctx, self.uid),
    },
    {
      id: "side-entry-other",
      trigger: "anyCreatureEnterPlay" as const,
      condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
        evt.sourceOwner === self.owner && evt.sourceUid !== self.uid && isSide(evt.lane),
      resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => buffTarget(ctx, evt.sourceUid),
    },
    {
      id: "side-move-self",
      trigger: "moved" as const,
      condition: (_g: Game, _s: CreatureState, evt: TriggerPayload) => isSide(evt.lane),
      resolve: (ctx: Ctx, self: CreatureState) => buffTarget(ctx, self.uid),
    },
    {
      id: "side-move-other",
      trigger: "friendlyCreatureMoved" as const,
      condition: (_g: Game, _s: CreatureState, evt: TriggerPayload) => isSide(evt.lane),
      resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => buffTarget(ctx, evt.sourceUid),
    },
  ];
}
registerCard({
  defId: "abyssal-brute",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, { abilities: bruteAbilities(lvl) }]),
  ),
});

// --- Calamity Fiend: Assault — give an enemy creature -N/-N. ---
registerCard({
  defId: "calamity-fiend",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "assault-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => unopposed(game, self),
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

// --- Crypt Slime: Vengeance — put a 1/1 Oozeling into this space. ---
registerCard({
  defId: "crypt-slime",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-oozeling",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          spawnCreature(ctx.game, ctx.events, self.owner, "oozeling-green", 1,
            { lane: evt.lane, overrideStats: { attack: 1, health: 1 } });
        },
      }],
    }]),
  ),
});

// --- Dirge Banshee: Forge/Flank — if opposed, the opposing creature gets -N
//     attack and this gets +N attack. ---
function dirgeDrain(trigger: "enterFromHand" | "moved", n: number): Ability {
  return {
    id: trigger === "enterFromHand" ? "forge-drain" : "flank-drain",
    trigger,
    resolve: (ctx: Ctx, self: CreatureState) => {
      const opp = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
      if (!opp) return;
      buffCreature(ctx.game, ctx.events, opp, -n, 0);
      buffCreature(ctx.game, ctx.events, self, n, 0);
    },
  };
}
registerCard({
  defId: "dirge-banshee",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [dirgeDrain("enterFromHand", n), dirgeDrain("moved", n)],
    }]),
  ),
});

// --- Fell Strider: Vengeance — Spawn an N/M Zombie. ---
registerCard({
  defId: "fell-strider",
  levels: Object.fromEntries(
    ([[1, 4, 3], [2, 8, 6], [3, 10, 9]] as const).map(([lvl, a, h]) => [lvl, {
      abilities: [{
        id: "vengeance-zombie",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "zombie", 1,
            { lane: "random", overrideStats: { attack: a, health: h } });
        },
      }],
    }]),
  ),
});

// --- Misery Demon: Assault — deal N damage to the enemy player and gain N health. ---
registerCard({
  defId: "misery-demon",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "assault-drain",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => unopposed(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n);
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Portal Shade: when you gain a Rank, Spawn a random creature that was
//     destroyed this game (discard-pool approximation — see header note). ---
registerCard({
  defId: "portal-shade",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "rank-portal",
        trigger: "rankGained" as const,
        // rankGained fires during the ranking player's endTurn, while they are still active
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pool = destroyedPool(ctx.game);
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Sorrow Maiden: Activate — destroy an enemy creature with <=cap attack. ---
registerCard({
  defId: "sorrow-maiden",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 14]] as const).map(([lvl, cap]) => [lvl, {
      activates: [{
        id: "mourn",
        condition: (game: Game, self: CreatureState) =>
          enemyUids(game, self.owner, (c) => getStats(game, c).attack <= cap).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          `Destroy an enemy creature with ${cap} or less attack`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => getStats(game, c).attack <= cap),
        ),
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Soulscourge Grimgaunt: Forge — +N/+N for each creature destroyed this
//     turn (tracker approximation — see header note). ---
registerCard({
  defId: "soulscourge-grimgaunt",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-feed",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const [d0, d1] = deathsThisTurn(ctx.game, self);
          const total = d0 + d1;
          if (total > 0) buffCreature(ctx.game, ctx.events, self, n * total, n * total);
        },
      }],
    }]),
  ),
});

// --- Spite Hydra: +N/+N when it deals battle damage to a creature; Allied
//     Tempys — Activate: deal N damage to another creature, +N/+N. ---
registerCard({
  defId: "spite-hydra",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "spite-grow",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, lvl, lvl);
        },
      }],
      activates: [{
        id: "allied-sting",
        condition: (game: Game, self: CreatureState) =>
          hasFactionInHand(game, self.owner, "Tempys")
          && boardUids(game, (c) => c.uid !== self.uid).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          `Deal ${lvl} damage to another creature`,
          "anyCreature",
          boardUids(game, (c) => c.uid !== self.uid),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.uid === self.uid) return;
          dealCreatureDamage(ctx.game, ctx.events, c, lvl, self);
          buffCreature(ctx.game, ctx.events, self, lvl, lvl);
        },
      }],
    }]),
  ),
});

// --- Tarsus Necrolord: Forge — Spawn an N/N Zombie for each friendly creature
//     destroyed this turn (tracker approximation — see header note); when a
//     friendly Zombie enters the field, +M/+M. ---
registerCard({
  defId: "tarsus-necrolord",
  levels: Object.fromEntries(
    ([[1, 3, 1], [2, 5, 2], [3, 9, 4]] as const).map(([lvl, z, m]) => [lvl, {
      abilities: [
        {
          id: "forge-horde",
          trigger: "enterFromHand" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const deaths = deathsThisTurn(ctx.game, self)[self.owner];
            for (let i = 0; i < deaths; i++) {
              spawnCreature(ctx.game, ctx.events, self.owner, "zombie", 1,
                { lane: "random", overrideStats: { attack: z, health: z } });
            }
          },
        },
        {
          id: "zombie-entry-buff",
          trigger: "anyCreatureEnterPlay" as const,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner
            && evt.sourceUid !== self.uid
            && !!evt.sourceDefId
            && hasSubtype(game, evt.sourceDefId, "Zombie"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, m, m);
          },
        },
      ],
    }]),
  ),
});

// --- Duskmaw, Twilight Drake: Solbind Tendrils of Twilight (Mobility 1 is
//     inherent from the card data; no scripted abilities). ---
registerCard({
  defId: "duskmaw-twilight-drake",
  solbind: ["tendrils-of-twilight"],
});

// --- Progeny of Xith: Vengeance — Spawn a level+1 Progeny of Xith. ---
registerCard({
  defId: "progeny-of-xith",
  levels: {
    ...Object.fromEntries(
      ([1, 2] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "vengeance-progeny",
          trigger: "destroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            spawnCreature(ctx.game, ctx.events, self.owner, "progeny-of-xith", self.level + 1,
              { lane: "random" });
          },
        }],
      }]),
    ),
    3: {}, // vanilla 6/6
  },
});

// ============================================================
// Spells (+ Scythe of Chiron: spell at L1/L2, creature at L3)
// ============================================================

// --- Howl of Xith: deal 3x your Rank to the enemy player and gain that much. ---
registerCard({
  defId: "howl-of-xith",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const x = 3 * ctx.game.state.players[player].rank;
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), x);
        healPlayer(ctx.game, ctx.events, player, x);
      },
    },
  },
});

// --- Infernal Visage: each friendly creature in a side space gets +2N/+2N
//     and Regenerate N. ---
registerCard({
  defId: "infernal-visage",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c && isSide(c.lane)) {
            buffCreature(ctx.game, ctx.events, c, 2 * lvl, 2 * lvl);
            grantKeyword(ctx.events, c, { keyword: "Regenerate", value: lvl });
          }
        }
      },
    }]),
  ),
});

// --- Necroflay: give a creature -N/-N; you may play an additional Necroflay
//     this turn (unrestricted extra play — see header note). ---
registerCard({
  defId: "necroflay",
  spell: Object.fromEntries(
    ([[1, 3], [2, 7], [3, 11]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
        ctx.game.state.playsLeft += 1; // "additional Necroflay" gate unenforceable (see header)
      },
    }]),
  ),
});

// --- Scythe of Chiron: L1/L2 spells drain N attack from each enemy creature
//     and give a friendly creature +N attack per enemy creature; L3 is the
//     Chiron creature with the same effect as a Forge. ---
registerCard({
  defId: "scythe-of-chiron",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature +${n} attack for each enemy creature`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const foes = ctx.game.state.players[opposing(player)].lanes
          .filter((c): c is CreatureState => !!c);
        for (const f of foes) buffCreature(ctx.game, ctx.events, f, -n, 0);
        const target = targetOf(ctx, choice);
        if (target && target.owner === player && foes.length) {
          buffCreature(ctx.game, ctx.events, target, n * foes.length, 0);
        }
      },
    }]),
  ),
  levels: {
    3: {
      abilities: [{
        id: "forge-drain",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foes = ctx.game.state.players[opposing(self.owner)].lanes
            .filter((c): c is CreatureState => !!c);
          for (const f of foes) buffCreature(ctx.game, ctx.events, f, -6, 0);
          if (foes.length) buffCreature(ctx.game, ctx.events, self, 6 * foes.length, 0);
        },
      }],
    },
  },
});

// --- Soulreap: destroy an enemy creature with <=cap attack, then Spawn a copy. ---
registerCard({
  defId: "soulreap",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Destroy an enemy creature with ${cap} or less attack, then Spawn a copy of it`,
        "enemyCreature",
        enemyUids(game, player, (c) => getStats(game, c).attack <= cap),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        const { defId, level } = c;
        destroyCreature(ctx.game, ctx.events, c);
        spawnCreature(ctx.game, ctx.events, player, defId, level, { lane: "random" });
      },
    }]),
  ),
});

// --- Tendrils of Twilight (Duskmaw's Solbind spell): Free; enemy creature
//     -1/-1, or -N/-N if it is opposing a friendly Duskmaw. ---
registerCard({
  defId: "tendrils-of-twilight",
  spell: Object.fromEntries(
    ([[1, 7], [2, 9], [3, 11]] as const).map(([lvl, big]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        "Give an enemy creature -1 attack and -1 health",
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        const across = ctx.game.state.players[player].lanes[c.lane];
        const n = across?.defId === "duskmaw-twilight-drake" ? big : 1;
        buffCreature(ctx.game, ctx.events, c, -n, -n);
      },
    }]),
  ),
});
