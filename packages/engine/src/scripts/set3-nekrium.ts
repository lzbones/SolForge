/**
 * Set 3 (Secrets of Solis) + 3.1 Nekrium card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set1/set2-nekrium.ts):
 *  - Contagion Lord L3 "You may use this ability twice each turn" cannot be
 *    expressed (engine allows one activate per creature per turn — same gap as
 *    Xithian Shambler L3 in set1-nekrium.ts). TODO below.
 *  - Xithian Direhound's Overload is only scripted as the Forge; the engine's
 *    Overload handling covers spells (removed instead of discarded when
 *    played), but an Overload CREATURE should be removed from the game instead
 *    of going to the discard pile when it leaves play — deathCheck always
 *    discards (engine gap).
 *  - Grimgaunt Doomrider follows the Advanced Rules section: at RESOLUTION, if
 *    the dead creature's space is available, the opposing creature is debuffed
 *    first, then the Doomrider moves into the space and buffs itself; if the
 *    space is occupied by then (another Doomrider already moved, a respawn
 *    filled it), nothing happens. The dead-Doomrider case (its trigger still
 *    resolves as a debuff-only effect when it died in the same batch) cannot be
 *    expressed: runBatches drops the pending triggers of dead creatures except
 *    destroyed/damage-family triggers (engine gap).
 *  - Suruzal's copy Spawns into a random OPEN lane; the destroyed creature is
 *    only marked dead (removal at batch end), so the copy can never land in the
 *    destroyed creature's own lane — in the real game it can, which is what
 *    sometimes pins a Doomrider in place (Advanced Rules). Same convention as
 *    Spiritleash's marked-but-present sacrifice in set2-nekrium.ts.
 *  - Ruthless Wanderers triggers only for Spirit Wanderers entering FROM HAND
 *    (Advanced Rules errata), not for revival/token entries: evt.fromHand.
 *  - Spiritcleave breaks "highest health" ties at random; L3 healing uses the
 *    creature's current health via getStats (damage ignored).
 *  - Contagion Fiend (Contagion Lord's Solbind token) is scripted here; the
 *    Broodfang token is keyword-only (Poison) and needs no script.
 */
import { registerCard } from "./registry.js";
import {
  banishFromDiscard, buffCreature, destroyCreature, getStats, grantKeyword, healPlayer,
  moveCreature, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, opposing, type CreatureState, type PlayerId } from "../state.js";
import type { Faction } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

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
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

function hasFactionInHand(game: Game, p: PlayerId, faction: Faction): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

// ============================================================
// Creatures
// ============================================================

// --- Catacomb Spider: Activate — give a creature Regenerate N. ---
registerCard({
  defId: "catacomb-spider",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "weave-regen",
        prompt: (game: Game) => req(
          `Give a creature Regenerate ${n}`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
        },
      }],
    }]),
  ),
});

// --- Contagion Lord: Solbind 2x Contagion Fiend; Activate, destroy a friendly
//     Abomination — play an additional card this turn.
//     TODO: L3 "You may use this ability twice each turn" — engine gates
//     activates to one per creature per turn (activatedThisTurn). ---
registerCard({
  defId: "contagion-lord",
  solbind: ["contagion-fiend", "contagion-fiend"], // Solbind adds two copies
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "consume-abomination",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => hasSubtype(game, c.defId, "Abomination")).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Destroy a friendly Abomination; you may play an additional card this turn",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => hasSubtype(game, c.defId, "Abomination")),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          destroyCreature(ctx.game, ctx.events, c);
          ctx.game.state.playsLeft += 1;
        },
      }],
    }]),
  ),
});

// --- Contagion Fiend (Solbind token): Vengeance — each enemy creature gets -N/-N. ---
registerCard({
  defId: "contagion-fiend",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-wither",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, -lvl, -lvl);
          }
        },
      }],
    }]),
  ),
});

