/**
 * Set 6 (Darkforge Uprising) + 6.1 + 6.2 — Uterra card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set5-uterra.ts / set6-nekrium.ts):
 *  - Tremorsaur: "When you are dealt damage" is hooked only for BATTLE damage
 *    (anyBattleDamageToPlayer, fired on the damaged player's creatures with
 *    evt.targetPlayer = the damaged player). Non-battle damage to a player
 *    (spells, effects) fires no trigger at all — pushDamageTriggers only
 *    broadcasts player damage when battle=true. Engine gap; TODO: board-wide
 *    broadcast for non-battle player damage carrying the amount.
 *  - Grapplevine: "Negate Mobility from each creature" (no trigger word) is a
 *    continuous effect. StaticAbility cannot remove keywords, so it is modeled
 *    as value swamping: the static pushes Mobility -100 into every creature's
 *    staticKeywords, and the engine gates movement on keywordValue > 0
 *    (game.ts), so nothing can move while Grapplevine is in play (and a
 *    silenced/dead Grapplevine stops negating). Corners: hasKeyword(c,
 *    "Mobility") still reports true (Tangle's targeting filter in
 *    set3-uterra.ts would still see it), and anything reading the Mobility
 *    VALUE sees a negative number — no current script does.
 *  - Shroudthorn Splicer: the text has no "another" (contrast Dusk Hammer /
 *    Shadeclaw Zombie), so by the letter its own Forge should also Spawn a
 *    Darkforged Mimic — but the engine's anyCreatureEnterPlay broadcast
 *    excludes the entering creature itself (spawnCreature only collects the
 *    event for OTHER creatures), so in practice only other friendly Forged
 *    Darkforged trigger it. Engine limitation; noted, not worked around. The
 *    Mimic is the real Set 6 token (2/3, 6/7, 10/11 — matching the Splicer's
 *    level stats), Spawned at the Splicer's level in a random open space; it
 *    enters un-Forged, so it never chains.
 *  - Darkroot Shambler: "each friendly Darkforged" includes the Shambler
 *    itself (it is already in play when the Forge resolves — Darkshard Witch
 *    convention, set6-nekrium.ts).
 *  - Patron of Deepwood: "an adjacent space" is a random adjacent open space
 *    (Echowisp convention, set1-uterra.ts). The copy enters un-Forged, so it
 *    does not chain its own Forge.
 *  - Othra, Apex Predator: rankGained fires during the ranking player's
 *    endTurn while they are still active (Frostmane Egg convention,
 *    set3-tempys.ts); the replace is a fresh copy at the next level.
 *  - Dream Tree: "and survives" is checked at collect time via
 *    isDeadEffective (damage is already marked when the damaged trigger is
 *    collected); the extra play is an unrestricted playsLeft += 1 (Necroflay
 *    convention, set4-nekrium.ts).
 *  - Rubyscale Dragon: "you ... gets +N health" is healPlayer (Toorgmai
 *    Mender convention), so it fires playerHealed and the Ambush heal watch;
 *    creatures get a permanent +health buff (Lysian Rain convention), which
 *    does NOT fire creatureHealed — Vigorwisp never chains off it.
 *  - Vigorwisp: creatureHealed covers actual heals only (including Regenerate
 *    ticks); "+N health" buffs do not fire it (Everflow Eidolon convention).
 *  - Enduring Vitality: "You get, 'When a friendly Uterra creature enters
 *    play, it gets +1 attack and +1 health.'" is a permanent player effect
 *    (registry ref uterra:enduring-vitality). The anyCreatureEnterPlay
 *    broadcast is dispatched per-creature (collectFor), never through
 *    collectAll, so player effects cannot see it; the trigger is approximated
 *    with creaturePlayed, which covers Forged creatures only. Corner:
 *    un-Forged (Spawned) friendly Uterra creatures do not get the buff.
 *    Overload is an engine keyword (the card is still removed).
 *  - Subtype matching: the scraper stores combined subtype strings
 *    ("Darkforged Plant"), so Darkforged/Dinosaur/Dragon membership is a word
 *    match (set6-nekrium.ts convention).
 */
import { registerCard, registerGranted, registerPlayerEffect } from "./registry.js";
import {
  addPlayerEffect, buffCreature, destroyCreature, grantKeyword, healCreature, healPlayer,
  isDeadEffective, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Game } from "../game.js";
