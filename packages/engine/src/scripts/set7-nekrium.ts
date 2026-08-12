/**
 * Set 7 (Raiders Unchained) + 7.1 + 7.2 + 7.3 — Nekrium card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set6-nekrium.ts / set7-alloyin.ts):
 *  - Formation (new Set 7 keyword): both adjacent spaces on the creature's own
 *    side hold friendly creatures; implemented as enterFromHand + condition
 *    per CARD_SCRIPTING.md (set7-alloyin.ts convention).
 *  - Crypt Wail: "three or more enemy creatures initiated battle this turn" is
 *    read off the enemy creatures' hasBattled flags. The engine resets those
 *    flags at the start of the flagged creature's OWN turn, so during your
 *    turn they still show the enemy's previous battle phase — the only window
 *    in which the condition can be true (enemies cannot battle on your turn).
 *    Enemy creatures that battled and then died are not counted (the engine
 *    has no battle-initiation log). TODO: per-turn battle log if the exact
 *    count matters.
 *  - Dread: the 50% roll happens on every entry (Forged or Spawned — "when
 *    Dread enters play"); on success the creature gets a granted Vengeance
 *    ability (nekrium:dread-vengeance-N) that Spawns a fresh Dread at the
 *    printed level. The fresh Dread rolls again on its own entry.
 *  - Ebonskull Diabolist: the delayed "you may play an additional card" is a
 *    one-shot granted turnStart ability living on the Diabolist itself, so it
 *    only fires while the Diabolist is in play (per the text). At the start of
 *    the controller's next turn it grants playsLeft += 1 and removes itself.
 *  - "Destroyed this game" pools (Lichmane Dragon, Murderous Necromancer) use
 *    the discard-pile approximation (Lyria/Portal Shade convention): creature
 *    cards in the relevant discard piles, Tokens excluded. Hand discards and
 *    level-up copies are included by that approximation. The pick is random —
 *    there is no deck/discard-search choice kind (Dragonwake convention).
 *  - Cercee's Call: "a friendly Zombie that was destroyed this turn" is exact
 *    (state.deathLog is a per-turn identity log: defId/level/owner), but the
 *    pick is random for the same reason as above.
 *  - Murderous Necromancer L3: "if that creature is opposed" is checked after
 *    the Spawn lands (random open space); the enemy creature in the Spawn's
 *    lane is destroyed.
 *  - Death's Possession: the attack cap uses current effective attack
 *    (getStats); the Alloyin copy is Spawned at the destroyed creature's level
 *    in a random open space and fizzles on a full board (Sparky convention).
 *  - Festering Slime: the battleDamageToCreature payload carries the TARGET's
 *    lane (engine battle damage is always same-lane), so the debuff target is
 *    recovered by lane (Touch of Blight convention, set1-nekrium.ts).
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealPlayerDamage, destroyCreature, getStats, grantKeyword, healPlayer, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, opposing,
  type CardInstance, type CreatureState, type PlayerId,
} from "../state.js";
import { isCreature } from "../types.js";
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

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

/** Word-match against combined subtype strings ("Spirit Dragon" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

/** Formation: both spaces adjacent to `lane` on p's own side are occupied. */
function inFormation(game: Game, p: PlayerId, lane: number): boolean {
  const pl = game.state.players[p];
  return lane > 0 && lane < pl.lanes.length - 1 && !!pl.lanes[lane - 1] && !!pl.lanes[lane + 1];
}

/** Creature cards that left play this game (discard-pool approximation — see header). */
function destroyedPool(game: Game, owner?: PlayerId): CardInstance[] {
  const out: CardInstance[] = [];
  for (const p of [0, 1] as const) {
    if (owner !== undefined && p !== owner) continue;
    for (const inst of game.state.players[p].discard) {
      const def = game.state.cards[inst.defId];
      if (def && isCreature(def) && def.rarity !== "Token") out.push(inst);
    }
  }
  return out;
}

// ---------- granted abilities ----------

// Dread: "Vengeance: Spawn a level N Dread" (granted on entry, 50% — see header).
for (const n of [1, 2, 3] as const) {
  registerGranted(`nekrium:dread-vengeance-${n}`, {
    id: `nekrium:dread-vengeance-${n}`,
    trigger: "destroyed",
    resolve(ctx, self) {
      spawnCreature(ctx.game, ctx.events, self.owner, "dread", n, { lane: "random" });
    },
  });
}

