/**
 * Set 1 (Alpha) Uterra card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Engine-limit notes (approximations, reported as API gaps — do not "fix" here):
 *  - `creaturePlayed` is only collected for cards played from hand (game.ts);
 *    token spawns do not notify other creatures, so Spring Dryad / Restless
 *    Wanderers / Heart Tree miss token entries.
 *  - Lifeshaper Savant is blocked by a data gap, not the engine: its scraped
 *    L2/L3 attack/health are empty ("?" on the wiki; see
 *    tools/scraper/overrides.json), so it stays unscripted (TODO below).
 *  - Gemhide Basher's "while opposed" Aggressive is modeled with event-driven
 *    grant/negate (no keyword-aura support); movement and replacement of the
 *    opposing creature are not tracked.
 *  - Frostwild Tracker grants a raw extra play; the "level X or lower
 *    creature" restriction on the extra play cannot be expressed.
 *  - Heart Tree's Regenerate aura is modeled via granted turnStart-heal
 *    abilities (engine Regenerate resolves before any turnStart trigger could
 *    grant the keyword, and statics cannot grant keywords). Being replaced
 *    (not destroyed) leaves the granted heal behind.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, destroyCreature, grantKeyword, healCreature, healPlayer,
  negateKeyword, spawnCreature,
} from "../effects.js";
import { findCreature, opposing } from "../state.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, Ctx, TriggerPayload } from "../triggers.js";
import type { CreatureState, PlayerId } from "../state.js";

// ---------- helpers ----------

function allCreatureUids(game: Game): number[] {
  const out: number[] = [];
  for (const side of game.state.players) for (const c of side.lanes) if (c) out.push(c.uid);
  return out;
}

function boardFull(game: Game, p: PlayerId): boolean {
  return game.state.players[p].lanes.every(Boolean);
}

function adjacentOpen(game: Game, p: PlayerId, lane: number): number[] {
  const pl = game.state.players[p];
  return [lane - 1, lane + 1].filter((i) => i >= 0 && i < 5 && !pl.lanes[i]);
}

function openLanes(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
}

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

/** Enemy creature in the payload lane (for "deals damage to a creature" triggers). */
function enemyInLane(ctx: Ctx, self: CreatureState, evt: TriggerPayload): CreatureState | null {
  if (evt.lane === undefined) return null;
  return ctx.game.state.players[opposing(self.owner)].lanes[evt.lane] ?? null;
}

// ============================================================
// Creatures
// ============================================================

// --- Arboris, Grove Dragon: while you have over 100 health, gets +N/+N (static). ---
registerCard({
  defId: "arboris-grove-dragon",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 80]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "thrive",
        apply: (game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.uid === self.uid && game.state.players[self.owner].health > 100) {
            stats.attack += n;
            stats.health += n;
          }
        },
      }],
    }]),
  ),
});

// --- Bramblewood Guardian: vanilla — no script needed. ---

// --- Cadaverous Thicket: when it deals damage to a creature, give it Poison N. ---
registerCard({
  defId: "cadaverous-thicket",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "poison",
        trigger: "dealtDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const t = enemyInLane(ctx, self, evt);
          if (t) grantKeyword(ctx.events, t, { keyword: "Poison", value: n });
        },
      }],
    }]),
  ),
});

// --- Chrogias: when dealt damage, you gain that much health (L2/L3). ---
registerCard({
  defId: "chrogias",
  levels: {
    1: {}, // vanilla 1/1
    ...Object.fromEntries(
      ([2, 3] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "lifegain",
          trigger: "damaged" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            if (evt.amount) healPlayer(ctx.game, ctx.events, self.owner, evt.amount);
          },
        }],
      }]),
    ),
  },
});

// --- Deepbranch Ancient: Forge — if your board is full, gets +N/+N. ---
registerCard({
  defId: "deepbranch-ancient",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-full",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => boardFull(game, self.owner),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Echowisp: Forge — you may put a copy into an adjacent space (L3: each open space). ---
registerCard({
  defId: "echowisp",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-copy",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const spots = lvl === 3 ? openLanes(game, self.owner) : adjacentOpen(game, self.owner, self.lane);
          if (!spots.length) return null;
          return {
            kind: "yesNo" as const,
            prompt: lvl === 3
              ? "Put a copy of Echowisp into each available space?"
              : "Put a copy of Echowisp into an adjacent space?",
            optional: true,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (lvl === 3) {
            for (const lane of openLanes(ctx.game, self.owner)) {
              spawnCreature(ctx.game, ctx.events, self.owner, "echowisp", self.level, { lane });
            }
          } else {
            const spots = adjacentOpen(ctx.game, self.owner, self.lane);
            if (spots.length) {
              spawnCreature(ctx.game, ctx.events, self.owner, "echowisp", self.level,
                { lane: ctx.rng.pick(spots) });
            }
          }
        },
      }],
    }]),
  ),
});

