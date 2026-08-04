/**
 * Set 2 (Rise of the Forgeborn) Tempys card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set1-tempys.ts / set2-nekrium.ts):
 *  - Byzerak Spitemage's Allied grants a triggered ability; it reuses the
 *    nekrium:blight-{cap} granted abilities registered in set1-nekrium.ts
 *    (identical rules text to Touch of Blight).
 *  - Glaceus's granted "When this is dealt damage, destroy it." reuses
 *    tempys:frozen-solid from set1-tempys.ts (identical rules text).
 *  - Binben's spawned Lightning Elemental is destroyed via a granted turnEnd
 *    ability (tempys:set2-binben-expire) so Binben is self-contained; the
 *    token's own script belongs to the unowned Tempys token batch.
 *  - Uranti Icemage's "Negate Defender this turn" is modeled as a permanent
 *    negateKeyword plus a granted turnEnd restore (inverse of the Uranti Bolt
 *    pattern); targets whose Defender comes only from static abilities are
 *    excluded (negateKeyword cannot touch staticKeywords).
 *  - Uranti Heartseeker follows the scraped text literally: the damage stays
 *    4 at every level while only the "exactly N health" gate scales (4/9/15).
 *    The flat 4 looks like a scrape artifact (N damage would kill the target)
 *    but text1..3 are the project's source of truth.
 *  - Thundergale Invoker: "adjacent" means the spaces next to it on its own
 *    side (opposing spaces are never "adjacent"); the moveCreature primitive
 *    no-ops when the destination is blocked or off-board ("if possible").
 *  - Glacial Crush L3: "its health" is read as the target's remaining
 *    effective health at resolution.
 *  - Yeti tribal matching is word-based: "Earth Yeti" counts as a Yeti
 *    (subtypes are stored as one string, e.g. "Earth Yeti").
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, destroyCreature,
  getStats, grantKeyword, moveCreature, negateKeyword, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Faction } from "../types.js";
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

/** Word-based subtype match: "Earth Yeti" is a Yeti (see header note). */
function hasSubtype(game: Game, c: CreatureState, sub: string): boolean {
  return (game.state.cards[c.defId]?.subtypes ?? []).some((s) => s.split(" ").includes(sub));
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

// ---------- granted abilities ----------

// Binben's Lightning Elemental: "At the end of your turn, destroy it."
registerGranted("tempys:set2-binben-expire", {
  id: "tempys:set2-binben-expire",
  trigger: "turnEnd",
  condition: (game, self) => game.state.active === self.owner,
  resolve(ctx, self) {
    destroyCreature(ctx.game, ctx.events, self);
  },
});

// Uranti Icemage: restore the Defender negated "this turn" (see header note).
registerGranted("tempys:set2-defender-restore", {
  id: "tempys:set2-defender-restore",
  trigger: "turnEnd",
  resolve(ctx, self) {
    grantKeyword(ctx.events, self, { keyword: "Defender", value: 0 });
    self.grantedAbilities = self.grantedAbilities.filter((r) => r !== "tempys:set2-defender-restore");
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Ashurian Brawler (battle damage to a player -> +N/+N) ---
registerCard({
  defId: "ashurian-brawler",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "grow",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Binben, Lightning Herald (spellPlayed -> Spawn Lightning Elemental that
//     dies at end of your turn) ---
registerCard({
  defId: "binben-lightning-herald",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "lightning-harvest",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // Token levels 4/2, 7/5, 11/8 match Binben's spawned stats exactly.
          const token = spawnCreature(ctx.game, ctx.events, self.owner, "lightning-elemental", self.level, {});
          if (token) token.grantedAbilities.push("tempys:set2-binben-expire");
        },
      }],
    }]),
  ),
});

// --- Byzerak Spitemage (Allied Nekrium: gains "battle damage to a
//     level-<=cap creature destroys it") ---
registerCard({
  defId: "byzerak-spitemage",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "allied-nekrium",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Nekrium"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const ref = `nekrium:blight-${cap}`;
          if (!self.grantedAbilities.includes(ref)) self.grantedAbilities.push(ref);
        },
      }],
    }]),
  ),
});

// --- Cloudcleaver Titan (static: +N attack while unopposed) ---
registerCard({
  defId: "cloudcleaver-titan",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "unopposed-might",
        apply: (game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid === self.uid && !opposingCreature(game, self)) stats.attack += n;
        },
      }],
    }]),
  ),
});