// Undying Legacy: "Vengeance: Spawn a copy of this" (copy = same card and level;
// self is the death snapshot, which carries both).
registerGranted("nekrium:undying-legacy", {
  id: "nekrium:undying-legacy",
  trigger: "destroyed",
  resolve(ctx, self) {
    spawnCreature(ctx.game, ctx.events, self.owner, self.defId, self.level, { lane: "random" });
  },
});

// Ebonskull Diabolist: one-shot extra play at the start of the controller's next
// turn (see header). Lives on the Diabolist, so "if it is in play" is free.
registerGranted("nekrium:ebonskull-extra-play", {
  id: "nekrium:ebonskull-extra-play",
  trigger: "turnStart",
  condition: (game, self) => game.state.active === self.owner,
  resolve(ctx, self) {
    ctx.game.state.playsLeft += 1;
    self.grantedAbilities = self.grantedAbilities.filter((r) => r !== "nekrium:ebonskull-extra-play");
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Bride of Frankenbaum: when a friendly Abomination is destroyed, you gain
//     N health. (The Bride itself is an Abomination but is off the board before
//     death triggers are collected, so its own death never heals.) ---
registerCard({
  defId: "bride-of-frankenbaum",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "abomination-lifegain",
        trigger: "friendlyCreatureDestroyed" as const,
        condition: (game: Game, _self: CreatureState, evt: TriggerPayload) =>
          !!evt.sourceDefId && hasSubtype(game, evt.sourceDefId, "Abomination"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Ceaseless Grimgaunt: Vengeance — if there are no friendly creatures in
//     play, Spawn a copy of Ceaseless Grimgaunt (same level). The Grimgaunt is
//     removed before its Vengeance is collected, so it never counts itself. ---
registerCard({
  defId: "ceaseless-grimgaunt",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-reborn",
        trigger: "destroyed" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].lanes.every((c) => !c),
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "ceaseless-grimgaunt", self.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Cyrus, the Merciless: Formation — destroy each OTHER creature (both
//     sides) with cap or less current attack; whenever a creature is destroyed,
//     Cyrus gets +1/+1 (including its own Formation kills: the growth triggers
//     off the follow-up death batch). ---
registerCard({
  defId: "cyrus-the-merciless",
  levels: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 9]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [
        {
          id: "formation-cull",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of [...allCreatures(ctx.game.state)]) {
              if (c.uid !== self.uid && getStats(ctx.game, c).attack <= cap) {
                destroyCreature(ctx.game, ctx.events, c);
              }
            }
          },
        },
        {
          id: "death-growth",
          trigger: "anyCreatureDestroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, 1, 1);
          },
        },
      ],
    }]),
  ),
});

// --- Disciple of Vyric: Formation — deal N damage to the enemy player and
//     gain N health. ---
registerCard({
  defId: "disciple-of-vyric",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "formation-drain",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Dread: when it enters play, 50% chance to get "Vengeance: Spawn a level
//     N Dread" (granted ability — see the registry above). ---
registerCard({
  defId: "dread",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "dread-roll",
        trigger: "enterPlay" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (ctx.rng.next() < 0.5) self.grantedAbilities.push(`nekrium:dread-vengeance-${self.level}`);
        },
      }],
    }]),
  ),
});

// --- Ebonskull Diabolist: Forge — at the start of your next turn, if it is in
//     play, you may play an additional card (one-shot granted ability). ---
registerCard({
  defId: "ebonskull-diabolist",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-extra-play",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          self.grantedAbilities.push("nekrium:ebonskull-extra-play");
        },
      }],
    }]),
  ),
});

// --- Festering Slime: when it deals battle damage to a creature, that creature
//     gets -N/-N (target recovered by lane — see header). ---
registerCard({
  defId: "festering-slime",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "festering-touch",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (t) buffCreature(ctx.game, ctx.events, t, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Indomitable Fiend (single level): when it enters play, if it wasn't
//     Forged, it gets +5/+5 for each player rank you are. ---
registerCard({
  defId: "indomitable-fiend",
  levels: {
    1: {
      abilities: [{
        id: "unforged-growth",
        trigger: "enterPlay" as const,
        condition: (_game: Game, _self: CreatureState, evt: TriggerPayload) => evt.fromHand !== true,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const n = 5 * ctx.game.state.players[self.owner].rank;
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    },
  },
});

// --- Lichmane Dragon: Mobility 1 (inherent); Formation — Spawn an enemy
//     creature that was destroyed this game (discard-pool approximation, random
//     pick, copy at the destroyed card's level — see header). ---
registerCard({
  defId: "lichmane-dragon",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "formation-raise",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pool = destroyedPool(ctx.game, opposing(self.owner));
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Murderous Necromancer: at the start of your turn, Spawn a random
//     level-capped creature that was destroyed this game (discard-pool
//     approximation — see header). L3: if the Spawn is opposed, destroy the
//     creature opposing it. ---
registerCard({
  defId: "murderous-necromancer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, Infinity]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "raise-dead",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // L1 "a level 1 creature" == level <= 1; L2 "level 2 or lower"; L3 any
          const pool = destroyedPool(ctx.game).filter((inst) => inst.level <= cap);
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          const raised = spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
          if (lvl === 3 && raised) {
            const foe = ctx.game.state.players[opposing(self.owner)].lanes[raised.lane];
            if (foe) destroyCreature(ctx.game, ctx.events, foe);
          }
        },
      }],
    }]),
  ),
});