// --- Ether Hounds: Forge — you may put a copy into a friendly open space. ---
registerCard({
  defId: "ether-hounds",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-copy",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          openLanes(game, self.owner).length
            ? { kind: "yesNo" as const, prompt: "Put a copy of Ether Hounds into an available space?", optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "ether-hounds", self.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Frostwild Tracker: Forge — you may play an additional creature this turn. ---
// Approximation: grants a raw extra play; the level restriction on the extra
// play (L2: level 1; L3: level 2 or lower) cannot be expressed.
registerCard({
  defId: "frostwild-tracker",
  levels: {
    1: {}, // vanilla 4/2
    ...Object.fromEntries(
      ([2, 3] as const).map((lvl) => [lvl, {
        abilities: [{
          id: "forge-extra-play",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: () => ({
            kind: "yesNo" as const,
            prompt: lvl === 2
              ? "Play an additional level 1 creature this turn?"
              : "Play an additional level 2 or lower creature this turn?",
            optional: true,
          }),
          resolve: (ctx: Ctx) => {
            ctx.game.state.playsLeft++;
          },
        }],
      }]),
    ),
  },
});

// --- Gemhide Basher: while opposed, it has Aggressive (event-driven grant/negate). ---
registerCard({
  defId: "gemhide-basher",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "bash-enter",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const opp = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
            if (opp) grantKeyword(ctx.events, self, { keyword: "Aggressive", value: 0 });
          },
        },
        {
          id: "bash-gain",
          trigger: "enemyCreatureEntered" as const,
          condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.lane === self.lane,
          resolve: (ctx: Ctx, self: CreatureState) => {
            grantKeyword(ctx.events, self, { keyword: "Aggressive", value: 0 });
          },
        },
        {
          id: "bash-lose",
          trigger: "opposingCreatureDestroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            negateKeyword(ctx.events, self, "Aggressive");
          },
        },
      ],
    }]),
  ),
});

// --- Ghostscale Cobra: battle damage to a creature -> that creature gets Poison N. ---
registerCard({
  defId: "ghostscale-cobra",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "venom",
        trigger: "battleDamageToCreature" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const t = enemyInLane(ctx, self, evt);
          if (t) grantKeyword(ctx.events, t, { keyword: "Poison", value: n });
        },
      }],
    }]),
  ),
});