// --- Dysian Broodqueen: Allied Uterra — put a level-matching Broodfang into an
//     available space; Activate, destroy another friendly creature — destroy an
//     enemy (level-gated) creature. Two-step chain: sacrifice, then enemy target. ---
registerCard({
  defId: "dysian-broodqueen",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "allied-broodfang",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Uterra"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          // Broodfang token levels are exactly 1/1, 2/2, 3/3 — spawn at the Queen's level.
          spawnCreature(ctx.game, ctx.events, self.owner, "broodfang", lvl, { lane: "random" });
        },
      }],
      activates: [{
        id: "devour-destroy",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid).length > 0
          && enemyUids(game, self.owner, (c) => c.level <= cap).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Destroy another friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
          if (firstUid === undefined) return;
          if (ctx.priorAnswers.length < 2) {
            // step 1: pay the sacrifice, then chain the enemy-target prompt
            const foes = enemyUids(ctx.game, self.owner, (c) => c.level <= cap);
            if (!foes.length) return;
            const sacrifice = findCreature(ctx.game.state, firstUid);
            if (sacrifice && sacrifice.uid !== self.uid) destroyCreature(ctx.game, ctx.events, sacrifice);
            return req(
              cap === 1
                ? "Destroy an enemy level 1 creature"
                : cap === 2
                  ? "Destroy an enemy level 2 or lower creature"
                  : "Destroy an enemy creature",
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

// --- Ebonbound Warlord: Forge — at Rank gate+, give a creature -N/-N. ---
registerCard({
  defId: "ebonbound-warlord",
  levels: Object.fromEntries(
    ([[1, 2, 3], [2, 3, 6], [3, 4, 9]] as const).map(([lvl, gate, n]) => [lvl, {
      abilities: [{
        id: "forge-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].rank >= gate,
        prompt: (game: Game) => req(
          `Give a creature -${n} attack and -${n} health`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Fleshreaver: L1 vanilla; L2+ Consistent (keyword), Forge — you may
//     destroy an enemy level-<=cap creature. ---
registerCard({
  defId: "fleshreaver",
  levels: {
    1: {}, // vanilla 6/2
    ...Object.fromEntries(
      ([[2, 1], [3, 2]] as const).map(([lvl, cap]) => [lvl, {
        abilities: [{
          id: "forge-destroy",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => req(
            cap === 1
              ? "You may destroy an enemy level 1 creature"
              : "You may destroy an enemy level 2 or lower creature",
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

// --- Grimgaunt Doomrider: when a friendly creature is destroyed, move into its
//     space and get +N/+N; first give the opposing creature -N/-N. Resolution
//     order and the "space must be available" check follow the Advanced Rules
//     section (see header note for the dead-Doomrider gap). ---
registerCard({
  defId: "grimgaunt-doomrider",
  levels: Object.fromEntries(
    ([[1, 1], [2, 1], [3, 2]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "doom-ride",
        trigger: "friendlyCreatureDestroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const lane = evt.lane;
          // Space no longer available at resolution: nothing happens.
          if (ctx.game.state.players[self.owner].lanes[lane]) return;
          const opp = ctx.game.state.players[opposing(self.owner)].lanes[lane];
          if (opp) buffCreature(ctx.game, ctx.events, opp, -n, -n);
          moveCreature(ctx.game, ctx.events, self, lane);
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Nefrax, the Soulweaver: Forge — destroy a friendly creature (may be
//     itself); Activate — put an N/N Spirit into an available space. ---
registerCard({
  defId: "nefrax-the-soulweaver",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-eat",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "Destroy a friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) destroyCreature(ctx.game, ctx.events, c);
        },
      }],
      activates: [{
        id: "weave-spirit",
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "spirit-nekrium", 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Ruthless Wanderers: when ANOTHER friendly Spirit Wanderer enters play
//     from your hand (Advanced Rules errata), the creature opposing it gets -N/-N. ---
registerCard({
  defId: "ruthless-wanderers",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "wanderer-wither",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.fromHand === true
          && evt.sourceOwner === self.owner
          && evt.sourceUid !== self.uid
          && !!evt.sourceDefId
          && hasSubtype(game, evt.sourceDefId, "Spirit Wanderer"),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const opp = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (opp) buffCreature(ctx.game, ctx.events, opp, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Suruzal, Emissary of Varna: Forge — you may destroy another friendly
//     (level-<=cap) creature; if you do, Spawn a copy of it (random open lane —
//     see header note). ---
registerCard({
  defId: "suruzal-emissary-of-varna",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-rebirth",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          cap === 1
            ? "You may destroy another friendly level 1 creature; if you do, Spawn a copy of it"
            : cap === 2
              ? "You may destroy another friendly level 2 or lower creature; if you do, Spawn a copy of it"
              : "You may destroy another friendly creature; if you do, Spawn a copy of it",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid && c.level <= cap),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.uid === self.uid || c.owner !== self.owner) return;
          const { defId, level, owner } = c;
          destroyCreature(ctx.game, ctx.events, c);
          spawnCreature(ctx.game, ctx.events, owner, defId, level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Tomb Pillager: Forge — you may Banish a Nekrium card from your discard
//     pile (Consistent at L2+ — engine keyword). ---
registerCard({
  defId: "tomb-pillager",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-banish",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].discard
            .map((inst, i) => game.state.cards[inst.defId]?.faction === "Nekrium" ? i : -1)
            .filter((i) => i >= 0);
          return req("You may Banish a Nekrium card from your discard pile", "cardInDiscard", options, true);
        },
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          banishFromDiscard(ctx.game, ctx.events, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Xithian Direhound: Overload (creature-side banish is an engine gap — see
//     header note); Forge — you may give an enemy creature -4/-4. ---
registerCard({
  defId: "xithian-direhound",
  levels: {
    1: {
      abilities: [{
        id: "forge-wither",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "You may give an enemy creature -4 attack and -4 health",
          "enemyCreature",
          enemyUids(game, self.owner),
          true,
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -4, -4);
        },
      }],
    },
  },
});

// --- Zombie Titan: while in a side space (lane 0 or 4), it gets +N/+N and
//     Regenerate lvl (static — recomputed on every stat read). ---
registerCard({
  defId: "zombie-titan",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "side-space",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid === self.uid && (self.lane === 0 || self.lane === 4)) {
            stats.attack += n;
            stats.health += n;
            stats.keywords.push({ keyword: "Regenerate", value: lvl });
          }
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Dysian Siphon: give an enemy creature -N/-N; Allied Uterra — give a
//     friendly creature +N/+N (two-step chain: enemy first, then friendly). ---
registerCard({
  defId: "dysian-siphon",
  spell: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give an enemy creature -${n} attack and -${n} health`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // no enemy creature: fizzle
        if (ctx.priorAnswers.length < 2) {
          // step 1: debuff the enemy, then chain the Allied friendly buff
          const foe = findCreature(ctx.game.state, firstUid);
          if (foe && foe.owner !== player) buffCreature(ctx.game, ctx.events, foe, -n, -n);
          if (!hasFactionInHand(ctx.game, player, "Uterra")) return;
          const friends = friendlyUids(ctx.game, player);
          if (!friends.length) return;
          return {
            kind: "friendlyCreature" as const,
            prompt: `Allied: Give a friendly creature +${n} attack and +${n} health`,
            options: friends,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const friend = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (friend && friend.owner === player) buffCreature(ctx.game, ctx.events, friend, n, n);
      },
    }]),
  ),
});

// --- Seal of Tarsus: give a creature -N/-N (Consistent at L2+ — engine keyword). ---
registerCard({
  defId: "seal-of-tarsus",
  spell: Object.fromEntries(
    ([[1, 2], [2, 8], [3, 16]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
      },
    }]),
  ),
});

// --- Spiritcleave: destroy the highest-health (level-<=2 at L1) creature;
//     L3 also heals you for that creature's health. Ties broken at random. ---
registerCard({
  defId: "spiritcleave",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pool = [...allCreatures(ctx.game.state)].filter((c) => c.level <= cap);
        if (!pool.length) return;
        const maxHealth = Math.max(...pool.map((c) => getStats(ctx.game, c).health));
        const target = ctx.rng.pick(pool.filter((c) => getStats(ctx.game, c).health === maxHealth));
        const health = getStats(ctx.game, target).health;
        destroyCreature(ctx.game, ctx.events, target);
        if (lvl === 3 && health > 0) healPlayer(ctx.game, ctx.events, player, health);
      },
    }]),
  ),
});
