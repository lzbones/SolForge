/**
 * Set 3 (Secrets of Solis) + 3.1 Uterra card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set1/set2-uterra.ts):
 *  - Aetherphage: the forced enemy discard does NOT level the discarded spell
 *    (its text says only "discards"; compare the Leyline cards' explicit
 *    "discard and level up" templating, which checkAmbush in game.ts mirrors).
 *    The choice is surfaced as kind "cardInHand" over the ENEMY hand's indexes
 *    (the Aetherphage controller chooses).
 *  - Dozer, the Dormant: the Awakened is spawned at its printed stats
 *    (9/9, 12/12, 15/15 — exactly what the Dormant's text names per level).
 *    The Awakened's own "enters play with health equal to the Dozer, the
 *    Dormant it replaced" rider belongs to dozer-the-awakened's script, which
 *    is out of this file's scope.
 *  - Dysian Sludge: the Forge copy Spawned via the "you may" choice never fires
 *    its own enters-play ability — triggers emitted during a choice-resumed
 *    resolve are dropped (resumeWithChoice runs resolve outside a batch).
 *    Engine gap; also affects Suruzal/Branchweaver copies.
 *  - Bramblewood Tracker: the level/faction gate on the bonus play cannot be
 *    enforced by legalActions — grants an unrestricted extra play
 *    (state.playsLeft += 1), same convention as Frostwild Tracker
 *    (set1-uterra.ts) and Ashurian Flamesculptor (set3-tempys.ts).
 *  - Tuskin Sporelord / Dysian Sludge copies are FRESH copies (base stats),
 *    same convention as Suruzal, Emissary of Varna (set3-nekrium.ts).
 *  - Funguy (the Solbind token) is vanilla and needs no script.
 */
import { registerCard } from "./registry.js";
import {
  banishFromDiscard, buffCreature, destroyCreature, getStats, healPlayer, isDeadEffective,
  spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Faction } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function req(prompt: string, kind: ChoiceRequest["kind"], options: number[], optional = false): Omit<ChoiceRequest, "id"> | null {
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

function openLanes(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

function hasFactionInHand(game: Game, p: PlayerId, faction: Faction): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

function isSpell(game: Game, defId: string): boolean {
  return (game.state.cards[defId]?.types ?? []).includes("Spell");
}

// ============================================================
// Creatures
// ============================================================

// --- Aetherphage: Forge — choose a level-<=cap spell in the ENEMY hand; the
//     enemy player discards it (no level-up — see header note). ---
registerCard({
  defId: "aetherphage",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-pluck",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[opposing(self.owner)].hand;
          const options = hand
            .map((inst, i) => (inst.level <= cap && isSpell(game, inst.defId)) ? i : -1)
            .filter((i) => i >= 0);
          return req(
            cap === 99
              ? "Choose a spell in the enemy player's hand; the enemy player discards it"
              : cap === 1
                ? "Choose a level 1 spell in the enemy player's hand; the enemy player discards it"
                : "Choose a level 2 or lower spell in the enemy player's hand; the enemy player discards it",
            "cardInHand",
            options,
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const foe = ctx.game.state.players[opposing(self.owner)];
          const inst = foe.hand[choice.handIndex];
          // re-validate: still a level-legal spell
          if (!inst || inst.level > cap || !isSpell(ctx.game, inst.defId)) return;
          foe.hand.splice(choice.handIndex, 1);
          foe.discard.push(inst);
          ctx.events.push({ type: "discard", player: opposing(self.owner), defId: inst.defId, level: inst.level });
        },
      }],
    }]),
  ),
});

// --- Dozer, the Dormant: Defender (engine keyword); when dealt damage and
//     survives, replace it with a same-level Dozer, the Awakened. ---
registerCard({
  defId: "dozer-the-dormant",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "awaken",
        trigger: "damaged" as const,
        condition: (game: Game, self: CreatureState) => !isDeadEffective(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          // "damaged" is a DEATHBLOW_TRIGGER: it still resolves for a creature
          // killed mid-batch, so re-check survival here.
          if (isDeadEffective(ctx.game, self)) return;
          spawnCreature(ctx.game, ctx.events, self.owner, "dozer-the-awakened", self.level,
            { lane: self.lane, replace: true });
        },
      }],
    }]),
  ),
});

// --- Dysian Sludge: Forge — over 100 health, you may put a copy into another
//     space; when it enters play, Allied Nekrium — the opposing creature gets
//     -N/-N. The copy's own entry never re-triggers (engine gap, see header). ---
registerCard({
  defId: "dysian-sludge",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "forge-copy",
          trigger: "enterFromHand" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState) => game.state.players[self.owner].health > 100,
          prompt: (game: Game, self: CreatureState) =>
            openLanes(game, self.owner).length
              ? { kind: "yesNo" as const, prompt: "Put a copy of Dysian Sludge into another space?", optional: true }
              : null,
          resolve: (ctx: Ctx, self: CreatureState) => {
            // its own lane is occupied, so any open lane is "another space"
            if (openLanes(ctx.game, self.owner).length) {
              spawnCreature(ctx.game, ctx.events, self.owner, "dysian-sludge", self.level, { lane: "random" });
            }
          },
        },
        {
          id: "allied-wither",
          trigger: "enterPlay" as const,
          condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Nekrium"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            const opp = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
            if (opp) buffCreature(ctx.game, ctx.events, opp, -n, -n);
          },
        },
      ],
    }]),
  ),
});

