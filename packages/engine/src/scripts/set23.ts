/**
 * Set 2.3 patch-set card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set21.ts / set22.ts):
 *  - Power Torrent is a Set 2.3 card but is already scripted in
 *    set5-alloyin.ts (Set 5 support card for Torrent Acolyte) — not
 *    re-registered here.
 *  - Fangwood Bear is vanilla (empty text): no script required.
 *  - Netherdrake is the Token spawned by Nethershriek; it is scripted below as
 *    a support card (ice-torrent convention from set5-tempys.ts). Its L3
 *    Mobility 1 is inherent from the data. Nethershriek has no prompt, and
 *    prompt-less spells resolve outside a trigger batch (game.ts
 *    resolveSpell), so the spawn's enterPlay triggers would be dropped;
 *    Nethershriek collects and runs its own spawn batch (collectInto +
 *    runBatches) to deliver the drake's entry-slay.
 *  - Frostshatter Strike has two independent targets; it is a two-leg choice
 *    (enemy damage, then the friendly buff). Either prompt can fizzle on its
 *    own (empty side), so the leg is detected by the answered target's owner,
 *    not by ctx.priorAnswers.length.
 *  - Legion Titan / Cindersmoke Wyvern read CURRENT attack (getStats —
 *    buffs and static auras included) for "3 or less attack" / "its attack".
 *  - Ironmind Acolyte: "you may play an additional card this turn" is
 *    emulated via playsLeft += 1 (Static Shock / Master of Elements
 *    convention from set1-tempys.ts); it cannot be gated to a real "may".
 *  - Umbruk Icecrusher's second hit is non-battle damage, so it does not
 *    re-trigger itself.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, collectInto, dealCreatureDamage, dealPlayerDamage, destroyCreature, drawCardsEffect,
  getStats, grantKeyword, healCreature, runBatches, spawnCreature,
} from "../effects.js";
import {
  findCreature, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, ResolveResult, TriggerPayload } from "../triggers.js";

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

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

/** Allied condition: a card of `faction` remains in the controller's hand. */
function hasFactionInHand(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

/** "Discard and level up a card" — same shape as discardAndLevel in set2-alloyin.ts. */
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
// Creatures
// ============================================================

// --- Byzerak Frostmaiden: Forge/Flank — if opposed, the opposing creature
//     gets -N attack and this gets +N attack; Allied Tempys: Mobility N. ---
registerCard({
  defId: "byzerak-frostmaiden",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => {
      const drain = (ctx: Ctx, self: CreatureState) => {
        const foe = opposingCreature(ctx.game, self);
        if (!foe) return;
        buffCreature(ctx.game, ctx.events, foe, -n, 0);
        buffCreature(ctx.game, ctx.events, self, n, 0);
      };
      const isOpposed = (game: Game, self: CreatureState) => !!opposingCreature(game, self);
      return [lvl, {
        abilities: [
          // played into an opposed space
          { id: "forge-drain", trigger: "enterFromHand" as const, condition: isOpposed, resolve: drain },
          // moved into an opposed space (Flank)
          { id: "flank-drain", trigger: "moved" as const, condition: isOpposed, resolve: drain },
          {
            id: "allied-mobility",
            trigger: "enterFromHand" as const,
            condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Tempys"),
            resolve: (ctx: Ctx, self: CreatureState) => {
              grantKeyword(ctx.events, self, { keyword: "Mobility", value: lvl });
            },
          },
        ],
      }];
    }),
  ),
});

// --- Cindersmoke Wyvern: Flank — deal damage equal to its attack to the
//     opposing creature, else to the enemy player (Mobility is inherent). ---
registerCard({
  defId: "cindersmoke-wyvern",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "flank-strike",
        trigger: "moved" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const amount = getStats(ctx.game, self).attack;
          if (amount <= 0) return;
          const foe = opposingCreature(ctx.game, self);
          if (foe) dealCreatureDamage(ctx.game, ctx.events, foe, amount, self);
          else dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), amount, self);
        },
      }],
    }]),
  ),
});

// --- Esperian Steelplate: Activate — heal N damage from each friendly
//     creature; Allied Alloyin: Armor N. ---
registerCard({
  defId: "esperian-steelplate",
  levels: Object.fromEntries(
    ([[1, 3, 2], [2, 5, 4], [3, 8, 7]] as const).map(([lvl, n, armor]) => [lvl, {
      abilities: [{
        id: "allied-armor",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Alloyin"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
        },
      }],
      activates: [{
        id: "mass-heal",
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) healCreature(ctx.game, ctx.events, c, n);
          }
        },
      }],
    }]),
  ),
});

// --- Ironmind Acolyte: Forge — if you have five or more cards in hand, you
//     may play an additional card this turn (playsLeft — see header). ---
registerCard({
  defId: "ironmind-acolyte",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-extra-play",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].hand.length >= 5,
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += 1;
        },
      }],
    }]),
  ),
});

// --- Legion Titan: Forge — +N/+N for each enemy creature with cap or less
//     attack (current attack — see header). ---
registerCard({
  defId: "legion-titan",
  levels: Object.fromEntries(
    ([[1, 1, 3], [2, 2, 5], [3, 3, 6]] as const).map(([lvl, n, cap]) => [lvl, {
      abilities: [{
        id: "forge-legion",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[opposing(self.owner)].lanes
            .filter((c): c is CreatureState => !!c && getStats(ctx.game, c).attack <= cap).length;
          if (count) buffCreature(ctx.game, ctx.events, self, n * count, n * count);
        },
      }],
    }]),
  ),
});

