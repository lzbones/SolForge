/**
 * Set 2 (Rise of the Forgeborn) Nekrium card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set1-nekrium.ts):
 *  - Onyxium Phantasm's Allied grants an ACTIVATE; the engine's grantedAbilities
 *    only carry triggered abilities, so the Forge trigger pushes a sentinel ref
 *    ("set2-nekrium:phantasm-allied", deliberately unregistered — collectFor
 *    skips refs with no granted ability) that the Activate's condition checks.
 *  - Xrath's Will's "play an additional Zombie this turn" grants an unrestricted
 *    extra play (playsLeft += 1): legalActions cannot gate the bonus play by
 *    subtype (same gap as Soul Harvest L1 in set1-nekrium.ts).
 *  - Varna's Pact's "creature that was destroyed this game" is approximated as a
 *    creature-type, non-Token card in either player's discard pile (same as
 *    Lyria, Muse of Varna; leveled and discard-to-level copies pollute the pool).
 *  - Xithian Rotfiend triggers when it becomes opposed: an enemy entering its
 *    lane (anyCreatureEnterPlay covers both Forged plays and tokens), being
 *    played into an opposed lane, or moving into one. An ENEMY moving into its
 *    lane is not observable (moved broadcasts only reach the mover's side) —
 *    engine gap.
 *  - Ghastly Renewal picks its two targets sequentially; the granted Regenerate
 *    REPLACES any Regenerate the creature already has (negate-then-grant — a
 *    Cavern Hydra given Regenerate 2 ends at Regenerate 2, not 3). With a
 *    single friendly creature on board it grants only once (no second target).
 *  - Shallow Grave reuses set1's shared:vengeance-spawn-self +
 *    nekrium:keeper-expire ("this turn" expiration via a granted turnEnd cleanup).
 *  - Spirit Reaver is a Set 2.2 card; its "when the enemy player gains
 *    health" trigger rides the engine's playerHealed broadcast (this file is
 *    the first to script a 2.2 card — there is no set22 file yet).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealPlayerDamage, destroyCreature, getStats, grantKeyword, healPlayer, negateKeyword,
  spawnCreature,
} from "../effects.js";
import { findCreature, opposing, type CardInstance, type CreatureState, type PlayerId } from "../state.js";
import { isCreature, type Faction } from "../types.js";
import type { Game } from "../game.js";
import type { Ability, ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function req(prompt: string, kind: ChoiceRequest["kind"], options: number[], optional = false): Omit<ChoiceRequest, "id"> | null {
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
  for (const side of game.state.players) {
    for (const c of side.lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  }
  return out;
}

function hasFactionInHand(game: Game, p: PlayerId, faction: Faction): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

/** Creature cards that left play this game (Varna's Pact pool — see header note). */
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

// ============================================================
// Creatures
// ============================================================

// --- Byzerak Drake: Allied Tempys — gets Mobility N (Regenerate N is inherent). ---
registerCard({
  defId: "byzerak-drake",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "allied-mobility",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Tempys"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Mobility", value: lvl });
        },
      }],
    }]),
  ),
});

// --- Cercee, Hand of Varna: battle damage to a level-<=cap creature destroys
//     it (L4: any creature + player-kill). Mobility 1 is inherent. ---
function cerceeSlay(cap: number): Ability {
  return {
    id: "slay",
    trigger: "battleDamageToCreature",
    resolve(ctx, self, evt) {
      if (evt.lane === undefined) return;
      const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
      if (t && t.level <= cap) destroyCreature(ctx.game, ctx.events, t);
    },
  };
}
registerCard({
  defId: "cercee-hand-of-varna",
  levels: {
    1: { abilities: [cerceeSlay(1)] },
    2: { abilities: [cerceeSlay(2)] },
    3: { abilities: [cerceeSlay(99)] },
    4: {
      abilities: [
        cerceeSlay(99),
        {
          id: "execution",
          trigger: "battleDamageToPlayer",
          resolve(ctx, _self, evt) {
            const pid = evt.targetPlayer;
            if (pid === undefined) return;
            // NOT battle damage: avoids re-triggering this ability.
            const health = ctx.game.state.players[pid].health;
            if (health > 0) dealPlayerDamage(ctx.game, ctx.events, pid, health);
          },
        },
      ],
    },
  },
});

// --- Corpulent Shambler: Vengeance — put a 3/3 Zombie into this space. ---
registerCard({
  defId: "corpulent-shambler",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-zombie",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "zombie", 1,
            { lane: evt.lane ?? "random", overrideStats: { attack: 3, health: 3 } });
        },
      }],
    }]),
  ),
});

