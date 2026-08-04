/**
 * Set 1 (Alpha) Nekrium card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Engine-limit notes (approximations, reported as API gaps — do not "fix" here):
 *  - Two-target effects use two-step choice chains: resolve() returns the second
 *    ChoiceRequest and ctx.priorAnswers carries the earlier answers (Grave Pact,
 *    Scourgeflame Sorcerer L1/L2, Hungering Strike).
 *  - Xithian Shambler L3 "use this ability twice per turn" cannot be expressed
 *    (engine allows one activate per creature per turn).
 *  - Xithian Shambler eats an adjacent FRIENDLY creature (it moves into that
 *    creature's space, which must be on its own side). The eaten creature is
 *    swapped into the Shambler's old space so the batch-end death check still
 *    finds it; its Vengeance therefore spawns into the Shambler's old space.
 *  - Lyria's "creature that was destroyed this game" is approximated as a
 *    creature-type, non-Token card in either player's discard pile (leveled-up
 *    and discard-to-level copies pollute the pool; real copies keep no buffs).
 *  - Xrath's Regenerate aura is modeled via granted turnStart-heal abilities
 *    (same as Heart Tree: statics cannot grant keywords, and granting the real
 *    keyword would double-heal creatures with inherent Regenerate and lose it
 *    all to negateKeyword on cleanup). A replaced (not destroyed) Xrath
 *    leaves the granted heal behind.
 *  - Keeper of the Damned's "this turn" expiration is modeled with a
 *    turnEnd self-cleanup granted ability.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, collectFor, dealCreatureDamage, dealPlayerDamage, destroyCreature,
  getStats, grantKeyword, healCreature, healPlayer, spawnCreature,
} from "../effects.js";
import { findCreature, opposing } from "../state.js";
import { isCreature } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function req(prompt: string, kind: ChoiceRequest["kind"], options: number[], optional = false): Omit<ChoiceRequest, "id"> | null {
  if (!options.length) return null;
  return optional ? { kind, prompt, options, optional: true } : { kind, prompt, options };
}

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

function isZombie(game: Game, defId: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes("Zombie");
}

/** "When this deals battle damage to a level-<=cap creature, destroy it" (Blight Walker / Touch of Blight). */
function blightDestroy(ctx: Ctx, self: CreatureState, evt: TriggerPayload, cap: number): void {
  if (evt.lane === undefined) return;
  const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
  if (t && t.level <= cap) destroyCreature(ctx.game, ctx.events, t);
}

/** Creature cards that left play this game (Lyria's pool — see header note). */
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

// ---------- granted abilities ----------

// Touch of Blight: "When this creature deals battle damage to a level-<=cap creature, destroy it."
for (const cap of [1, 2, 99] as const) {
  registerGranted(`nekrium:blight-${cap}`, {
    id: `nekrium:blight-${cap}`,
    trigger: "battleDamageToCreature",
    resolve(ctx, self, evt) {
      blightDestroy(ctx, self, evt, cap);
    },
  });
}

// Rite of the Grimgaunt: "When a creature is destroyed, this creature gets +N/+N."
for (const n of [1, 2, 3] as const) {
  registerGranted(`nekrium:rite-${n}`, {
    id: `nekrium:rite-${n}`,
    trigger: "anyCreatureDestroyed",
    condition: (_game, self, evt) => evt.sourceUid !== self.uid,
    resolve(ctx, self) {
      buffCreature(ctx.game, ctx.events, self, n, n);
    },
  });
}

// Xrath's aura: granted turnStart heal, N per level (see header note).
const xrathRef = (n: number) => `nekrium:xrath-regen-${n}`;
for (const n of [2, 4, 8] as const) {
  registerGranted(xrathRef(n), {
    id: xrathRef(n),
    trigger: "turnStart",
    condition: (game, self) => game.state.active === self.owner,
    resolve(ctx, self) {
      healCreature(ctx.game, ctx.events, self, n);
    },
  });
}

// Keeper of the Damned: the granted Vengeance lasts only until end of turn.
registerGranted("nekrium:keeper-expire", {
  id: "nekrium:keeper-expire",
  trigger: "turnEnd",
  resolve(_ctx, self) {
    self.grantedAbilities = self.grantedAbilities
      .filter((r) => r !== "shared:vengeance-spawn-self" && r !== "nekrium:keeper-expire");
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Blight Walker: battle damage to a level-<=N creature destroys it. ---
registerCard({
  defId: "blight-walker",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "blight",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          blightDestroy(ctx, self, evt, cap);
        },
      }],
    }]),
  ),
});

