/**
 * Set 2 (Rise of the Forgeborn) — Alloyin card scripts. See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes:
 *  - Ironbeard: "moves to an available enemy space at random" is a state-only
 *    side change (no primitive exists): the damaged creature is removed from
 *    its lane and placed in a random open lane on Ironbeard's side, changing
 *    controller. Move triggers ("moved") are not broadcast for this.
 *  - Steelscale Dragon: "while each other friendly creature has Defender" is
 *    read literally — with zero other friendly creatures the condition is
 *    vacuously true and the Dragon keeps its bonus.
 *  - Sap / Ironbeard L4: "reduce attack to 0" is a permanent debuff of the
 *    creature's current effective attack (getStats), so later buffs can raise
 *    it above 0 again.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, drawCardsEffect, getStats, grantKeyword, negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, hasKeyword, isDead, opposing } from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { Ability, ChoiceAnswer, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function boardCreatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

/** Allied condition: a card of `faction` remains in the controller's hand. */
function handHasFaction(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand
    .some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

/** "Discard and level up a card" — same shape as discardAndLevel in set15.ts. */
function discardAndLevel(ctx: Ctx, player: PlayerId, handIndex: number): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  pl.hand.splice(handIndex, 1);
  pl.discard.push(inst);
  ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  const def = ctx.game.state.cards[inst.defId];
  if (def && inst.level < maxLevel(def)) {
    pl.discard.push({ uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player });
    ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
  }
}

/**
 * "Level up a card in your hand" (Delpha): the original stays in hand, the
 * leveled copy goes to the discard pile (mirrors game.ts levelUpCopy).
 */
function levelUpHandCopy(ctx: Ctx, player: PlayerId, inst: CardInstance): void {
  const def = ctx.game.state.cards[inst.defId];
  if (!def || inst.level >= maxLevel(def)) return;
  ctx.game.state.players[player].discard.push({
    uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player,
  });
  ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
}

// ============================================================
// Creatures
// ============================================================

// --- Aetherguard (when you play a spell, gets Armor N) ---
registerCard({
  defId: "aetherguard",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "spell-armor",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Alloyin Strategist (static: adjacent creatures get +N attack) ---
registerCard({
  defId: "alloyin-strategist",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "adjacent-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.uid !== self.uid && target.owner === self.owner && Math.abs(target.lane - self.lane) === 1) {
            stats.attack += n;
          }
        },
      }],
    }]),
  ),
});

// anvillon-enforcer: vanilla (Armor keyword only), no script required.

// --- Apocrymancer (when you play an Alloyin spell, you may discard and level up a card) ---
registerCard({
  defId: "apocrymancer",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "recycle",
        trigger: "spellPlayed" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Alloyin",
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[self.owner].hand;
          if (!hand.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "You may discard and level up a card",
            options: hand.map((_, i) => i),
            optional: true,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Crucible Colossus (when you gain a Rank, Negate Defender from it) ---
registerCard({
  defId: "crucible-colossus",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "rank-mobility",
        trigger: "rankGained" as const,
        // rankGained fires during the ranking player's endTurn, while they are still active
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          negateKeyword(ctx.events, self, "Defender");
        },
      }],
    }]),
  ),
});

// --- Delpha, Chronosculptor (at the start of your turn, level up a random card in hand) ---
function delpha(gate: number): Ability {
  return {
    id: "chronosculpt",
    trigger: "turnStart" as const,
    condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
    resolve: (ctx: Ctx, self: CreatureState) => {
      const pl = ctx.game.state.players[self.owner];
      const pool = pl.hand.filter((inst) => {
        const def = ctx.game.state.cards[inst.defId];
        return !!def && inst.level <= gate && inst.level < maxLevel(def);
      });
      if (!pool.length) return;
      levelUpHandCopy(ctx, self.owner, ctx.rng.pick(pool));
    },
  };
}
registerCard({
  defId: "delpha-chronosculptor",
  levels: {
    1: {}, // vanilla 7/7
    2: { abilities: [delpha(1)] }, // level 1 cards only
    3: { abilities: [delpha(99)] }, // any card
  },
});