// --- Necroplasm: Formation — the enemy player discards a card at random (the
//     discarded card does NOT level up — Plunder Imp convention). ---
registerCard({
  defId: "necroplasm",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "formation-hollow",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = ctx.game.state.players[opposing(self.owner)];
          if (!foe.hand.length) return;
          const idx = ctx.rng.int(foe.hand.length);
          const [inst] = foe.hand.splice(idx, 1);
          if (!inst) return;
          foe.discard.push(inst);
          ctx.events.push({ type: "discard", player: opposing(self.owner), defId: inst.defId, level: inst.level });
        },
      }],
    }]),
  ),
});

// --- Scourge Knights: Formation — give an enemy creature -N/-N. ---
registerCard({
  defId: "scourge-knights",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "formation-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        prompt: (game: Game, self: CreatureState) => req(
          `Give an enemy creature -${n} attack and -${n} health`,
          "enemyCreature",
          enemyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.owner !== self.owner) buffCreature(ctx.game, ctx.events, c, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Spectral Rider: when a friendly creature is destroyed, +1/+1 (same at
//     every level). ---
registerCard({
  defId: "spectral-rider",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "death-growth",
        trigger: "friendlyCreatureDestroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, 1, 1);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Cercee's Call: Spawn a copy of a friendly Zombie that was destroyed this
//     turn (deathLog is exact for "this turn"; random pick — see header).
//     L2 Free is inherent (parsed from the text). ---
registerCard({
  defId: "cercees-call",
  spell: Object.fromEntries(
    [1, 2].map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pool = ctx.game.state.deathLog.filter(
          (e) => e.owner === player && hasSubtype(ctx.game, e.defId, "Zombie"),
        );
        if (!pool.length) return;
        const pick = ctx.rng.pick(pool);
        spawnCreature(ctx.game, ctx.events, player, pick.defId, pick.level, { lane: "random" });
      },
    }]),
  ),
});

// --- Crypt Wail: deal N damage to the enemy player and gain N health; doubled
//     if three or more enemy creatures initiated battle this turn (hasBattled
//     flags — see header). ---
registerCard({
  defId: "crypt-wail",
  spell: Object.fromEntries(
    ([[1, 5, 10], [2, 7, 14], [3, 9, 18]] as const).map(([lvl, base, bonus]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const battled = ctx.game.state.players[opposing(player)].lanes
          .filter((c) => !!c && c.hasBattled).length;
        const n = battled >= 3 ? bonus : base;
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), n);
        healPlayer(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});

// --- Death's Possession: destroy an enemy creature with cap or less attack;
//     if it is Alloyin, Spawn a copy of it under your control (at its level). ---
registerCard({
  defId: "deaths-possession",
  spell: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Destroy an enemy creature with ${cap} or less attack; if it is Alloyin, Spawn a copy of it`,
        "enemyCreature",
        enemyUids(game, player, (c) => getStats(game, c).attack <= cap),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player || getStats(ctx.game, c).attack > cap) return; // re-validate
        const { defId, level } = c;
        const alloyin = ctx.game.state.cards[defId]?.faction === "Alloyin";
        destroyCreature(ctx.game, ctx.events, c);
        if (alloyin) spawnCreature(ctx.game, ctx.events, player, defId, level, { lane: "random" });
      },
    }]),
  ),
});

// --- Rite of Undeath: each friendly creature gets Regenerate N. ---
registerCard({
  defId: "rite-of-undeath",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
        }
      },
    }]),
  ),
});

// --- Undying Legacy (Overload inherent): give a friendly creature "Vengeance:
//     Spawn a copy of this" (granted ability — see the registry above). ---
registerCard({
  defId: "undying-legacy",
  spell: {
    1: {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature "Vengeance: Spawn a copy of this"`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.grantedAbilities.push("nekrium:undying-legacy");
      },
    },
  },
});