// --- Bonescythe Reaver: Forge — you may destroy a level-<=N enemy creature (L2+). ---
registerCard({
  defId: "bonescythe-reaver",
  levels: {
    1: {}, // vanilla 5/3
    ...Object.fromEntries(
      ([[2, 1], [3, 2]] as const).map(([lvl, cap]) => [lvl, {
        abilities: [{
          id: "forge-destroy",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => req(
            cap === 1
              ? "You may destroy a level 1 enemy creature"
              : `You may destroy a level ${cap} or lower enemy creature`,
            "enemyCreature",
            enemyUids(game, self.owner, (c) => c.level <= cap),
            true,
          ),
          resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c) destroyCreature(ctx.game, ctx.events, c);
          },
        }],
      }]),
    ),
  },
});

// --- Corpse Crawler: Forge — destroy a friendly creature (may be itself). ---
registerCard({
  defId: "corpse-crawler",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-eat",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          req("Destroy a friendly creature", "friendlyCreature", friendlyUids(game, self.owner)),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Darkheart Wanderer: when you play a spell, it gets Regenerate N. ---
registerCard({
  defId: "darkheart-wanderer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "spell-regen",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: n });
        },
      }],
    }]),
  ),
});

// --- Darkshaper Savant: when you play a level-<=gate Nekrium card, you may
//     give an enemy creature -N/-N (L2+). ---
registerCard({
  defId: "darkshaper-savant",
  levels: {
    1: {}, // vanilla 4/6
    ...Object.fromEntries(
      ([[2, 1, 3], [3, 2, 5]] as const).map(([lvl, gate, n]) => [lvl, {
        abilities: [{
          id: "wither-play",
          trigger: "cardPlayed" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner
            && evt.sourceLevel !== undefined && evt.sourceLevel <= gate
            && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Nekrium",
          prompt: (game: Game, self: CreatureState) => req(
            `Give an enemy creature -${n} attack and -${n} health`,
            "enemyCreature",
            enemyUids(game, self.owner),
            true,
          ),
          resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
          },
        }],
      }]),
    ),
  },
});

// --- Doomwing, Dire Drake: Mobility N; Flank — destroy the opposing level-<=cap creature. ---
registerCard({
  defId: "doomwing-dire-drake",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "flank-destroy",
        trigger: "moved" as const,
        condition: (game: Game, self: CreatureState) => {
          const opp = opposingCreature(game, self);
          return !!opp && opp.level <= cap;
        },
        resolve: (ctx: Ctx, self: CreatureState) => {
          const opp = opposingCreature(ctx.game, self);
          if (opp && opp.level <= cap) destroyCreature(ctx.game, ctx.events, opp);
        },
      }],
    }]),
  ),
});

// --- Dr. Frankenbaum: when a friendly Abomination is destroyed, deal N to the enemy player. ---
registerCard({
  defId: "dr-frankenbaum",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "abomination-ping",
        trigger: "friendlyCreatureDestroyed" as const,
        condition: (game: Game, _self: CreatureState, evt: TriggerPayload) =>
          !!evt.sourceDefId && (game.state.cards[evt.sourceDefId]?.subtypes ?? []).includes("Abomination"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n);
        },
      }],
    }]),
  ),
});

