/**
 * Set 1 (Alpha) card scripts — exemplar batch covering each keyword family.
 * Remaining Set 1 cards are scripted in set1-rest.ts (M3c).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, drawCardsEffect,
  grantKeyword, spawnCreature, getStats,
} from "../effects.js";
import { findCreature } from "../state.js";

// --- Lightning Spark: Deal N damage to a creature or player. ---
registerCard({
  defId: "lightning-spark",
  spell: {
    1: {
      prompt: (game, player) => ({
        kind: "anyCreatureOrPlayer", prompt: "Deal 6 damage to a creature or player",
        options: targetableThings(game),
      }),
      resolve: (ctx, player, choice) => {
        damageChoice(ctx, choice, 6);
      },
    },
    2: {
      prompt: (game) => ({ kind: "anyCreatureOrPlayer", prompt: "Deal 8 damage to a creature or player", options: targetableThings(game) }),
      resolve: (ctx, player, choice) => damageChoice(ctx, choice, 8),
    },
    3: {
      prompt: (game) => ({ kind: "anyCreatureOrPlayer", prompt: "Deal 12 damage to a creature or player", options: targetableThings(game) }),
      resolve: (ctx, player, choice) => damageChoice(ctx, choice, 12),
    },
  },
});

/** creature uids (positive) + player sentinel ids encoded as -1/-2. */
function targetableThings(game: import("../game.js").Game): number[] {
  const out: number[] = [-1, -2];
  for (const side of game.state.players) for (const c of side.lanes) if (c) out.push(c.uid);
  return out;
}

function damageChoice(ctx: import("../triggers.js").Ctx, choice: import("../triggers.js").ChoiceAnswer | null, amount: number): void {
  const t = choice?.targetUid;
  if (t === undefined || t === null) return;
  if (t === -1) dealPlayerDamage(ctx.game, ctx.events, 0, amount);
  else if (t === -2) dealPlayerDamage(ctx.game, ctx.events, 1, amount);
  else {
    const c = findCreature(ctx.game.state, t);
    if (c) dealCreatureDamage(ctx.game, ctx.events, c, amount);
  }
}

// --- Ferocious Roar: each friendly creature gets +N/+N (L3: and Breakthrough). ---
const roar: Record<number, { a: number; h: number; bt: boolean }> = {
  1: { a: 2, h: 2, bt: false }, 2: { a: 3, h: 3, bt: false }, 3: { a: 5, h: 5, bt: true },
};
registerCard({
  defId: "ferocious-roar",
  spell: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      resolve: (ctx: import("../triggers.js").Ctx, player: import("../state.js").PlayerId) => {
        const { a, h, bt } = roar[lvl]!;
        for (const c of ctx.game.state.players[player].lanes) {
          if (!c) continue;
          buffCreature(ctx.game, ctx.events, c, a, h);
          if (bt) grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 });
        }
      },
    }]),
  ),
});

// --- Aegis Conscript (Forge: give a friendly creature Armor X) ---
registerCard({
  defId: "aegis-conscript",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "forge-armor",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: import("../game.js").Game, self: import("../state.js").CreatureState) => ({
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature Armor ${armor}`,
          options: game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.uid),
          optional: true,
        }),
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState, _evt: unknown, choice: import("../triggers.js").ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Ashurian Mystic (Aggressive; battle damage to player -> +N/+N) ---
registerCard({
  defId: "ashurian-mystic",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "grow",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Death Seeker (Vengeance: put an N/N Spirit into this space) ---
registerCard({
  defId: "death-seeker",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-spirit",
        trigger: "destroyed" as const,
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState, evt: import("../triggers.js").TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "spirit-nekrium", 1,
            { lane: evt.lane ?? "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Grimgaunt Devourer (when a creature is destroyed, +N/+N) ---
registerCard({
  defId: "grimgaunt-devourer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "devour",
        trigger: "anyCreatureDestroyed" as const,
        condition: (game: import("../game.js").Game, self: import("../state.js").CreatureState, evt: import("../triggers.js").TriggerPayload) => evt.sourceUid !== self.uid,
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Firefist Uranti (Activate: deal damage equal to its attack to a creature) ---
registerCard({
  defId: "firefist-uranti",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "firefist",
        prompt: (game: import("../game.js").Game) => ({
          kind: "anyCreature" as const,
          prompt: "Deal damage equal to Firefist Uranti's Attack to a creature",
          options: targetableThings(game).filter((uid) => uid > 0),
        }),
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState, choice: import("../triggers.js").ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, getStats(ctx.game, self).attack, self);
        },
      }],
    }]),
  ),
});

// --- Brightsteel Gargoyle (Mobility; end of your turn: Armor X + Defender until end of next turn) ---
registerCard({
  defId: "brightsteel-gargoyle",
  levels: Object.fromEntries(
    ([[1, 2], [2, 5], [3, 10]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "brace",
        trigger: "turnEnd" as const,
        condition: (game: import("../game.js").Game, self: import("../state.js").CreatureState) => game.state.active === self.owner,
        resolve: (ctx: import("../triggers.js").Ctx, self: import("../state.js").CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor }, true);
          grantKeyword(ctx.events, self, { keyword: "Defender", value: 0 }, true);
        },
      }],
    }]),
  ),
});

// --- Aerial Surge (give a creature Mobility X) ---
registerCard({
  defId: "aerial-surge",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, mob]) => [lvl, {
      prompt: (game: import("../game.js").Game) => ({
        kind: "anyCreature" as const,
        prompt: `Give a creature Mobility ${mob}`,
        options: targetableThings(game).filter((uid) => uid > 0),
      }),
      resolve: (ctx: import("../triggers.js").Ctx, _p: import("../state.js").PlayerId, choice: import("../triggers.js").ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (c) grantKeyword(ctx.events, c, { keyword: "Mobility", value: mob });
      },
    }]),
  ),
});

// --- Energy Surge (draw N cards) ---
registerCard({
  defId: "energy-surge",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: import("../triggers.js").Ctx, player: import("../state.js").PlayerId) => {
        drawCardsEffect(ctx.game, ctx.events, player, n);
      },
    }]),
  ),
});