// --- Crypt Conjurer: when you play a Nekrium spell, deal N to the enemy player
//     and you gain N health. ---
registerCard({
  defId: "crypt-conjurer",
  levels: Object.fromEntries(
    ([[1, 2], [2, 5], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "spell-drain",
        trigger: "spellPlayed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Nekrium",
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n);
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Darkfrost Reaper: Forge — destroy each creature with 1 or less attack. ---
registerCard({
  defId: "darkfrost-reaper",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-reap",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx) => {
          for (const side of ctx.game.state.players) {
            for (const c of side.lanes) {
              if (c && getStats(ctx.game, c).attack <= 1) destroyCreature(ctx.game, ctx.events, c);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Ebonskull Knight: when you gain a Rank, destroy it. ---
registerCard({
  defId: "ebonskull-knight",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "rank-up-die",
        trigger: "rankGained" as const,
        // rankGained fires during the ranking player's endTurn, before active switches.
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          destroyCreature(ctx.game, ctx.events, self);
        },
      }],
    }]),
  ),
});

// --- Gloomfiend: Forge — you may give an enemy creature -N/-N. ---
registerCard({
  defId: "gloomfiend",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `You may give an enemy creature -${n} attack and -${n} health`,
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
});

// --- Gloomspire Wurm: Forge — if there are no enemy creatures, +4/+4. ---
registerCard({
  defId: "gloomspire-wurm",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-grow",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[opposing(self.owner)].lanes.every((c) => !c),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, 4, 4);
        },
      }],
    }]),
  ),
});

// --- Nightgaunt: when a creature is destroyed, it gets Regenerate 1. ---
registerCard({
  defId: "nightgaunt",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "death-regen",
        trigger: "anyCreatureDestroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: 1 });
        },
      }],
    }]),
  ),
});

// --- Nyrali Ooze: Vengeance — put an N/N Oozeling into this space. ---
registerCard({
  defId: "nyrali-ooze",
  levels: Object.fromEntries(
    ([[1, 4], [2, 7], [3, 11]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-oozeling",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "oozeling-green", 1,
            { lane: evt.lane ?? "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Onyxium Phantasm: Allied Alloyin — gains "Activate: target creature gets
//     -N attack" (Regenerate N is inherent). See header note for the sentinel. ---
const PHANTASM_ALLIED = "set2-nekrium:phantasm-allied";
registerCard({
  defId: "onyxium-phantasm",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "allied-grant",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Alloyin"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (!self.grantedAbilities.includes(PHANTASM_ALLIED)) self.grantedAbilities.push(PHANTASM_ALLIED);
        },
      }],
      activates: [{
        id: "wither",
        condition: (_game: Game, self: CreatureState) => self.grantedAbilities.includes(PHANTASM_ALLIED),
        prompt: (game: Game) => req(
          `Give a creature -${n} attack`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        },
      }],
    }]),
  ),
});

// --- Organ Harvester: Activate, destroy itself — destroy a level-<=cap creature. ---
registerCard({
  defId: "organ-harvester",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      activates: [{
        id: "harvest",
        condition: (game: Game) => boardUids(game, (c) => c.level <= cap).length > 0,
        prompt: (game: Game) => req(
          cap === 99
            ? "Destroy a creature"
            : `Destroy a level ${cap}${cap === 2 ? " or lower" : ""} creature`,
          "anyCreature",
          boardUids(game, (c) => c.level <= cap),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
          destroyCreature(ctx.game, ctx.events, self);
        },
      }],
    }]),
  ),
});