// --- Fell Walker: Vengeance — put an N/N Zombie into this space. ---
registerCard({
  defId: "fell-walker",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-zombie",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "zombie", 1,
            { lane: evt.lane ?? "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Fleshfiend: Vengeance — put a lower-level Fleshfiend into this space (L2+). ---
registerCard({
  defId: "fleshfiend",
  levels: {
    1: {}, // vanilla 6/6
    ...Object.fromEntries(
      ([[2, 1], [3, 2]] as const).map(([lvl, spawnLvl]) => [lvl, {
        abilities: [{
          id: "vengeance-copy",
          trigger: "destroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            spawnCreature(ctx.game, ctx.events, self.owner, "fleshfiend", spawnLvl,
              { lane: evt.lane ?? "random" });
          },
        }],
      }]),
    ),
  },
});

// --- Gloomreaper Witch: Forge — you may destroy an enemy creature with <=N attack. ---
registerCard({
  defId: "gloomreaper-witch",
  levels: Object.fromEntries(
    ([[1, 1], [2, 4], [3, 7]] as const).map(([lvl, maxAtk]) => [lvl, {
      abilities: [{
        id: "forge-destroy",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `You may destroy an enemy creature with ${maxAtk} or less attack`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => getStats(game, c).attack <= maxAtk),
          true,
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Graveborn Glutton: Vengeance — deal lo..hi damage to the enemy player. ---
registerCard({
  defId: "graveborn-glutton",
  levels: Object.fromEntries(
    ([[1, 1, 4], [2, 2, 8], [3, 4, 12]] as const).map(([lvl, lo, hi]) => [lvl, {
      abilities: [{
        id: "vengeance-ping",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), lo + ctx.rng.int(hi - lo + 1));
        },
      }],
    }]),
  ),
});

// --- Grimgaunt Predator: Mobility 1; when the opposing creature is destroyed, +N/+N. ---
registerCard({
  defId: "grimgaunt-predator",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "devour",
        trigger: "opposingCreatureDestroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Hellforged Avatar: Regenerate N; Forge — +N/+N for each Nekrium card in your hand. ---
registerCard({
  defId: "hellforged-avatar",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-hand",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].hand
            .filter((c) => ctx.game.state.cards[c.defId]?.faction === "Nekrium").length;
          if (count > 0) buffCreature(ctx.game, ctx.events, self, n * count, n * count);
        },
      }],
    }]),
  ),
});

// --- Keeper of the Damned: Activate — another friendly level-<=cap creature
//     gets "Vengeance: Spawn this" this turn. ---
registerCard({
  defId: "keeper-of-the-damned",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      activates: [{
        id: "grant-vengeance",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid && c.level <= cap).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          cap === 99
            ? "Another friendly creature gets \"Vengeance: Spawn this\" this turn"
            : `Another friendly level ${cap}${cap === 2 ? " or lower" : ""} creature gets "Vengeance: Spawn this" this turn`,
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid && c.level <= cap),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) c.grantedAbilities.push("shared:vengeance-spawn-self", "nekrium:keeper-expire");
        },
      }],
    }]),
  ),
});

// --- Lyria, Muse of Varna: Forge — spawn random creature(s) destroyed this game (L2+). ---
registerCard({
  defId: "lyria-muse-of-varna",
  levels: {
    1: {}, // vanilla 5/4
    ...Object.fromEntries(
      ([2, 3] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "forge-raise",
          trigger: "enterFromHand" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const pool = destroyedPool(ctx.game);
            if (!pool.length) return;
            const open = ctx.game.state.players[self.owner].lanes
              .map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
            if (lvl === 2) {
              const pick = ctx.rng.pick(pool);
              spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
            } else {
              for (const lane of open) { // may copy the same creature more than once
                const pick = ctx.rng.pick(pool);
                spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane });
              }
            }
          },
        }],
      }]),
    ),
  },
});