import type { Ability, ChoiceAnswer, ChoiceRequest, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

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

/** Open spaces adjacent to a lane (same side). */
function adjacentOpen(game: Game, p: PlayerId, lane: number): number[] {
  const pl = game.state.players[p];
  return [lane - 1, lane + 1].filter((i) => i >= 0 && i < 5 && !pl.lanes[i]);
}

/** Word-match against combined subtype strings ("Darkforged Plant" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

function isDarkforged(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Darkforged");
}

// ---------- granted abilities ----------

// Shardplate Graft: the target gets "At the start of your turn, this gets
// +N attack and +N health." Stacks when applied multiple times.
for (const n of [2, 4, 6] as const) {
  registerGranted(`uterra:shardplate-graft-${n}`, {
    id: `uterra:shardplate-graft-${n}`,
    trigger: "turnStart",
    condition: (game, self) => game.state.active === self.owner,
    resolve(ctx, self) {
      buffCreature(ctx.game, ctx.events, self, n, n);
    },
  });
}

// ============================================================
// Creatures
// ============================================================

// --- Darkroot Shambler: Forge — give a friendly creature +N health for each
//     friendly Darkforged (itself included — see header). ---
registerCard({
  defId: "darkroot-shambler",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-darkroot",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Give a friendly creature +${n} health for each friendly Darkforged`,
          "friendlyCreature",
          friendlyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== self.owner) return;
          const count = ctx.game.state.players[self.owner].lanes
            .filter((x): x is CreatureState => !!x && isDarkforged(ctx.game, x.defId))
            .length;
          if (count > 0) buffCreature(ctx.game, ctx.events, c, 0, n * count);
        },
      }],
    }]),
  ),
});

// --- Dragon Slayer: Forge — destroy an enemy level-capped Dragon
//     (L1: level 1; L2: level 2 or lower; L3: any). ---
registerCard({
  defId: "dragon-slayer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-slay-dragon",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          cap >= 99
            ? "Destroy an enemy Dragon"
            : cap === 1
              ? "Destroy an enemy level 1 Dragon"
              : `Destroy an enemy level ${cap} or lower Dragon`,
          "enemyCreature",
          friendlyUids(game, opposing(self.owner),
            (c) => c.level <= cap && hasSubtype(game, c.defId, "Dragon")),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== opposing(self.owner)) return;
          if (c.level > cap || !hasSubtype(ctx.game, c.defId, "Dragon")) return; // re-validate
          destroyCreature(ctx.game, ctx.events, c);
        },
      }],
    }]),
  ),
});

// --- Dream Tree: when it is dealt damage and survives on your turn, you may
//     play an additional card this turn (Defender / L3 Regenerate 5 inherent). ---
registerCard({
  defId: "dream-tree",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "dream-damage",
        trigger: "damaged" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.active === self.owner && !isDeadEffective(game, self),
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += 1;
        },
      }],
    }]),
  ),
});

// --- Dusk Hammer: Breakthrough (inherent); when another friendly Darkforged
//     enters play, Dusk Hammer gets +N/+N. ---
registerCard({
  defId: "dusk-hammer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "darkforged-growth",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceUid !== self.uid
          && !!evt.sourceDefId && isDarkforged(game, evt.sourceDefId),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Grapplevine: continuous — Negate Mobility from each creature (value
//     swamping via a static -100 Mobility; see header note). ---
registerCard({
  defId: "grapplevine",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      statics: [{
        id: "negate-mobility",
        apply: (_g: Game, _s: CreatureState, _t: CreatureState, out: StaticOut) => {
          out.keywords.push({ keyword: "Mobility", value: -100 });
        },
      }],
    }]),
  ),
});

// --- Mosstodon: Forge — each other friendly Dinosaur gets +N health. ---
registerCard({
  defId: "mosstodon",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-dinosaur-rally",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid && hasSubtype(ctx.game, c.defId, "Dinosaur")) {
              buffCreature(ctx.game, ctx.events, c, 0, n);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Othra, Apex Predator: L1/L2 — when you gain a Rank, replace this with
//     the next-level Othra. L3 — battle damage to a creature or player gives
//     them Poison 10 (L2 Defender / L3 Mobility 1 inherent). ---
function othraRankUp(): { abilities: Ability[] } {
  return {
    abilities: [{
      id: "apex-evolve",
      trigger: "rankGained" as const,
      // rankGained fires during the ranking player's endTurn, while they are still active
      condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
      resolve: (ctx: Ctx, self: CreatureState) => {
        spawnCreature(ctx.game, ctx.events, self.owner, "othra-apex-predator", self.level + 1,
          { lane: self.lane, replace: true });
      },
    }],
  };
}
registerCard({
  defId: "othra-apex-predator",
  levels: {
    1: othraRankUp(),
    2: othraRankUp(),
    3: {
      abilities: [
        {
          id: "apex-poison-player",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
            if (evt.targetPlayer === undefined) return;
            ctx.game.state.players[evt.targetPlayer].poison += 10; // silent: no GameEvent
          },
        },
        {
          id: "apex-poison-creature",
          trigger: "battleDamageToCreature" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            if (evt.lane === undefined) return;
            const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
            if (t) grantKeyword(ctx.events, t, { keyword: "Poison", value: 10 });
          },
        },
      ],
    },
  },
});

// --- Shroudthorn Splicer: when a friendly Darkforged enters play, if it was
//     Forged, Spawn a Darkforged Mimic at the Splicer's level (its own Forge
//     included — see header). ---
registerCard({
  defId: "shroudthorn-splicer",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "splice-mimic",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.fromHand === true
          && !!evt.sourceDefId && isDarkforged(game, evt.sourceDefId),
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "darkforged-mimic", self.level,
            { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Tremorsaur: when you are dealt (battle) damage, Tremorsaur gets
//     +attack equal to the damage dealt (L3: twice) — see header note. ---
registerCard({
  defId: "tremorsaur",
  levels: Object.fromEntries(
    ([[1, 1], [2, 1], [3, 2]] as const).map(([lvl, mult]) => [lvl, {
      abilities: [{
        id: "tremor-growth",
        trigger: "anyBattleDamageToPlayer" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.targetPlayer === self.owner,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const dealt = evt.amount ?? 0;
          if (dealt > 0) buffCreature(ctx.game, ctx.events, self, dealt * mult, 0);
        },
      }],
    }]),
  ),
});

// --- Vigorwisp: when Vigorwisp gains health (actual heals only — see
//     header), heal that much damage from each other friendly creature. ---
registerCard({
  defId: "vigorwisp",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "vigor-pulse",
        trigger: "creatureHealed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const healed = evt.amount ?? 0;
          if (healed <= 0) return;
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid) healCreature(ctx.game, ctx.events, c, healed);
          }
        },
      }],
    }]),
  ),
});

// --- Patron of Deepwood: Forge — with 3+ Uterra cards in hand, you may put
//     a copy of Patron of Deepwood into an adjacent space (random if both
//     are open — Echowisp convention). ---
registerCard({
  defId: "patron-of-deepwood",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-deepwood-copy",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand
            .filter((inst) => game.state.cards[inst.defId]?.faction === "Uterra")
            .length >= 3,
        prompt: (game: Game, self: CreatureState) =>
          adjacentOpen(game, self.owner, self.lane).length
            ? {
              kind: "yesNo" as const,
              prompt: "Put a copy of Patron of Deepwood into an adjacent space?",
              optional: true,
            }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const spots = adjacentOpen(ctx.game, self.owner, self.lane);
          if (spots.length) {
            spawnCreature(ctx.game, ctx.events, self.owner, "patron-of-deepwood", self.level,
              { lane: ctx.rng.pick(spots) });
          }
        },
      }],
    }]),
  ),
});

// --- Rubyscale Dragon: at the end of your turn, you and each other friendly
//     creature get +N health (Defender L1 / Mobility 1 L2-L3 inherent). ---
registerCard({
  defId: "rubyscale-dragon",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "endure",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid) buffCreature(ctx.game, ctx.events, c, 0, n);
          }
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Blood Boon: give a creature +N/+N, plus an extra +N/+N if a creature
//     was destroyed this turn (either side — Blood Bindings convention). ---
registerCard({
  defId: "blood-boon",
  spell: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${n} attack and +${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        if (ctx.game.state.deathLog.length > 0) { // any creature, either side, this turn
          buffCreature(ctx.game, ctx.events, c, n, n);
        }
      },
    }]),
  ),
});

// --- Verdant Sphere: give a creature +N health and you gain N health. ---
registerCard({
  defId: "verdant-sphere",
  spell: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${n} health and you gain ${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, 0, n);
        healPlayer(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});

// --- Shardplate Graft: give a friendly creature +N/+N and, "At the start of
//     your turn, this gets +N attack and +N health" (granted ability — see
//     the registry above). ---
registerCard({
  defId: "shardplate-graft",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature +${n} attack and +${n} health and "At the start of your turn, this gets +${n} attack and +${n} health"`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        c.grantedAbilities.push(`uterra:shardplate-graft-${n}`);
      },
    }]),
  ),
});

// --- Enduring Vitality: "You get, 'When a friendly Uterra creature enters
//     play, it gets +1 attack and +1 health.'" — a permanent player effect.
//     The anyCreatureEnterPlay broadcast is dispatched per-creature
//     (collectFor), never through collectAll, so player effects cannot see
//     it; the trigger is approximated with creaturePlayed (collectAll), which
//     covers Forged creatures only. Corner: un-Forged (Spawned) friendly
//     Uterra creatures do not get the buff. Overload is an engine keyword. ---
registerPlayerEffect("uterra:enduring-vitality", {
  trigger: "creaturePlayed",
  condition: (game: Game, player: PlayerId, evt: TriggerPayload) =>
    evt.sourceOwner === player
    && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Uterra",
  resolve: (ctx: Ctx, player: PlayerId, evt: TriggerPayload) => {
    // creaturePlayed's evt.sourceUid is the LISTENER's uid (the player
    // pseudo-uid here); the played creature is identified by defId + lane.
    const c = evt.lane !== undefined ? ctx.game.state.players[player].lanes[evt.lane] : null;
    if (c && c.defId === evt.sourceDefId) buffCreature(ctx.game, ctx.events, c, 1, 1);
  },
});
registerCard({
  defId: "enduring-vitality",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        addPlayerEffect(ctx.game, ctx.events, player, "uterra:enduring-vitality", null);
      },
    },
  },
});