// --- Spirit Reaver (Set 2.2): when the enemy player gains health, it gets +N/+N. ---
registerCard({
  defId: "spirit-reaver",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "enemy-heal-grow",
        trigger: "playerHealed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.targetPlayer === opposing(self.owner),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Xithian Rotfiend: when it becomes opposed, it gets -N/-N. ---
registerCard({
  defId: "xithian-rotfiend",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => {
      const debuff = (ctx: Ctx, self: CreatureState) => {
        buffCreature(ctx.game, ctx.events, self, -n, -n);
      };
      const isOpposed = (game: Game, self: CreatureState) => !!opposingCreature(game, self);
      return [lvl, {
        abilities: [
          // played into an opposed space
          { id: "forge-opposed", trigger: "enterFromHand" as const, condition: isOpposed, resolve: debuff },
          // moved into an opposed space
          { id: "move-opposed", trigger: "moved" as const, condition: isOpposed, resolve: debuff },
          // an enemy creature entered the opposing space (play or token)
          {
            id: "enemy-opposed",
            trigger: "anyCreatureEnterPlay" as const,
            condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
              evt.sourceOwner !== undefined && evt.sourceOwner !== self.owner && evt.lane === self.lane,
            resolve: debuff,
          },
        ],
      }];
    }),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Death Current: destroy (two at L3) (level-<=2 at L1) enemy creatures at random. ---
registerCard({
  defId: "death-current",
  spell: Object.fromEntries(
    ([[1, 2, 1], [2, 99, 1], [3, 99, 2]] as const).map(([lvl, cap, count]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pool = ctx.game.state.players[opposing(player)].lanes
          .filter((c): c is CreatureState => !!c && c.level <= cap);
        if (!pool.length) return;
        for (const c of ctx.rng.shuffle([...pool]).slice(0, count)) {
          destroyCreature(ctx.game, ctx.events, c);
        }
      },
    }]),
  ),
});

// --- Ghastly Renewal: give two friendly creatures Regenerate N (two-step chain).
//     The grant overrides existing Regenerate (see header note). ---
function grantRegen(ctx: Ctx, c: CreatureState, n: number): void {
  negateKeyword(ctx.events, c, "Regenerate");
  grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
}
registerCard({
  defId: "ghastly-renewal",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature Regenerate ${n}`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // no friendly creature: fizzle
        if (ctx.priorAnswers.length < 2) {
          // step 1: grant the first target, then chain the second prompt
          const first = findCreature(ctx.game.state, firstUid);
          if (first && first.owner === player) grantRegen(ctx, first, n);
          const rest = friendlyUids(ctx.game, player, (c) => c.uid !== firstUid);
          if (!rest.length) return; // only one friendly creature: granted once
          return {
            kind: "friendlyCreature" as const,
            prompt: `Give another friendly creature Regenerate ${n}`,
            options: rest,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const second = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (second && second.owner === player) grantRegen(ctx, second, n);
      },
    }]),
  ),
});

// --- Group Meal: each enemy creature gets -N attack; each friendly creature +N. ---
registerCard({
  defId: "group-meal",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        }
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
        }
      },
    }]),
  ),
});

// --- Shallow Grave: give a (level-<=2 at L1) friendly creature "Vengeance:
//     Spawn this" this turn (Free at L3 — engine keyword). ---
registerCard({
  defId: "shallow-grave",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        cap === 99
          ? "Give a friendly creature \"Vengeance: Spawn this\" this turn"
          : "Give a level 2 or lower friendly creature \"Vengeance: Spawn this\" this turn",
        "friendlyCreature",
        friendlyUids(game, player, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.grantedAbilities.push("shared:vengeance-spawn-self", "nekrium:keeper-expire");
      },
    }]),
  ),
});

// --- Spiritleash: destroy a friendly creature, then give a creature +N/+N.
//     Two-step choice: the friendly sacrifice first, then the buff target. ---
registerCard({
  defId: "spiritleash",
  spell: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        "Destroy a friendly creature",
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // no friendly creature: fizzle
        if (ctx.priorAnswers.length < 2) {
          // step 1: destroy the chosen friendly creature, then chain prompt 2.
          // The sacrifice is only marked dead (removal at batch end), so it is
          // excluded from the buff options explicitly.
          const sacrifice = findCreature(ctx.game.state, firstUid);
          if (sacrifice && sacrifice.owner === player) destroyCreature(ctx.game, ctx.events, sacrifice);
          const options = boardUids(ctx.game, (c) => c.uid !== firstUid);
          if (!options.length) return;
          return {
            kind: "anyCreature" as const,
            prompt: `Give a creature +${n} attack and +${n} health`,
            options,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const target = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (target) buffCreature(ctx.game, ctx.events, target, n, n);
      },
    }]),
  ),
});

// --- Varna's Pact: put N random creature(s) destroyed this game into your spaces. ---
registerCard({
  defId: "varnas-pact",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pool = destroyedPool(ctx.game);
        if (!pool.length) return;
        for (let i = 0; i < lvl; i++) { // with replacement: may copy the same card
          const pick = ctx.rng.pick(pool);
          if (!spawnCreature(ctx.game, ctx.events, player, pick.defId, pick.level, { lane: "random" })) return;
        }
      },
    }]),
  ),
});

// --- Vyric's Embrace: give a creature -N/-N; you gain N health. ---
registerCard({
  defId: "vyrics-embrace",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, -n, -n);
        healPlayer(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});

// --- Xrath's Will: destroy an enemy creature with <=N attack; you may play an
//     additional Zombie this turn (unrestricted extra play — see header note). ---
registerCard({
  defId: "xraths-will",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Destroy an enemy creature with ${n} or less attack`,
        "enemyCreature",
        enemyUids(game, player, (c) => getStats(game, c).attack <= n),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        destroyCreature(ctx.game, ctx.events, c);
        ctx.game.state.playsLeft += 1;
      },
    }]),
  ),
});