// --- Necroslime: Activate, deal 3 damage to another friendly creature — +N/+N. ---
registerCard({
  defId: "necroslime",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "feed",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Deal 3 damage to another friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          dealCreatureDamage(ctx.game, ctx.events, c, 3, self);
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Scourgeflame Sorcerer: Activate (, destroy another friendly creature) —
//     destroy a (level-<=2) enemy creature. L1/L2 use a two-step choice chain:
//     first the friendly sacrifice, then the enemy target. ---
registerCard({
  defId: "scourgeflame-sorcerer",
  levels: Object.fromEntries(
    ([[1, 2, true], [2, 99, true], [3, 99, false]] as const).map(([lvl, cap, cost]) => [lvl, {
      activates: [{
        id: "sorcery",
        condition: (game: Game, self: CreatureState) =>
          enemyUids(game, self.owner, (c) => c.level <= cap).length > 0
          && (!cost || friendlyUids(game, self.owner, (c) => c.uid !== self.uid).length > 0),
        prompt: (game: Game, self: CreatureState) => cost
          ? req("Destroy another friendly creature", "friendlyCreature",
            friendlyUids(game, self.owner, (c) => c.uid !== self.uid))
          : req(
            cap === 99 ? "Destroy an enemy creature" : "Destroy a level 2 or lower enemy creature",
            "enemyCreature",
            enemyUids(game, self.owner, (c) => c.level <= cap),
          ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          if (!cost) { // L3: single prompt, no sacrifice
            const c = targetOf(ctx, choice);
            if (c) destroyCreature(ctx.game, ctx.events, c);
            return;
          }
          const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
          if (firstUid === undefined) return;
          if (ctx.priorAnswers.length < 2) {
            // step 1: pay the sacrifice, then chain the enemy-target prompt
            const foes = enemyUids(ctx.game, self.owner, (c) => c.level <= cap);
            if (!foes.length) return;
            const sacrifice = findCreature(ctx.game.state, firstUid);
            if (sacrifice && sacrifice.uid !== self.uid) destroyCreature(ctx.game, ctx.events, sacrifice);
            return req(
              cap === 2 ? "Destroy a level 2 or lower enemy creature" : "Destroy an enemy creature",
              "enemyCreature",
              foes,
            ) ?? undefined;
          }
          const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
          const foe = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
          if (foe) destroyCreature(ctx.game, ctx.events, foe);
        },
      }],
    }]),
  ),
});

// --- Soul Drinker: Forge (/Flank at L3) — the opposing creature's attack
//     becomes 0 and Soul Drinker gets that much attack. ---
function drainAttack(ctx: Ctx, self: CreatureState): void {
  const opp = opposingCreature(ctx.game, self);
  if (!opp) return;
  const atk = getStats(ctx.game, opp).attack;
  if (atk <= 0) return;
  buffCreature(ctx.game, ctx.events, opp, -atk, 0);
  buffCreature(ctx.game, ctx.events, self, atk, 0);
}
registerCard({
  defId: "soul-drinker",
  levels: {
    1: {}, // no ability
    2: {
      abilities: [{
        id: "forge-drain",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => !!opposingCreature(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => drainAttack(ctx, self),
      }],
    },
    3: {
      abilities: [
        {
          id: "forge-drain",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) => !!opposingCreature(game, self),
          resolve: (ctx: Ctx, self: CreatureState) => drainAttack(ctx, self),
        },
        {
          id: "flank-drain",
          trigger: "moved" as const,
          condition: (game: Game, self: CreatureState) => !!opposingCreature(game, self),
          resolve: (ctx: Ctx, self: CreatureState) => drainAttack(ctx, self),
        },
      ],
    },
  },
});

// --- Vengeful Spirit: Vengeance — give the opposing creature -N/-N. ---
registerCard({
  defId: "vengeful-spirit",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-drain",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const opp = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (opp) buffCreature(ctx.game, ctx.events, opp, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Witherfrost Succubus: Activate — give a creature -N/-N this turn. ---
registerCard({
  defId: "witherfrost-succubus",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "wither",
        prompt: (game: Game) => req(
          `Give a creature -${n} attack and -${n} health this turn`,
          "anyCreature",
          [...game.state.players[0].lanes, ...game.state.players[1].lanes]
            .filter(Boolean).map((c) => c!.uid),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, -n, true);
        },
      }],
    }]),
  ),
});

// --- Xithian Shambler: Activate, destroy an adjacent creature — move into its
//     space and get +attack/+health equal to that creature's. (L3 twice/turn: gap.) ---
registerCard({
  defId: "xithian-shambler",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "devour-move",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => Math.abs(c.lane - self.lane) === 1).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Destroy an adjacent creature; Xithian Shambler moves into its space and gets its attack and health",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => Math.abs(c.lane - self.lane) === 1),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== self.owner || Math.abs(c.lane - self.lane) !== 1) return;
          const gained = getStats(ctx.game, c);
          // Swap lanes: the eaten creature must stay on the board until the
          // batch-end death check, so it dies in the Shambler's old space.
          const pl = ctx.game.state.players[self.owner];
          const from = self.lane;
          const to = c.lane;
          pl.lanes[to] = self;
          self.lane = to;
          pl.lanes[from] = c;
          c.lane = from;
          ctx.events.push({ type: "moved", player: self.owner, uid: self.uid, from, to });
          collectFor(ctx.game, self, "moved", { sourceUid: self.uid, lane: to });
          buffCreature(ctx.game, ctx.events, self, gained.attack, gained.health);
          destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Xrath, Dreadknight of Varna: Regenerate N; each other friendly Zombie
//     gets Regenerate N (granted turnStart heals — see header note). ---
registerCard({
  defId: "xrath-dreadknight-of-varna",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "aura-enter",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[self.owner].lanes) {
              if (c && c.uid !== self.uid && isZombie(ctx.game, c.defId)) {
                c.grantedAbilities.push(xrathRef(n));
              }
            }
          },
        },
        {
          id: "aura-grant",
          trigger: "creaturePlayed" as const,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner && evt.lane !== undefined && evt.lane !== self.lane
            && !!evt.sourceDefId && isZombie(game, evt.sourceDefId),
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            const c = ctx.game.state.players[self.owner].lanes[evt.lane!];
            if (c && c.uid !== self.uid) c.grantedAbilities.push(xrathRef(n));
          },
        },
        {
          id: "aura-cleanup",
          trigger: "destroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[self.owner].lanes) {
              if (!c) continue;
              const i = c.grantedAbilities.indexOf(xrathRef(n));
              if (i >= 0) c.grantedAbilities.splice(i, 1);
            }
          },
        },
      ],
    }]),
  ),
});

