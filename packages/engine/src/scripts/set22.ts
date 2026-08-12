/**
 * Set 2.2 patch-set card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set2-nekrium.ts / set2-alloyin.ts):
 *  - Spirit Reaver (playerHealed) is already scripted in set2-nekrium.ts and
 *    Ice Torrent in set5-tempys.ts (Set 5 support cards) — not re-registered.
 *  - Spiritforge Sentinel (Armor N only) is keyword-only text: no script.
 *  - Agamemnon: "this battles again" — CreatureState.extraBattles is unused by
 *    the engine; emulated via state.battlesLeft += 1 (the Zyx, Storm Herald /
 *    Call the Lightning convention), i.e. the extra battle is a full combat
 *    phase for the player, not Agamemnon-only. "On your turn" gates the
 *    trigger to its controller's turn (defending on the enemy turn does not
 *    chain extra battles).
 *  - Yuru, the Necrosage: "adjacent" reads as the friendly spaces next to
 *    Yuru (SolForge adjacency is same-side), so only friendly deaths in lanes
 *    +/-1 qualify; the Spirit goes into the emptied space.
 *  - Stygian Lotus: each Spawned copy lands in a random open space and
 *    independently repeats the spawn if it is itself opposed (FIFO chain).
 *  - Shardthief Druid: Negate strips inherent/temp Regenerate only; Regenerate
 *    granted by a static aura (staticKeywords) is recomputed and survives.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, destroyCreature, drawCardsEffect,
  grantKeyword, healPlayer, negateKeyword, spawnCreature,
} from "../effects.js";
import { findCreature, hasKeyword, keywordValue, opposing, type CreatureState, type PlayerId } from "../state.js";
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

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

function hasOpenLane(game: Game, p: PlayerId): boolean {
  return game.state.players[p].lanes.some((c) => !c);
}

/** rankGained fires during the ranking player's endTurn, while they are still active. */
function ownRankUp(game: Game, self: CreatureState): boolean {
  return game.state.active === self.owner;
}

// ============================================================
// Creatures
// ============================================================

// --- Agamemnon: when it deals battle damage to a creature on your turn, this
//     battles again (battlesLeft += 1 — see header note). ---
registerCard({
  defId: "agamemnon",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "battle-again",
        trigger: "battleDamageToCreature" as const,
        // battle damage while defending on the enemy turn does not chain
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.battlesLeft += 1;
        },
      }],
    }]),
  ),
});

// --- Blightskull Phantasm: when you gain a Rank, the opposing creature gets -N/-N. ---
registerCard({
  defId: "blightskull-phantasm",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rank-wither",
        trigger: "rankGained" as const,
        condition: ownRankUp,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = opposingCreature(ctx.game, self);
          if (foe) buffCreature(ctx.game, ctx.events, foe, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Flamebreak Invoker: when you play a Tempys spell, deal 1 damage to each
//     enemy creature. ---
registerCard({
  defId: "flamebreak-invoker",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "tempys-spell-burn",
        trigger: "spellPlayed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Tempys",
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, 1, self);
          }
        },
      }],
    }]),
  ),
});

// --- Gemheart Sprout: Activate — you gain health equal to Mx the number of
//     friendly creatures (Defender only blocks attacking, not activating). ---
registerCard({
  defId: "gemheart-sprout",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "gemheart",
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].lanes.filter(Boolean).length;
          if (count) healPlayer(ctx.game, ctx.events, self.owner, count * lvl);
        },
      }],
    }]),
  ),
});

// --- Metamind Overseer: when you gain a Rank, draw 2 cards. ---
registerCard({
  defId: "metamind-overseer",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "rank-draw",
        trigger: "rankGained" as const,
        condition: ownRankUp,
        resolve: (ctx: Ctx, self: CreatureState) => {
          drawCardsEffect(ctx.game, ctx.events, self.owner, 2);
        },
      }],
    }]),
  ),
});

// --- Mimicwurm: L1 vanilla; L2 Forge — you may put a level 1 Mimicwurm into
//     another space; L3 Forge — you may put a level 2, then a level 1 (two
//     optional yes/no steps). Copies are not Forged, so they do not chain. ---
registerCard({
  defId: "mimicwurm",
  levels: {
    1: {}, // vanilla 7/7
    2: {
      abilities: [{
        id: "forge-mimic",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          hasOpenLane(game, self.owner)
            ? { kind: "yesNo" as const, prompt: "Put a level 1 Mimicwurm into another space?", optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "mimicwurm", 1, { lane: "random" });
        },
      }],
    },
    3: {
      abilities: [{
        id: "forge-mimic-chain",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          hasOpenLane(game, self.owner)
            ? { kind: "yesNo" as const, prompt: "Put a level 2 Mimicwurm into another space?", optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (ctx.priorAnswers.length < 2) {
            // step 1 accepted: spawn the level 2 copy, then offer the level 1
            spawnCreature(ctx.game, ctx.events, self.owner, "mimicwurm", 2, { lane: "random" });
            if (!hasOpenLane(ctx.game, self.owner)) return;
            return { kind: "yesNo" as const, prompt: "Put a level 1 Mimicwurm into another space?", optional: true };
          }
          // step 2 accepted: spawn the level 1 copy
          spawnCreature(ctx.game, ctx.events, self.owner, "mimicwurm", 1, { lane: "random" });
        },
      }],
    },
  },
});

