/**
 * Set 1.5 card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set1):
 *  - Kas, Arcweaver: CreatureState.extraBattles is unused by the engine;
 *    emulated via state.battlesLeft += 1 per spell played (same as Zyx, Storm
 *    Herald / Call the Lightning in set1-tempys.ts) — the extra battle is a
 *    full additional combat phase for the player, not Kas-only.
 *  - Omnomnom: like Grave Pact, the spell fizzles unless both a friendly
 *    Zombie and an enemy non-Zombie are on board when it is played.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, destroyCreature, getStats, grantKeyword, spawnCreature,
} from "../effects.js";
import { findCreature, hasKeyword, opposing } from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function hasSubtype(game: Game, c: CreatureState, sub: string): boolean {
  return game.state.cards[c.defId]?.subtypes.includes(sub) ?? false;
}

function adjacentOpen(game: Game, p: PlayerId, lane: number): number[] {
  const pl = game.state.players[p];
  return [lane - 1, lane + 1].filter((i) => i >= 0 && i < 5 && !pl.lanes[i]);
}

function boardCreatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const side of game.state.players) {
    for (const c of side.lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  }
  return out;
}

/**
 * "Discard and level up a card" — the discardToLevel action as an effect (no
 * primitive exists for hand manipulation; same as levelUpHandCard in
 * set1-alloyin.ts). The leveled copy goes to the discard pile.
 */
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

// ============================================================
// Spells
// ============================================================

// --- Aegis Pulse (each friendly creature gets Armor N) ---
registerCard({
  defId: "aegis-pulse",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, armor]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        }
      },
    }]),
  ),
});

// --- Metasight (two-level spell; discard and level up 2 cards, Free at L2) ---
// Two chained cardInHand choices, one per discard (choice chain via
// ctx.priorAnswers, same shape as Grave Pact in set1-nekrium.ts).
registerCard({
  defId: "metasight",
  spell: Object.fromEntries(
    [1, 2].map((lvl) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const hand = game.state.players[player].hand;
        if (!hand.length) return null;
        return {
          kind: "cardInHand" as const,
          prompt: "Discard and level up a card",
          options: hand.map((_, i) => i),
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (choice?.handIndex === undefined) return;
        discardAndLevel(ctx, player, choice.handIndex);
        if (ctx.priorAnswers.length >= 2) return; // both discards done
        const hand = ctx.game.state.players[player].hand;
        if (!hand.length) return; // fewer than 2 cards to discard
        return {
          kind: "cardInHand" as const,
          prompt: "Discard and level up a card",
          options: hand.map((_, i) => i),
        };
      },
    }]),
  ),
});

// --- Noxious Cloud (each enemy creature gets Poison N) ---
registerCard({
  defId: "noxious-cloud",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        }
      },
    }]),
  ),
});