// --- Zimus, the Undying: Vengeance — spawn Zimus, the Returned (L2) /
//     another Zimus, the Undying (L3). ---
registerCard({
  defId: "zimus-the-undying",
  levels: {
    1: {}, // vanilla 5/2
    2: {
      abilities: [{
        id: "vengeance-returned",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "zimus-the-returned", 2,
            { lane: evt.lane ?? "random" });
        },
      }],
    },
    3: {
      abilities: [{
        id: "vengeance-undying",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "zimus-the-undying", 3,
            { lane: evt.lane ?? "random" });
        },
      }],
    },
  },
});

// Vanilla / keyword-only creatures (no script needed): Grave Ghast, Grimgaunt
// Spectre (Mobility), Marrow Fiend, Necrotic Wurm, Scavenger Scorpion,
// Unrelenting Dead, Xithian Hulk, Zombie Infantry, Zimus the Returned, and the
// Zombie / Spirit (Nekrium) / Oozeling (green) tokens. Death Seeker and
// Grimgaunt Devourer are scripted in set1.ts.

// ============================================================
// Spells
// ============================================================

// --- Contagion Surge: give a creature -N/-N (Free at L2+ — engine keyword). ---
registerCard({
  defId: "contagion-surge",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes].filter(Boolean).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
      },
    }]),
  ),
});

// --- Cull the Weak: destroy a creature with <=N attack. ---
registerCard({
  defId: "cull-the-weak",
  spell: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 14]] as const).map(([lvl, maxAtk]) => [lvl, {
      prompt: (game: Game) => req(
        `Destroy a creature with ${maxAtk} or less attack`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes]
          .filter((c) => c && getStats(game, c).attack <= maxAtk).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) destroyCreature(ctx.game, ctx.events, c);
      },
    }]),
  ),
});

// --- Dreadbolt: destroy a (level-<=N) creature. ---
registerCard({
  defId: "dreadbolt",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 99 ? "Destroy a creature" : `Destroy a level ${cap}${cap === 2 ? " or lower" : ""} creature`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes]
          .filter((c) => c && c.level <= cap).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) destroyCreature(ctx.game, ctx.events, c);
      },
    }]),
  ),
});

// --- Epidemic: each enemy creature gets -N/-N. ---
registerCard({
  defId: "epidemic",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
        }
      },
    }]),
  ),
});

// --- Explosive Demise: destroy a friendly creature (L1: level <= 2), deal
//     damage equal to its attack to the enemy player (L3: gain that much health). ---
registerCard({
  defId: "explosive-demise",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        lvl === 1
          ? "Destroy a friendly level 2 or lower creature; deal damage equal to its attack to the enemy player"
          : "Destroy a friendly creature; deal damage equal to its attack to the enemy player",
        "friendlyCreature",
        friendlyUids(game, player, (c) => lvl > 1 || c.level <= 2),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        const atk = getStats(ctx.game, c).attack;
        destroyCreature(ctx.game, ctx.events, c);
        if (atk > 0) {
          dealPlayerDamage(ctx.game, ctx.events, opposing(player), atk);
          if (lvl === 3) healPlayer(ctx.game, ctx.events, player, atk);
        }
      },
    }]),
  ),
});

// --- Ghastly Touch: give a creature -N/-N. ---
registerCard({
  defId: "ghastly-touch",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes].filter(Boolean).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
      },
    }]),
  ),
});