// --- Onyxium Allomancer: Allied Nekrium: Regenerate N; Activate — discard
//     and level up a card. ---
registerCard({
  defId: "onyxium-allomancer",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "allied-regen",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Nekrium"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: n });
        },
      }],
      activates: [{
        id: "recycle",
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].hand.length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Discard and level up a card",
          "cardInHand",
          game.state.players[self.owner].hand.map((_, i) => i),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Sorrow Harvester: when a friendly Abomination is destroyed on your
//     turn, draw a card. ---
registerCard({
  defId: "sorrow-harvester",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "harvest",
        trigger: "friendlyCreatureDestroyed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          game.state.active === self.owner
          && !!evt.sourceDefId && hasSubtype(game, evt.sourceDefId, "Abomination"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          drawCardsEffect(ctx.game, ctx.events, self.owner, 1);
        },
      }],
    }]),
  ),
});

// --- Stranglevine Hydra: when it deals battle damage to a player, it gets
//     Regenerate N. ---
registerCard({
  defId: "stranglevine-hydra",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "battle-regen",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: n });
        },
      }],
    }]),
  ),
});

// --- Umbruk Icecrusher: Allied Uterra: +2/+2 and Breakthrough; when it deals
//     battle damage to a player, deal that much to that player again. ---
registerCard({
  defId: "umbruk-icecrusher",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "allied-uterra",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Uterra"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, 2, 2);
            grantKeyword(ctx.events, self, { keyword: "Breakthrough", value: 0 });
          },
        },
        {
          id: "double-strike",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            const amount = evt.amount ?? 0;
            if (amount <= 0) return;
            dealPlayerDamage(ctx.game, ctx.events, evt.targetPlayer ?? opposing(self.owner), amount, self);
          },
        },
      ],
    }]),
  ),
});

// --- Uranti Warstoker: Forge — each other friendly Yeti gets +N attack this
//     turn. ---
registerCard({
  defId: "uranti-warstoker",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-stoke",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid && hasSubtype(ctx.game, c.defId, "Yeti")) {
              buffCreature(ctx.game, ctx.events, c, n, 0, true);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Uterradon Ridgeback: when it deals battle damage to a player on your
//     turn, each friendly creature gets +N/+N (L3: and Breakthrough).
//     Breakthrough is inherent. ---
registerCard({
  defId: "uterradon-ridgeback",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "battle-rally",
        trigger: "battleDamageToPlayer" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c) continue;
            buffCreature(ctx.game, ctx.events, c, n, n);
            if (lvl === 3) grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 });
          }
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells (+ Netherdrake support token for Nethershriek)
// ============================================================

// --- Frostshatter Strike: N damage to an enemy creature, then a friendly
//     creature gets +N attack this turn (two-leg choice — see header). ---
registerCard({
  defId: "frostshatter-strike",
  spell: Object.fromEntries(
    ([[1, 4], [2, 7], [3, 11]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Deal ${n} damage to an enemy creature`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null): ResolveResult => {
        const c = targetOf(ctx, choice);
        // second leg: the friendly-buff answer names a creature you own
        if (c && c.owner === player) {
          buffCreature(ctx.game, ctx.events, c, n, 0, true);
          return;
        }
        // first leg: enemy damage (choice null = no enemy creature was available)
        if (c) dealCreatureDamage(ctx.game, ctx.events, c, n);
        return req(
          `Give a friendly creature +${n} attack this turn`,
          "friendlyCreature",
          friendlyUids(ctx.game, player),
        ) ?? undefined;
      },
    }])),
});

// --- Nethershriek: Spawn a Netherdrake (level = spell level; the drake's
//     stats and abilities come from its own def — see below). Prompt-less
//     spells resolve outside a batch, so the spawn batch is run here (header).
registerCard({
  defId: "nethershriek",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const initial = collectInto(() => {
          spawnCreature(ctx.game, ctx.events, player, "netherdrake", lvl, {});
        });
        runBatches(ctx.game, ctx.events, initial);
      },
    }])),
});

// --- Netherdrake (Set 2.3 Token, support card for Nethershriek — see
//     header): when it enters play or moves into a lane, destroy the opposing
//     level-cap-or-lower creature (L3: any level). ---
registerCard({
  defId: "netherdrake",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => {
      const slay = (ctx: Ctx, self: CreatureState) => {
        const foe = opposingCreature(ctx.game, self);
        if (foe && foe.level <= cap) destroyCreature(ctx.game, ctx.events, foe);
      };
      return [lvl, {
        abilities: [
          { id: "entry-slay", trigger: "enterPlay" as const, resolve: slay },
          { id: "move-slay", trigger: "moved" as const, resolve: slay },
        ],
      }];
    }),
  ),
});

// --- Sonic Burst: give a creature -N attack. ---
registerCard({
  defId: "sonic-burst",
  spell: Object.fromEntries(
    ([[1, 8], [2, 9], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Give a creature −${n} attack`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
      },
    }])),
});