// --- Palladium Simulacrum: Forge/Flank — if it is in the center space, Spawn
//     a copy (Mobility N is inherent). ---
registerCard({
  defId: "palladium-simulacrum",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => {
      const inCenter = (_game: Game, self: CreatureState) => self.lane === 2;
      const spawnCopy = (ctx: Ctx, self: CreatureState) => {
        spawnCreature(ctx.game, ctx.events, self.owner, self.defId, self.level, { lane: "random" });
      };
      return [lvl, {
        abilities: [
          { id: "forge-copy", trigger: "enterFromHand" as const, condition: inCenter, resolve: spawnCopy },
          { id: "flank-copy", trigger: "moved" as const, condition: inCenter, resolve: spawnCopy },
        ] as Ability[],
      }];
    }),
  ),
});

// --- Phalanx Squadron: Forge — give a friendly creature with Armor +N/+N. ---
registerCard({
  defId: "phalanx-squadron",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-phalanx",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Give a friendly creature with Armor +${n} attack and +${n} health`,
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => hasKeyword(c, "Armor")),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.owner === self.owner) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Razortooth Stalker: when it deals battle damage to a player, it gets
//     +N/+N (Mobility 1 is inherent). ---
registerCard({
  defId: "razortooth-stalker",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "battle-grow",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Shardthief Druid: Forge — Negate and remove all Regenerate from an
//     enemy creature; Shardthief Druid gets that much Regenerate. ---
registerCard({
  defId: "shardthief-druid",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-steal-regen",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "Negate and remove all Regenerate from an enemy creature. Shardthief Druid gets that much Regenerate",
          "enemyCreature",
          enemyUids(game, self.owner, (c) => keywordValue(c, "Regenerate") > 0),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner === self.owner) return;
          const stolen = keywordValue(c, "Regenerate");
          negateKeyword(ctx.events, c, "Regenerate");
          if (stolen > 0) grantKeyword(ctx.events, self, { keyword: "Regenerate", value: stolen });
        },
      }],
    }]),
  ),
});

// --- Shimmerfang Serpent: when it deals battle damage to a creature, that
//     creature gets that much Poison. ---
registerCard({
  defId: "shimmerfang-serpent",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "venom",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined || !evt.amount) return;
          const t = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (t) grantKeyword(ctx.events, t, { keyword: "Poison", value: evt.amount });
        },
      }],
    }]),
  ),
});

// --- Sigmund Fraud: Activate, destroy another friendly creature — deal N
//     damage to the enemy player and gain N health. ---
registerCard({
  defId: "sigmund-fraud",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "fraud",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Destroy another friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== self.owner || c.uid === self.uid) return;
          destroyCreature(ctx.game, ctx.events, c);
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n);
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Spiritfrost Shaman: when you gain a Rank, deal N damage to the enemy player. ---
registerCard({
  defId: "spiritfrost-shaman",
  levels: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rank-burn",
        trigger: "rankGained" as const,
        condition: ownRankUp,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n);
        },
      }],
    }]),
  ),
});

// --- Stygian Lotus: Forge — if opposed, Spawn a copy of it, then repeat for
//     each copy (each copy re-checks its own opposed status — header note). ---
registerCard({
  defId: "stygian-lotus",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-bloom",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const queue = [self];
          while (queue.length) {
            const c = queue.shift()!;
            if (!opposingCreature(ctx.game, c)) continue;
            const copy = spawnCreature(ctx.game, ctx.events, self.owner, self.defId, self.level, { lane: "random" });
            if (!copy) break; // no open space left
            queue.push(copy);
          }
        },
      }],
    }]),
  ),
});

// --- Umbraglim Mantis: when you gain a Rank, you get +N health. ---
registerCard({
  defId: "umbraglim-mantis",
  levels: Object.fromEntries(
    ([[1, 8], [2, 10], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rank-heal",
        trigger: "rankGained" as const,
        condition: ownRankUp,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Xithian Host: Vengeance — deal 3 damage to the enemy player and you
//     gain N health. ---
registerCard({
  defId: "xithian-host",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 9]] as const).map(([lvl, heal]) => [lvl, {
      abilities: [{
        id: "vengeance-drain",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), 3);
          healPlayer(ctx.game, ctx.events, self.owner, heal);
        },
      }],
    }]),
  ),
});

// --- Yuru, the Necrosage: when an adjacent non-Spirit creature is destroyed,
//     put an N/N Spirit into that space (Defender is inherent; adjacent =
//     friendly lanes +/-1 — header note). ---
registerCard({
  defId: "yuru-the-necrosage",
  levels: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "necrosage",
        trigger: "anyCreatureDestroyed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && evt.lane !== undefined && Math.abs(evt.lane - self.lane) === 1
          && !!evt.sourceDefId
          && !(game.state.cards[evt.sourceDefId]?.subtypes ?? []).includes("Spirit"),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          spawnCreature(ctx.game, ctx.events, self.owner, "spirit-nekrium", 1,
            { lane: evt.lane, overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});