// --- Emberwind Evoker (when a friendly creature moves, IT gets +N/+N) ---
registerCard({
  defId: "emberwind-evoker",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        { // the evoker itself moved (friendlyCreatureMoved skips the mover)
          id: "tailwind-self",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
        {
          id: "tailwind",
          trigger: "friendlyCreatureMoved" as const,
          resolve: (ctx: Ctx, _self: CreatureState, evt: TriggerPayload) => {
            const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
            if (c) buffCreature(ctx.game, ctx.events, c, n, n);
          },
        },
      ],
    }]),
  ),
});

// --- Flamefury Shaman (Activate: give a creature +N attack this turn) ---
registerCard({
  defId: "flamefury-shaman",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "flamefury",
        prompt: (game: Game) =>
          req(`Give a creature +${n} attack this turn`, "anyCreature", boardUids(game)),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0, true);
        },
      }],
    }]),
  ),
});

// --- Glaceus, Tundra Tyrant (rankGained: enemy level-<=cap creatures get
//     "when dealt damage, destroy it"; L3 pings each enemy each turn start) ---
registerCard({
  defId: "glaceus-tundra-tyrant",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => {
      const abilities: Ability[] = [{
        id: "deep-freeze",
        trigger: "rankGained" as const,
        // rankGained fires during the active player's endTurn: the rank is
        // always gained by the active player.
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c && c.level <= cap && !c.grantedAbilities.includes("tempys:frozen-solid")) {
              c.grantedAbilities.push("tempys:frozen-solid");
            }
          }
        },
      }];
      if (lvl === 3) {
        abilities.push({
          id: "tundra-aura",
          // "at the start of each turn" — both players' turns, no owner gate
          trigger: "turnStart" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
              if (c) dealCreatureDamage(ctx.game, ctx.events, c, 1, self);
            }
          },
        });
      }
      return [lvl, { abilities }];
    }),
  ),
});

// --- Korok, Khan of Kadras (Forgeborn, 4 levels; static Aggressive aura) ---
registerCard({
  defId: "korok-khan-of-kadras",
  levels: Object.fromEntries(
    ([[1, 0], [2, 1], [3, 2], [4, 99]] as const).map(([lvl, cap]) => [lvl, {
      // L1 has no aura (its own Aggressive is an inherent keyword).
      statics: cap === 0 ? [] : [{
        id: "khan's-ire",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.owner === self.owner && target.level <= cap) {
            stats.keywords.push({ keyword: "Aggressive", value: 0 });
          }
        },
      }],
    }]),
  ),
});

// --- Thundergale Invoker (Forge: adjacent creatures move one space away) ---
registerCard({
  defId: "thundergale-invoker",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-gale",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          for (const dir of [-1, 1] as const) {
            const adj = self.lane + dir;
            const c = adj >= 0 && adj < pl.lanes.length ? pl.lanes[adj] : null;
            // moveCreature no-ops when the far space is blocked or off-board
            if (c) moveCreature(ctx.game, ctx.events, c, adj + dir);
          }
        },
      }],
    }]),
  ),
});

// --- Umbruk Glider (Allied Uterra: gets Breakthrough) ---
registerCard({
  defId: "umbruk-glider",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "allied-uterra",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Uterra"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Breakthrough", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Uranti Heartseeker (Activate: 4 damage to an enemy creature or player
//     with exactly N health — flat 4 per the scraped text, see header note) ---
const HEARTSEEKER_DAMAGE = 4;
registerCard({
  defId: "uranti-heartseeker",
  levels: Object.fromEntries(
    ([[1, 4], [2, 9], [3, 15]] as const).map(([lvl, gate]) => [lvl, {
      activates: [{
        id: "heartseeker",
        prompt: (game: Game, self: CreatureState) => {
          const foe = opposing(self.owner);
          const options = enemyUids(game, self.owner,
            (c) => getStats(game, c).health - c.damage === gate);
          if (game.state.players[foe].health === gate) options.push(self.owner === 0 ? -2 : -1);
          return req(
            `Deal ${HEARTSEEKER_DAMAGE} damage to an enemy creature or player with exactly ${gate} health`,
            "anyCreatureOrPlayer", options,
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const t = choice?.targetUid;
          if (t === undefined) return;
          if (t === -1) dealPlayerDamage(ctx.game, ctx.events, 0, HEARTSEEKER_DAMAGE, self);
          else if (t === -2) dealPlayerDamage(ctx.game, ctx.events, 1, HEARTSEEKER_DAMAGE, self);
          else {
            const c = findCreature(ctx.game.state, t);
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, HEARTSEEKER_DAMAGE, self);
          }
        },
      }],
    }]),
  ),
});

// --- Uranti Icemage (Activate: Negate Defender from a creature this turn) ---
registerCard({
  defId: "uranti-icemage",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "thaw",
        prompt: (game: Game) => req(
          "Negate Defender from a creature this turn",
          "anyCreature",
          // static-granted Defender cannot be negated (see header note)
          boardUids(game, (c) =>
            c.keywords.some((k) => k.keyword === "Defender")
            || c.tempKeywords.some((k) => k.keyword === "Defender")),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          negateKeyword(ctx.events, c, "Defender");
          if (!c.grantedAbilities.includes("tempys:set2-defender-restore")) {
            c.grantedAbilities.push("tempys:set2-defender-restore");
          }
        },
      }],
    }]),
  ),
});