// --- Grave Pact: destroy a friendly creature and a (level-<=2 at L1) enemy
//     creature. Two-step choice: the friendly sacrifice first, then the enemy. ---
registerCard({
  defId: "grave-pact",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const friends = friendlyUids(game, player);
        const foes = enemyUids(game, player, (c) => c.level <= cap);
        if (!friends.length || !foes.length) return null;
        return { kind: "friendlyCreature" as const, prompt: "Destroy a friendly creature", options: friends };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // prompt found no targets: fizzle
        if (ctx.priorAnswers.length < 2) {
          // step 1: destroy the chosen friendly creature, then chain prompt 2
          const foes = enemyUids(ctx.game, player, (c) => c.level <= cap);
          if (!foes.length) return;
          const sacrifice = findCreature(ctx.game.state, firstUid);
          if (sacrifice) destroyCreature(ctx.game, ctx.events, sacrifice);
          return {
            kind: "enemyCreature" as const,
            prompt: cap === 2 ? "Destroy a level 2 or lower enemy creature" : "Destroy an enemy creature",
            options: foes,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const foe = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (foe) destroyCreature(ctx.game, ctx.events, foe);
      },
    }]),
  ),
});

// --- Hungering Strike: give a friendly creature +N attack and an enemy
//     creature -N attack. Two-step choice: the friendly buff first, then the enemy. ---
registerCard({
  defId: "hungering-strike",
  spell: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const friends = friendlyUids(game, player);
        const foes = enemyUids(game, player);
        if (!friends.length || !foes.length) return null;
        return { kind: "friendlyCreature" as const, prompt: `Give a friendly creature +${n} attack`, options: friends };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // prompt found no targets: fizzle
        if (ctx.priorAnswers.length < 2) {
          // step 1: buff the chosen friendly creature, then chain prompt 2
          const foes = enemyUids(ctx.game, player);
          if (!foes.length) return;
          const buffed = findCreature(ctx.game.state, firstUid);
          if (buffed && buffed.owner === player) buffCreature(ctx.game, ctx.events, buffed, n, 0);
          return {
            kind: "enemyCreature" as const,
            prompt: `Give an enemy creature -${n} attack`,
            options: foes,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const foe = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (foe) buffCreature(ctx.game, ctx.events, foe, -n, 0);
      },
    }]),
  ),
});

// --- Necrovive: give a creature Regenerate N. ---
registerCard({
  defId: "necrovive",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature Regenerate ${n}`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes].filter(Boolean).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
      },
    }]),
  ),
});

// --- Nether Embrace: deal N damage to the enemy player; you gain N health. ---
registerCard({
  defId: "nether-embrace",
  spell: Object.fromEntries(
    ([[1, 4], [2, 7], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), n);
        healPlayer(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});

// --- Rite of the Grimgaunt: give a creature "when a creature is destroyed, +N/+N". ---
registerCard({
  defId: "rite-of-the-grimgaunt",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature "When a creature is destroyed, this creature gets +${lvl} attack and +${lvl} health"`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes].filter(Boolean).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.grantedAbilities.push(`nekrium:rite-${lvl}`);
      },
    }]),
  ),
});

// --- Soul Harvest: destroy a friendly creature; play N additional cards this
//     turn (L1's level-1 restriction cannot be expressed — see Frostwild Tracker). ---
registerCard({
  defId: "soul-harvest",
  spell: Object.fromEntries(
    ([[1, 1], [2, 1], [3, 2]] as const).map(([lvl, extra]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        extra === 2
          ? "Destroy a friendly creature; play two additional cards this turn"
          : "Destroy a friendly creature; play an additional card this turn",
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) destroyCreature(ctx.game, ctx.events, c);
        ctx.game.state.playsLeft += extra;
      },
    }]),
  ),
});

// --- Touch of Blight: give a creature "battle damage to a level-<=cap creature destroys it". ---
registerCard({
  defId: "touch-of-blight",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 99
          ? "Give a creature \"When this deals battle damage to a creature, destroy it\""
          : `Give a creature "When this deals battle damage to a level ${cap}${cap === 2 ? " or lower" : ""} creature, destroy it"`,
        "anyCreature",
        [...game.state.players[0].lanes, ...game.state.players[1].lanes].filter(Boolean).map((c) => c!.uid),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.grantedAbilities.push(`nekrium:blight-${cap}`);
      },
    }]),
  ),
});