// --- Omnomnom (buff a friendly Zombie, then debuff an enemy non-Zombie) ---
registerCard({
  defId: "omnomnom",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const zombies = game.state.players[player].lanes
          .filter((c): c is CreatureState => !!c && hasSubtype(game, c, "Zombie"))
          .map((c) => c.uid);
        const foes = game.state.players[opposing(player)].lanes
          .filter((c): c is CreatureState => !!c && !hasSubtype(game, c, "Zombie"))
          .map((c) => c.uid);
        if (!zombies.length || !foes.length) return null; // needs both targets: fizzle
        return {
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly Zombie +${n} attack and +${n} health and Regenerate ${n}`,
          options: zombies,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (ctx.priorAnswers.length === 0) return; // prompt found no targets: fizzle
        if (ctx.priorAnswers.length === 1) {
          // step 1: buff the chosen Zombie, then chain the enemy debuff prompt
          const z = targetOf(ctx, choice);
          if (z) {
            buffCreature(ctx.game, ctx.events, z, n, n);
            grantKeyword(ctx.events, z, { keyword: "Regenerate", value: n });
          }
          const foes = ctx.game.state.players[opposing(player)].lanes
            .filter((c): c is CreatureState => !!c && !hasSubtype(ctx.game, c, "Zombie"))
            .map((c) => c.uid);
          if (!foes.length) return;
          return {
            kind: "enemyCreature" as const,
            prompt: `Give an enemy non-Zombie -${n} attack and -${n} health`,
            options: foes,
          };
        }
        const foe = targetOf(ctx, choice);
        if (foe) buffCreature(ctx.game, ctx.events, foe, -n, -n);
      },
    }]),
  ),
});

// --- Pyre Song (each friendly creature deals N damage to each enemy creature) ---
registerCard({
  defId: "pyre-song",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const friends = ctx.game.state.players[player].lanes.filter((c): c is CreatureState => !!c);
        const foes = ctx.game.state.players[opposing(player)].lanes.filter((c): c is CreatureState => !!c);
        for (const f of friends) {
          for (const e of foes) dealCreatureDamage(ctx.game, ctx.events, e, lvl, f);
        }
      },
    }]),
  ),
});

// --- Strength in Numbers (give a creature +N/+N for each friendly creature) ---
registerCard({
  defId: "strength-in-numbers",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return {
          kind: "anyCreature" as const,
          prompt: `Give a creature +${n} attack and +${n} health for each friendly creature`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        const count = ctx.game.state.players[player].lanes.filter(Boolean).length;
        if (count) buffCreature(ctx.game, ctx.events, c, n * count, n * count);
      },
    }]),
  ),
});

// ============================================================
// Creatures
// ============================================================

// --- Brighttusk Sower (Forge: you may put a token into an adjacent space) ---
registerCard({
  defId: "brighttusk-sower",
  levels: Object.fromEntries(
    ([[1, "seedling", "Seedling", 1], [2, "sapling", "Sapling", 3], [3, "treefolk", "Treefolk", 5]] as const)
      .map(([lvl, token, tokenName, n]) => [lvl, {
        abilities: [{
          id: "forge-sow",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) =>
            adjacentOpen(game, self.owner, self.lane).length
              ? { kind: "yesNo" as const, prompt: `Put a ${n}/${n} ${tokenName} into an adjacent space?`, optional: true }
              : null,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const spots = adjacentOpen(ctx.game, self.owner, self.lane);
            if (spots.length) {
              spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
                { lane: ctx.rng.pick(spots), overrideStats: { attack: n, health: n } });
            }
          },
        }],
      }]),
  ),
});

// --- Charnel Titan (Forge: if an enemy creature has <=N attack, gets +N/+N) ---
registerCard({
  defId: "charnel-titan",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-feed",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[opposing(self.owner)].lanes
            .some((c) => !!c && getStats(game, c).attack <= n),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Cypien Infiltrator (static: while it has N+ attack, it gets Breakthrough) ---
// Same threshold approximation as Hinterland Watchman / Lightshield Patrol in
// set1-alloyin.ts: the gate reads permanent attack + temp mods + the static
// bonuses accumulated so far this pass (getStats would recurse).
registerCard({
  defId: "cypien-infiltrator",
  levels: Object.fromEntries(
    ([[1, 7], [2, 14], [3, 21]] as const).map(([lvl, gate]) => [lvl, {
      statics: [{
        id: "high-attack",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid !== self.uid) return;
          const atk = target.attack + target.tempMods.reduce((s, m) => s + m.attack, 0) + stats.attack;
          if (atk >= gate) stats.keywords.push({ keyword: "Breakthrough", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Drix, The Mindwelder (Activate, discard your hand: each friendly
//     Metamind gets +N attack per card discarded) ---
registerCard({
  defId: "drix-the-mindwelder",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "mindweld",
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const count = pl.hand.length;
          for (const inst of pl.hand.splice(0)) {
            pl.discard.push(inst);
            ctx.events.push({ type: "discard", player: self.owner, defId: inst.defId, level: inst.level });
          }
          if (!count) return;
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && hasSubtype(ctx.game, c, "Metamind")) {
              buffCreature(ctx.game, ctx.events, c, n * count, 0);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Kas, Arcweaver (when you play a spell, Kas battles an additional time) ---
// NOTE: see header — emulated via battlesLeft += 1 (Zyx convention).
registerCard({
  defId: "kas-arcweaver",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "spellstrike",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.battlesLeft += 1;
        },
      }],
    }]),
  ),
});

// oreian-justicar: unscripted — see TODO in file header.

// --- Runescarred Zombie (Vengeance: return a random level-<=cap spell from
//     your discard pile to your hand) ---
// No GameEvent covers discard-to-hand; the move is silent (state-only).
registerCard({
  defId: "runescarred-zombie",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "vengeance-recover",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const pool = pl.discard
            .map((inst, i) => ({ inst, i }))
            .filter(({ inst }) => inst.level <= cap
              && (ctx.game.state.cards[inst.defId]?.types.includes("Spell") ?? false));
          if (!pool.length) return;
          const picked = ctx.rng.pick(pool);
          const [inst] = pl.discard.splice(picked.i, 1);
          pl.hand.push(inst!);
        },
      }],
    }]),
  ),
});

// tarsus-deathweaver: unscripted — see TODO in file header.

// --- Thundersaur (when dealt damage, gets +1 attack for each damage dealt) ---
registerCard({
  defId: "thundersaur",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "enrage",
        trigger: "damaged" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.amount) buffCreature(ctx.game, ctx.events, self, evt.amount, 0);
        },
      }],
    }]),
  ),
});

// --- Tower Vanguard (static: while it has Armor, it gets +N attack) ---
registerCard({
  defId: "tower-vanguard",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "armored-up",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid === self.uid && hasKeyword(target, "Armor")) stats.attack += n;
        },
      }],
    }]),
  ),
});

// --- Venomfang (Forge: give an enemy creature Poison N) ---
registerCard({
  defId: "venomfang",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-poison",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[opposing(self.owner)].lanes.filter(Boolean).map((c) => c!.uid);
          if (!options.length) return null;
          return { kind: "enemyCreature" as const, prompt: `Give an enemy creature Poison ${n}`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        },
      }],
    }]),
  ),
});

// --- Warbringer Uranti (Forge: give another friendly creature +N attack this turn) ---
registerCard({
  defId: "warbringer-uranti",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-rally",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].lanes
            .filter((c) => !!c && c.uid !== self.uid)
            .map((c) => c!.uid);
          if (!options.length) return null;
          return {
            kind: "friendlyCreature" as const,
            prompt: `Give another friendly creature +${n} attack this turn`,
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.uid !== self.uid) buffCreature(ctx.game, ctx.events, c, n, 0, true);
        },
      }],
    }]),
  ),
});

// --- Weirwood Patriarch (Forge: each friendly creature with <=gate attack gets +N/+N) ---
registerCard({
  defId: "weirwood-patriarch",
  levels: Object.fromEntries(
    ([[1, 3, 2], [2, 5, 3], [3, 7, 5]] as const).map(([lvl, gate, n]) => [lvl, {
      abilities: [{
        id: "forge-rally",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && getStats(ctx.game, c).attack <= gate) buffCreature(ctx.game, ctx.events, c, n, n);
          }
        },
      }],
    }]),
  ),
});

// --- Wildfire Maiden (Activate, destroy itself: deal its attack to each enemy creature) ---
registerCard({
  defId: "wildfire-maiden",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "immolate",
        resolve: (ctx: Ctx, self: CreatureState) => {
          const atk = getStats(ctx.game, self).attack;
          destroyCreature(ctx.game, ctx.events, self);
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, atk, self);
          }
        },
      }],
    }]),
  ),
});

// windborn-hellion: unscripted — see TODO in file header.

// --- Witherfrost Banshee (Forge/Flank: the opposing creature gets -N/-N) ---
registerCard({
  defId: "witherfrost-banshee",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 7]] as const).map(([lvl, n]) => {
      const hasOpposing = (game: Game, self: CreatureState) =>
        !!game.state.players[opposing(self.owner)].lanes[self.lane];
      const chill = (ctx: Ctx, self: CreatureState) => {
        const opp = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
        if (opp) buffCreature(ctx.game, ctx.events, opp, -n, -n);
      };
      return [lvl, {
        abilities: [
          { id: "forge-chill", trigger: "enterFromHand" as const, condition: hasOpposing, resolve: chill },
          { id: "flank-chill", trigger: "moved" as const, condition: hasOpposing, resolve: chill },
        ],
      }];
    }),
  ),
});

// --- Woebringer (at the start of your turn, destroy the lowest-attack
//     creature; L3: the lowest-attack enemy creature; ties at random) ---
registerCard({
  defId: "woebringer",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "cull",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const sides: PlayerId[] = lvl === 3 ? [opposing(self.owner)] : [0, 1];
          const pool: CreatureState[] = [];
          for (const s of sides) {
            for (const c of ctx.game.state.players[s].lanes) if (c) pool.push(c);
          }
          if (!pool.length) return;
          const min = Math.min(...pool.map((c) => getStats(ctx.game, c).attack));
          const tied = pool.filter((c) => getStats(ctx.game, c).attack === min);
          destroyCreature(ctx.game, ctx.events, ctx.rng.pick(tied));
        },
      }],
    }]),
  ),
});

// --- Zephyr Mage (Activate: give another level-<=cap creature Mobility N) ---
registerCard({
  defId: "zephyr-mage",
  levels: Object.fromEntries(
    ([[1, 1, 1], [2, 2, 2], [3, 99, 3]] as const).map(([lvl, cap, n]) => [lvl, {
      activates: [{
        id: "grant-mobility",
        prompt: (game: Game, self: CreatureState) => {
          const options = boardCreatureUids(game, (c) => c.uid !== self.uid && c.level <= cap);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give another creature Mobility ${n}`, options };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.uid !== self.uid) grantKeyword(ctx.events, c, { keyword: "Mobility", value: n });
        },
      }],
    }]),
  ),
});

// --- Oreian Justicar (enemy creature enters play un-Forged -> -N attack) ---
// Engine support: anyCreatureEnterPlay broadcasts every entry with evt.fromHand.
registerCard({
  defId: "oreian-justicar",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 20]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "intimidate",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner !== self.owner && evt.fromHand === false,
        resolve: (ctx: Ctx, _self: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        },
      }],
    }]),
  ),
});

// --- Tarsus Deathweaver (friendly creature enters play un-Forged -> +N/+N) ---
registerCard({
  defId: "tarsus-deathweaver",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "weave",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.fromHand === false,
        resolve: (ctx: Ctx, _self: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Windborn Hellion (when a friendly creature moves -> +N/+N) ---
registerCard({
  defId: "windborn-hellion",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "tailwind-self",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
        {
          id: "tailwind",
          trigger: "friendlyCreatureMoved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
      ],
    }]),
  ),
});