// --- Uranti Warlord (Forge: each friendly Yeti deals N to the opposing creature) ---
registerCard({
  defId: "uranti-warlord",
  levels: Object.fromEntries(
    ([[1, 3], [2, 7], [3, 13]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-stampede",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c || !hasSubtype(ctx.game, c, "Yeti")) continue;
            const opp = opposingCreature(ctx.game, c);
            if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, n, c);
          }
        },
      }],
    }]),
  ),
});

// --- Wallbreaker Yeti (Forge: you may destroy an enemy level-<=cap creature
//     with Defender) ---
registerCard({
  defId: "wallbreaker-yeti",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-wallbreak",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          cap === 99
            ? "Destroy an enemy creature with Defender"
            : `Destroy an enemy level ${cap}${cap === 2 ? " or lower" : ""} creature with Defender`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => c.level <= cap && hasKeyword(c, "Defender")),
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

// ============================================================
// Spells
// ============================================================

// --- Conflagrate (deal N damage to two enemy creatures; sequential picks) ---
registerCard({
  defId: "conflagrate",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) =>
        req(`Deal ${n} damage to two enemy creatures (first target)`, "enemyCreature", enemyUids(game, player)),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (ctx.priorAnswers.length === 0) return; // prompt found no targets: fizzle
        const t = targetOf(ctx, choice);
        if (t) dealCreatureDamage(ctx.game, ctx.events, t, n);
        if (ctx.priorAnswers.length >= 2) return; // both targets hit
        const rest = enemyUids(ctx.game, player, (c) => c.uid !== t?.uid);
        if (!rest.length) return; // only one enemy creature on board
        return {
          kind: "enemyCreature" as const,
          prompt: `Deal ${n} damage to a second enemy creature`,
          options: rest,
        };
      },
    }]),
  ),
});

// --- Flame Lance (N damage to an enemy creature and N to the enemy player) ---
registerCard({
  defId: "flame-lance",
  spell: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) =>
        req(`Deal ${n} damage to an enemy creature`, "enemyCreature", enemyUids(game, player)),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const t = targetOf(ctx, choice);
        if (t) dealCreatureDamage(ctx.game, ctx.events, t, n);
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), n);
      },
    }]),
  ),
});

// --- Glacial Crush (destroy an enemy creature with Defender; L3: its health
//     to the enemy player) ---
registerCard({
  defId: "glacial-crush",
  spell: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      prompt: (game: Game, player: PlayerId) =>
        req("Destroy an enemy creature with Defender", "enemyCreature",
          enemyUids(game, player, (c) => hasKeyword(c, "Defender"))),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const t = targetOf(ctx, choice);
        if (!t) return;
        const face = lvl === 3 ? Math.max(0, getStats(ctx.game, t).health - t.damage) : 0;
        destroyCreature(ctx.game, ctx.events, t);
        if (face > 0) dealPlayerDamage(ctx.game, ctx.events, opposing(player), face);
      },
    }]),
  ),
});

// --- Stone Brand (a creature with Defender gets +N/+N and loses Defender) ---
registerCard({
  defId: "stone-brand",
  spell: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature with Defender +${n} attack and +${n} health and Negate Defender from it`,
        "anyCreature",
        boardUids(game, (c) => hasKeyword(c, "Defender")),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        negateKeyword(ctx.events, c, "Defender");
      },
    }]),
  ),
});

// --- Talin Stampede (each friendly Tempys creature gets +N attack this turn) ---
registerCard({
  defId: "talin-stampede",
  spell: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c && ctx.game.state.cards[c.defId]?.faction === "Tempys") {
            buffCreature(ctx.game, ctx.events, c, n, 0, true);
          }
        }
      },
    }]),
  ),
});

// --- Turnabout (each creature gets +N attack and -N health this turn) ---
registerCard({
  defId: "turnabout",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx) => {
        for (const c of allCreatures(ctx.game.state)) {
          buffCreature(ctx.game, ctx.events, c, n, -n, true);
        }
      },
    }]),
  ),
});