// --- Shardbound Invoker: Forge — at Rank gate+, give a creature +N/+N. ---
registerCard({
  defId: "shardbound-invoker",
  levels: Object.fromEntries(
    ([[1, 2, 3], [2, 3, 5], [3, 4, 9]] as const).map(([lvl, gate, n]) => [lvl, {
      abilities: [{
        id: "forge-empower",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].rank >= gate,
        prompt: (game: Game) => req(
          `Give a creature +${n} attack and +${n} health`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Toorgmai Guardian: Forge — you may Banish a Plant from your discard
//     pile; if you do, it gets +N/+N. ---
registerCard({
  defId: "toorgmai-guardian",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-banish-plant",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].discard
            .map((inst, i) => hasSubtype(game, inst.defId, "Plant") ? i : -1)
            .filter((i) => i >= 0);
          return req(
            `You may Banish a Plant from your discard pile; if you do, Toorgmai Guardian gets +${n} attack and +${n} health`,
            "cardInDiscard",
            options,
            true,
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const inst = ctx.game.state.players[self.owner].discard[choice.handIndex];
          if (!inst || !hasSubtype(ctx.game, inst.defId, "Plant")) return;
          banishFromDiscard(ctx.game, ctx.events, self.owner, choice.handIndex);
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Tuskin Sporelord: Solbind Funguy; Activate — put a copy of a friendly
//     level-<=cap Plant into an available space (fresh copy, random open lane). ---
registerCard({
  defId: "tuskin-sporelord",
  solbind: ["funguy"],
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      activates: [{
        id: "spore-copy",
        // NOTE: no open-lane condition (Mimicleaf convention) — with no
        // available space the activation simply fizzles in resolve.
        prompt: (game: Game, self: CreatureState) => req(
          cap === 99
            ? "Put a copy of a friendly Plant into an available space"
            : cap === 1
              ? "Put a copy of a friendly level 1 Plant into an available space"
              : "Put a copy of a friendly level 2 or lower Plant into an available space",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.level <= cap && hasSubtype(game, c.defId, "Plant")),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== self.owner || c.level > cap || !hasSubtype(ctx.game, c.defId, "Plant")) return;
          spawnCreature(ctx.game, ctx.events, self.owner, c.defId, c.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Weirwood Ranger: Activate — give a creature +N/+N. ---
registerCard({
  defId: "weirwood-ranger",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "nourish",
        prompt: (game: Game) => req(
          `Give a creature +${lvl} attack and +${lvl} health`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, lvl, lvl);
        },
      }],
    }]),
  ),
});

// --- Bramblewood Tracker (Set 3.1): L1 vanilla; L2+ Consistent (engine
//     keyword), Forge — you may play an additional Uterra creature this turn
//     (unrestricted extra play — see header note). ---
registerCard({
  defId: "bramblewood-tracker",
  levels: {
    1: {}, // vanilla 3/6
    ...Object.fromEntries(
      ([[2, "level 1"], [3, "level 2 or lower"]] as const).map(([lvl, what]) => [lvl, {
        abilities: [{
          id: "forge-extra-play",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: () => ({
            kind: "yesNo" as const,
            prompt: `Play an additional ${what} Uterra creature this turn?`,
            optional: true,
          }),
          resolve: (ctx: Ctx) => {
            ctx.game.state.playsLeft += 1;
          },
        }],
      }]),
    ),
  },
});

// ============================================================
// Spells
// ============================================================

// --- Lysian Shard: give a creature +6/+6 (Overload — engine keyword). ---
registerCard({
  defId: "lysian-shard",
  spell: {
    1: {
      prompt: (game: Game) => req(
        "Give a creature +6 attack and +6 health",
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, 6, 6);
      },
    },
  },
});

// --- Metamorphosis: replace a level-<=cap creature with a level 1 Feywing
//     Chrysalis (the Chrysalis belongs to the replaced creature's owner). ---
registerCard({
  defId: "metamorphosis",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 99
          ? "Replace a creature with a level 1 Feywing Chrysalis"
          : cap === 1
            ? "Replace a level 1 creature with a level 1 Feywing Chrysalis"
            : "Replace a level 2 or lower creature with a level 1 Feywing Chrysalis",
        "anyCreature",
        boardUids(game, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.level > cap) return;
        spawnCreature(ctx.game, ctx.events, c.owner, "feywing-chrysalis", 1,
          { lane: c.lane, replace: true });
      },
    }]),
  ),
});

// --- Scatter the Seeds: Spawn three N/N Plant tokens (random open lanes;
//     fewer if spaces run out). Token base stats are "*", so overrideStats. ---
registerCard({
  defId: "scatter-the-seeds",
  spell: Object.fromEntries(
    ([[1, "seedling", 1], [2, "sapling", 3], [3, "treefolk", 5]] as const).map(([lvl, token, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (let i = 0; i < 3; i++) {
          spawnCreature(ctx.game, ctx.events, player, token, 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        }
      },
    }]),
  ),
});

// --- Seal of Deepwood: give a creature +N/+N (Consistent at L2+ — engine keyword). ---
registerCard({
  defId: "seal-of-deepwood",
  spell: Object.fromEntries(
    ([[1, 1], [2, 6], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${n} attack and +${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, n);
      },
    }]),
  ),
});

// --- Tangle: destroy a (level-<=2 at L1) creature with Mobility; L3 also
//     gains you health equal to that creature's attack. ---
registerCard({
  defId: "tangle",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 2
          ? "Destroy a level 2 or lower creature with Mobility"
          : "Destroy a creature with Mobility",
        "anyCreature",
        boardUids(game, (c) => c.level <= cap && hasKeyword(c, "Mobility")),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.level > cap || !hasKeyword(c, "Mobility")) return;
        const attack = getStats(ctx.game, c).attack;
        destroyCreature(ctx.game, ctx.events, c);
        if (lvl === 3 && attack > 0) healPlayer(ctx.game, ctx.events, player, attack);
      },
    }]),
  ),
});