// --- Glowstride Stag: Forge — you gain +N health. ---
registerCard({
  defId: "glowstride-stag",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-heal",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Grove Huntress: Forge — give a friendly creature +N/+N. ---
registerCard({
  defId: "grove-huntress",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-buff",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => ({
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature +${n} attack and +${n} health`,
          options: game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.uid),
        }),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Grove Matriarch: Vengeance — put a token into this space. ---
registerCard({
  defId: "grove-matriarch",
  levels: Object.fromEntries(
    ([[1, "seedling", 1], [2, "sapling", 3], [3, "treefolk", 5]] as const).map(([lvl, token, n]) => [lvl, {
      abilities: [{
        id: "vengeance-token",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
            { lane: evt.lane ?? "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Heart Tree: each other friendly creature gets Regenerate N. ---
// Modeled as granted turnStart-heal abilities (see header note).
const heartTreeRef = (n: number) => `uterra:heart-tree-regen-${n}`;
for (const n of [2, 4, 6] as const) {
  registerGranted(heartTreeRef(n), {
    id: heartTreeRef(n),
    trigger: "turnStart",
    condition: (game, self) => game.state.active === self.owner,
    resolve: (ctx, self) => {
      healCreature(ctx.game, ctx.events, self, n);
    },
  });
}
registerCard({
  defId: "heart-tree",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "aura-enter",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[self.owner].lanes) {
              if (c && c.uid !== self.uid) c.grantedAbilities.push(heartTreeRef(n));
            }
          },
        },
        {
          id: "aura-grant",
          trigger: "creaturePlayed" as const,
          condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner && evt.lane !== undefined && evt.lane !== self.lane,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            const c = ctx.game.state.players[self.owner].lanes[evt.lane!];
            if (c && c.uid !== self.uid) c.grantedAbilities.push(heartTreeRef(n));
          },
        },
        {
          id: "aura-cleanup",
          trigger: "destroyed" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[self.owner].lanes) {
              if (!c) continue;
              const i = c.grantedAbilities.indexOf(heartTreeRef(n));
              if (i >= 0) c.grantedAbilities.splice(i, 1);
            }
          },
        },
      ],
    }]),
  ),
});

// --- Hunting Pack: when it enters play, 50% chance to put a copy into an open space. ---
registerCard({
  defId: "hunting-pack",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "pack",
        trigger: "enterPlay" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (ctx.rng.next() < 0.5) {
            spawnCreature(ctx.game, ctx.events, self.owner, "hunting-pack", self.level, { lane: "random" });
          }
        },
      }],
    }]),
  ),
});

// --- Leafkin Progenitor: Activate — replace with next level (L3: put a L1 adjacent). ---
registerCard({
  defId: "leafkin-progenitor",
  levels: {
    1: {
      activates: [{
        id: "grow",
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "leafkin-progenitor", 2,
            { lane: self.lane, replace: true });
        },
      }],
    },
    2: {
      activates: [{
        id: "grow",
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "leafkin-progenitor", 3,
            { lane: self.lane, replace: true });
        },
      }],
    },
    3: {
      activates: [{
        id: "sprout",
        // NOTE: no condition here — engine legalActions() does not evaluate
        // activate conditions, so a failing condition would throw in
        // applyAction. No-adjacent-space simply fizzles in resolve instead.
        resolve: (ctx: Ctx, self: CreatureState) => {
          const spots = adjacentOpen(ctx.game, self.owner, self.lane);
          if (spots.length) {
            spawnCreature(ctx.game, ctx.events, self.owner, "leafkin-progenitor", 1,
              { lane: ctx.rng.pick(spots) });
          }
        },
      }],
    },
  },
});

// --- Lifeblood Dryad: Forge — if your board is full, each OTHER friendly gets +N/+N. ---
registerCard({
  defId: "lifeblood-dryad",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-full",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => boardFull(game, self.owner),
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid) buffCreature(ctx.game, ctx.events, c, n, n);
          }
        },
      }],
    }]),
  ),
});

// TODO(lifeshaper-savant): 仍是 wiki 数据缺口，不是引擎问题——cardPlayed 触发
// 引擎已支持，但其 L2/L3 的 attack/health 全空（wiki 为 "?"，tools/scraper/overrides.json
// 也无覆盖），且 fullgame 的卡池过滤要求每级 attack 非空。数据补齐后实现：
// trigger "cardPlayed" + sourceOwner/阵营 Uterra/等级 <= gate 条件 + 可选友方 +N/+N。

// --- Lightbringer Cleric: at the start of your turn, you gain +X..+Y health. ---
registerCard({
  defId: "lightbringer-cleric",
  levels: Object.fromEntries(
    ([[1, 1, 4], [2, 3, 8], [3, 7, 13]] as const).map(([lvl, lo, hi]) => [lvl, {
      abilities: [{
        id: "blessing",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, lo + ctx.rng.int(hi - lo + 1));
        },
      }],
    }]),
  ),
});

// --- Mossbeard Patriarch: Activate — give another creature +N health. ---
registerCard({
  defId: "mossbeard-patriarch",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "nourish",
        prompt: (game: Game, self: CreatureState) => {
          const options = allCreatureUids(game).filter((u) => u !== self.uid);
          return options.length
            ? { kind: "anyCreature" as const, prompt: `Give another creature +${n} health`, options }
            : null;
        },
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
        },
      }],
    }]),
  ),
});

// --- Oxidon Spitter: Forge — Negate Armor from an enemy creature (L3: each enemy). ---
registerCard({
  defId: "oxidon-spitter",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-negate",
        trigger: "enterFromHand" as const,
        targeted: lvl < 3,
        prompt: (game: Game, self: CreatureState) => {
          if (lvl === 3) return null; // untargeted: hits every enemy creature
          const options = game.state.players[opposing(self.owner)].lanes.filter(Boolean).map((c) => c!.uid);
          return options.length
            ? { kind: "enemyCreature" as const, prompt: "Negate Armor from an enemy creature", options }
            : null;
        },
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (lvl === 3) {
            for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
              if (c) negateKeyword(ctx.events, c, "Armor");
            }
          } else {
            const c = targetOf(ctx, choice);
            if (c) negateKeyword(ctx.events, c, "Armor");
          }
        },
      }],
    }]),
  ),
});

// --- Restless Wanderers: when another friendly Spirit Wanderer enters play, +N/+N. ---
registerCard({
  defId: "restless-wanderers",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "wander",
        trigger: "creaturePlayed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.lane !== undefined && evt.lane !== self.lane
          && !!evt.sourceDefId && (game.state.cards[evt.sourceDefId]?.subtypes ?? []).includes("Spirit Wanderer"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Rootforged Avatar: Forge — +N/+N for each Uterra card in your hand. ---
registerCard({
  defId: "rootforged-avatar",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-hand",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].hand
            .filter((c) => ctx.game.state.cards[c.defId]?.faction === "Uterra").length;
          if (count > 0) buffCreature(ctx.game, ctx.events, self, n * count, n * count);
        },
      }],
    }]),
  ),
});

// --- Runegrove Guardian: when you gain a Rank, gets +N/+N. ---
registerCard({
  defId: "runegrove-guardian",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rank-up",
        trigger: "rankGained" as const,
        // rankGained fires during endTurn, before `active` flips — the player
        // gaining the rank is still the active player.
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Shardplate Delver: at the start of your turn, gets +N/+N. ---
registerCard({
  defId: "shardplate-delver",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "grow",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Shardplate Mutant: at the start of your turn, discard down to 2 cards at random. ---
registerCard({
  defId: "shardplate-mutant",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "shed",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          while (pl.hand.length > 2) {
            const i = ctx.rng.int(pl.hand.length);
            const inst = pl.hand.splice(i, 1)[0]!;
            pl.discard.push(inst);
            ctx.events.push({ type: "discard", player: self.owner, defId: inst.defId, level: inst.level });
          }
        },
      }],
    }]),
  ),
});

// --- Spring Dryad: when a friendly creature enters play, gets +N/+N. ---
registerCard({
  defId: "spring-dryad",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "bloom",
        trigger: "creaturePlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.lane !== undefined && evt.lane !== self.lane,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Talisin, Bard of Abundance: at the start of each player's turn (L3: your
//     turn), that player may play an additional card. ---
registerCard({
  defId: "talisin-bard-of-abundance",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "encore",
        trigger: "turnStart" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) =>
          lvl < 3 || game.state.active === self.owner,
        prompt: () => ({
          kind: "yesNo" as const,
          prompt: "Play an additional card this turn?",
          optional: true,
        }),
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft++;
        },
      }],
    }]),
  ),
});

// --- Uterra Packmaster: Activate — each other friendly Uterra creature gets +N/+N. ---
registerCard({
  defId: "uterra-packmaster",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "pack-leader",
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid && ctx.game.state.cards[c.defId]?.faction === "Uterra") {
              buffCreature(ctx.game, ctx.events, c, n, n);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Wildwood Sower: when you play a spell, you may put a token into an
//     available space (random open lane, same as Ether Hounds). ---
const sower: Record<number, { token: string; name: string; n: number }> = {
  1: { token: "seedling", name: "Seedling", n: 1 },
  2: { token: "sapling", name: "Sapling", n: 3 },
  3: { token: "treefolk", name: "Treefolk", n: 5 },
};
registerCard({
  defId: "wildwood-sower",
  levels: Object.fromEntries(
    Object.entries(sower).map(([lvl, { token, name, n }]) => [lvl, {
      abilities: [{
        id: "sow",
        trigger: "spellPlayed" as const,
        targeted: true,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        prompt: (game: Game, self: CreatureState) =>
          boardFull(game, self.owner)
            ? null
            : {
              kind: "yesNo" as const,
              prompt: `Put a ${n}/${n} ${name} into an available space?`,
              optional: true,
            },
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Botanimate: replace an enemy creature (level <= N) with a 3/3 Sapling. ---
registerCard({
  defId: "botanimate",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, maxTargetLevel]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[opposing(player)].lanes
          .filter((c) => c && c.level <= maxTargetLevel)
          .map((c) => c!.uid);
        return options.length
          ? {
            kind: "enemyCreature" as const,
            prompt: maxTargetLevel === 99
              ? "Replace an enemy creature with a 3/3 Sapling"
              : `Replace an enemy level ${maxTargetLevel}${maxTargetLevel === 2 ? " or lower" : ""} creature with a 3/3 Sapling`,
            options,
          }
          : null;
      },
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) {
          spawnCreature(ctx.game, ctx.events, c.owner, "sapling", 1,
            { lane: c.lane, replace: true, overrideStats: { attack: 3, health: 3 } });
        }
      },
    }]),
  ),
});

// --- Cultivate: replace a friendly Plant with an N/N Treefolk. ---
registerCard({
  defId: "cultivate",
  spell: Object.fromEntries(
    ([[1, 9], [2, 14], [3, 21]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes
          .filter((c) => c && (game.state.cards[c.defId]?.subtypes ?? []).includes("Plant"))
          .map((c) => c!.uid);
        return options.length
          ? { kind: "friendlyCreature" as const, prompt: `Replace a friendly Plant with a ${n}/${n} Treefolk`, options }
          : null;
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) {
          spawnCreature(ctx.game, ctx.events, player, "treefolk", 1,
            { lane: c.lane, replace: true, overrideStats: { attack: n, health: n } });
        }
      },
    }]),
  ),
});

// --- Druid's Chant: you gain +N health. ---
registerCard({
  defId: "druids-chant",
  spell: Object.fromEntries(
    ([[1, 8], [2, 12], [3, 20]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        healPlayer(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});

// --- Enrage: give a creature +N/+N. ---
registerCard({
  defId: "enrage",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreature" as const,
        prompt: `Give a creature +${n} attack and +${n} health`,
        options: allCreatureUids(game),
      }),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, n);
      },
    }]),
  ),
});

// --- Feral Instinct: give a creature +N/+N and Breakthrough. ---
registerCard({
  defId: "feral-instinct",
  spell: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreature" as const,
        prompt: `Give a creature +${n} attack, +${n} health, and Breakthrough`,
        options: allCreatureUids(game),
      }),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) {
          buffCreature(ctx.game, ctx.events, c, n, n);
          grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 });
        }
      },
    }]),
  ),
});

// --- Natural Selection: if your board is full, destroy a creature (level <= N). ---
registerCard({
  defId: "natural-selection",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, maxTargetLevel]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        if (!boardFull(game, player)) return null;
        const options = allCreatureUids(game)
          .filter((u) => findCreature(game.state, u)!.level <= maxTargetLevel);
        return options.length
          ? {
            kind: "anyCreature" as const,
            prompt: maxTargetLevel === 99
              ? "Destroy a creature"
              : `Destroy a level ${maxTargetLevel}${maxTargetLevel === 2 ? " or lower" : ""} creature`,
            options,
          }
          : null;
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (!boardFull(ctx.game, player)) return;
        const c = targetOf(ctx, choice);
        if (c) destroyCreature(ctx.game, ctx.events, c);
      },
    }]),
  ),
});

// --- Phytobomb: put an N/N token into each player's available spaces. ---
registerCard({
  defId: "phytobomb",
  spell: Object.fromEntries(
    ([[1, "seedling", 1], [2, "sapling", 3], [3, "treefolk", 5]] as const).map(([lvl, token, n]) => [lvl, {
      resolve: (ctx: Ctx) => {
        for (const p of [0, 1] as const) {
          for (const lane of openLanes(ctx.game, p)) {
            spawnCreature(ctx.game, ctx.events, p, token, 1,
              { lane, overrideStats: { attack: n, health: n } });
          }
        }
      },
    }]),
  ),
});

// --- Primal Surge: give a creature +N/+N (L2/L3 are Free — keyword handled by engine). ---
registerCard({
  defId: "primal-surge",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreature" as const,
        prompt: `Give a creature +${n} attack and +${n} health`,
        options: allCreatureUids(game),
      }),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, n);
      },
    }]),
  ),
});

// --- Soothing Radiance: heal N damage from each friendly creature. ---
registerCard({
  defId: "soothing-radiance",
  spell: Object.fromEntries(
    ([[1, 6], [2, 12], [3, 24]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) healCreature(ctx.game, ctx.events, c, n);
        }
      },
    }]),
  ),
});

// --- Toxic Spores: give a creature Poison N. ---
registerCard({
  defId: "toxic-spores",
  spell: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreature" as const,
        prompt: `Give a creature Poison ${n}`,
        options: allCreatureUids(game),
      }),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
      },
    }]),
  ),
});