// --- Esperian Scarab (Allied Uterra: you may put a copy of it into another space) ---
registerCard({
  defId: "esperian-scarab",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "allied-copy",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => handHasFaction(game, self.owner, "Uterra"),
        prompt: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].lanes.some((c) => !c)
            ? { kind: "yesNo" as const, prompt: "Put a copy of Esperian Scarab into another space?", optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // "another space": random open lane (self's lane is occupied); the
          // copy is not fromHand, so its own Allied does not trigger.
          spawnCreature(ctx.game, ctx.events, self.owner, self.defId, self.level, {});
        },
      }],
    }]),
  ),
});

// --- Ironbeard, Hammer of Anvillon (battle damage to a creature: -N attack
//     and it moves to a random enemy space; L4: attack to 0) ---
function moveToRandomEnemySpace(ctx: Ctx, c: CreatureState, newOwner: PlayerId): void {
  const game = ctx.game;
  const toPl = game.state.players[newOwner];
  const open = toPl.lanes.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
  if (!open.length) return;
  const fromPl = game.state.players[c.owner];
  if (fromPl.lanes[c.lane]?.uid === c.uid) fromPl.lanes[c.lane] = null;
  const from = c.lane;
  const lane = ctx.rng.pick(open);
  toPl.lanes[lane] = c;
  c.owner = newOwner;
  c.lane = lane;
  ctx.events.push({ type: "moved", player: newOwner, uid: c.uid, from, to: lane });
}
registerCard({
  defId: "ironbeard-hammer-of-anvillon",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6], [4, 99]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "hammer-blow",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const target = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          // a creature destroyed by the battle damage leaves at batch end; don't move it
          if (!target || isDead(target)) return;
          const debuff = n === 99 ? getStats(ctx.game, target).attack : n;
          if (debuff) buffCreature(ctx.game, ctx.events, target, -debuff, 0);
          moveToRandomEnemySpace(ctx, target, self.owner);
        },
      }],
    }]),
  ),
});

// --- Metamind Explorer (Vengeance: draw N cards) ---
registerCard({
  defId: "metamind-explorer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-draw",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          drawCardsEffect(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// metamind-operator: vanilla, no script required.

// --- Nexus Techtician (static: in the center space, other friendly creatures get Armor N) ---
registerCard({
  defId: "nexus-techtician",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 5]] as const).map(([lvl, armor]) => [lvl, {
      statics: [{
        id: "center-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (self.lane === 2 && target.owner === self.owner && target.uid !== self.uid) {
            stats.keywords.push({ keyword: "Armor", value: armor });
          }
        },
      }],
    }]),
  ),
});

// --- Onyxium Marauder (Allied Nekrium: Regenerate N) ---
registerCard({
  defId: "onyxium-marauder",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "allied-regen",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => handHasFaction(game, self.owner, "Nekrium"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: n });
        },
      }],
    }]),
  ),
});

// --- Oreian Peacekeeper (Forge: gets Armor N this turn) ---
registerCard({
  defId: "oreian-peacekeeper",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 16]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "forge-armor",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor }, true);
        },
      }],
    }]),
  ),
});

// --- Palladium Hindermind (Forge: each enemy creature gets −N attack) ---
registerCard({
  defId: "palladium-hindermind",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-drain",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
          }
        },
      }],
    }]),
  ),
});

// --- Skyknight Glider (static: in the center space, it gets Mobility 2) ---
registerCard({
  defId: "skyknight-glider",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      statics: [{
        id: "center-mobility",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid === self.uid && self.lane === 2) {
            stats.keywords.push({ keyword: "Mobility", value: 2 });
          }
        },
      }],
    }]),
  ),
});

// --- Steelscale Dragon (static: while each other friendly creature has
//     Defender, gets +N attack, Armor N, and Breakthrough) ---
registerCard({
  defId: "steelscale-dragon",
  levels: Object.fromEntries(
    ([[1, 4, 2], [2, 8, 4], [3, 12, 6]] as const).map(([lvl, n, armor]) => [lvl, {
      statics: [{
        id: "phalanx",
        apply: (game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid !== self.uid) return;
          const others = game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && !isDead(c) && c.uid !== self.uid);
          if (!others.every((c) => hasKeyword(c, "Defender"))) return;
          stats.attack += n;
          stats.keywords.push({ keyword: "Armor", value: armor }, { keyword: "Breakthrough", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Steelwelder Medic (Activate: give another creature Armor N) ---
registerCard({
  defId: "steelwelder-medic",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, armor]) => [lvl, {
      activates: [{
        id: "weld",
        prompt: (game: Game, self: CreatureState) => {
          const options = boardCreatureUids(game, (c) => c.uid !== self.uid);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give another creature Armor ${armor}`, options };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.uid !== self.uid) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// technognome: vanilla, no script required.
// tower-scout: Mobility 1 keyword only, no script required.
// vault-blockade: Armor + Defender keywords only, no script required.

// ============================================================
// Spells
// ============================================================

// --- Cypien Steelgraft (two friendly creatures get Armor N) ---
registerCard({
  defId: "cypien-steelgraft",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, armor]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes.filter(Boolean).map((c) => c!.uid);
        if (!options.length) return null;
        return { kind: "friendlyCreature" as const, prompt: `Give a friendly creature Armor ${armor}`, options };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (ctx.priorAnswers.length === 0) return; // prompt found no targets: fizzle
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        if (ctx.priorAnswers.length >= 2) return; // both creatures chosen
        const firstUid = ctx.priorAnswers[0]?.targetUid;
        const rest = ctx.game.state.players[player].lanes
          .filter((x): x is CreatureState => !!x && x.uid !== firstUid)
          .map((x) => x.uid);
        if (!rest.length) return; // only one friendly creature
        return { kind: "friendlyCreature" as const, prompt: `Give a second friendly creature Armor ${armor}`, options: rest };
      },
    }]),
  ),
});

// --- Digitize (each enemy creature gets −N attack this turn) ---
registerCard({
  defId: "digitize",
  spell: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0, true);
        }
      },
    }]),
  ),
});

// --- Metatransfer (give a creature −N attack, then discard and level up a card) ---
registerCard({
  defId: "metatransfer",
  spell: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature −${n} attack`, options };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        // discard step (second answer carries handIndex)
        if (choice?.handIndex !== undefined) {
          discardAndLevel(ctx, player, choice.handIndex);
          return;
        }
        // debuff step (first answer carries targetUid; skipped when the board was empty)
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        const hand = ctx.game.state.players[player].hand;
        if (!hand.length) return;
        return {
          kind: "cardInHand" as const,
          prompt: "Discard and level up a card",
          options: hand.map((_, i) => i),
        };
      },
    }]),
  ),
});

// --- Overwhelming Force (each friendly creature gets +N attack; L3: 2X attack) ---
registerCard({
  defId: "overwhelming-force",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 2]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (!c) continue;
          const gain = lvl === 3 ? getStats(ctx.game, c).attack : n; // 2X attack
          if (gain) buffCreature(ctx.game, ctx.events, c, gain, 0);
        }
      },
    }]),
  ),
});

// --- Sap (reduce a level N-or-lower creature's attack to 0) ---
registerCard({
  defId: "sap",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, gate]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game, (c) => c.level <= gate);
        if (!options.length) return null;
        return {
          kind: "anyCreature" as const,
          prompt: gate === 99 ? "Reduce a creature's attack to 0" : `Reduce a level ${gate} or lower creature's attack to 0`,
          options,
        };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -getStats(ctx.game, c).attack, 0);
      },
    }]),
  ),
});
