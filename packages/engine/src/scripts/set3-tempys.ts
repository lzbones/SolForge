/**
 * Set 3 (Secrets of Solis) + 3.1 — Tempys card scripts, plus the Iztek and
 * Frostmane token cards. See docs/CARD_SCRIPTING.md.
 *
 * Solbind: iztek-khan-of-arrachtor binds izteks-frost + izteks-flame. Both are
 * Token spells in cards_Set_3.json (defIds "izteks-frost" / "izteks-flame"),
 * scripted below together with the two Avatar tokens they flip into; the
 * Frostmane Egg token spawned by Frostmane Dragon is scripted here too.
 *
 * Approximation notes (same conventions as set1-tempys.ts / set2-tempys.ts):
 *  - Frostmane Dragon: "if Frostmane Dragon was Forged last turn" is tracked
 *    by granting a one-shot turnStart ability (tempys:set3-frostmane-hatch) at
 *    Forge time — CreatureState has no entry-turn field. The granted ability
 *    consumes itself when it offers the egg, so declining does not re-prompt
 *    next turn. The egg lands in a RANDOM open space (the engine has no
 *    lane-choice kind), same as Ether Hounds / Echowisp.
 *  - Iztek's Frost: "until the end of the next turn" grants tempys:frozen-solid
 *    (set1-tempys.ts, identical rules text) plus a two-stage turnEnd expiry
 *    chain: the current turn's end advances stage 1 -> 2, the next turn's end
 *    removes both. The stage-2 cleanup removes every frozen-solid ref on the
 *    creature, including ones granted by other cards (same caveat as Uranti
 *    Bolt's Defender in set1-tempys.ts).
 *  - Iztek flips ("replace this with ...") use spawnCreature replace into the
 *    same space at the same level; the old body goes to the discard pile.
 *  - Herald of Destruction / Hammerfang key off anyCreatureEnterPlay, which
 *    fires for Forged and un-Forged entries alike (enemyCreatureEntered only
 *    fires for plays from hand). Herald's own condition excludes Forged ones.
 *  - Seal of Kadras L3 follows the scraped text literally: 25 damage ("Deal
 *    25 damage to target a or player" reads as "a creature or player") —
 *    text1..3 are the project's source of truth (Uranti Heartseeker precedent
 *    in set2-tempys.ts).
 *  - Ashurian Flamesculptor: the "Tempys spell of level N or lower" gate on
 *    the bonus play cannot be enforced; grants a full extra play
 *    (playsLeft + 1), same as Master of Elements / Static Shock.
 *  - "Discard and level up a card" (Oratek Battlebrand / Oratek Warhammer)
 *    reuses the discardAndLevel/levelUpCopy shape from set3-alloyin.ts; any
 *    hand card is a legal discard (Perilous Insight precedent).
 *  - Flamerift Instigator's Negate only lists creatures whose Defender is
 *    inherent/temp-granted: static-aura Defender cannot be negated (same limit
 *    as Uranti Icemage in set2-tempys.ts).
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, getStats, moveCreature,
  negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, opposing } from "../state.js";
import { maxLevel, type Faction } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

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

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[opposing(p)].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function openLanes(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
}

function hasFactionInHand(game: Game, p: PlayerId, faction: Faction): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

/** Damage a chosen creature or player (sentinels -1/-2 = players 0/1). */
function damageChoice(ctx: Ctx, choice: ChoiceAnswer | null, amount: number, source: CreatureState | null = null): void {
  const t = choice?.targetUid;
  if (t === undefined) return;
  if (t === -1) dealPlayerDamage(ctx.game, ctx.events, 0, amount, source);
  else if (t === -2) dealPlayerDamage(ctx.game, ctx.events, 1, amount, source);
  else {
    const c = findCreature(ctx.game.state, t);
    if (c) dealCreatureDamage(ctx.game, ctx.events, c, amount, source);
  }
}

/** "Discard and level up a card" — same shape as discardAndLevel in set3-alloyin.ts. */
function discardAndLevel(ctx: Ctx, player: PlayerId, handIndex: number): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  pl.hand.splice(handIndex, 1);
  pl.discard.push(inst);
  ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  levelUpCopy(ctx, player, inst);
}

/** Push the level+1 copy of a card into its owner's discard pile (mirrors game.ts). */
function levelUpCopy(ctx: Ctx, player: PlayerId, inst: CardInstance): void {
  const def = ctx.game.state.cards[inst.defId];
  if (!def || inst.level >= maxLevel(def)) return;
  ctx.game.state.players[player].discard.push({
    uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player,
  });
  ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
}

/** Iztek flip: replace this creature with the named Avatar at the same level. */
function flipIztek(ctx: Ctx, self: CreatureState, defId: string): void {
  spawnCreature(ctx.game, ctx.events, self.owner, defId, self.level, { lane: self.lane, replace: true });
}

// ---------- granted abilities ----------

// Iztek's Frost expiry chain, stage 1 -> stage 2 (see header note).
registerGranted("tempys:set3-frost-expire-1", {
  id: "tempys:set3-frost-expire-1",
  trigger: "turnEnd",
  resolve(_ctx, self) {
    self.grantedAbilities = self.grantedAbilities.map(
      (r) => (r === "tempys:set3-frost-expire-1" ? "tempys:set3-frost-expire-2" : r),
    );
  },
});
registerGranted("tempys:set3-frost-expire-2", {
  id: "tempys:set3-frost-expire-2",
  trigger: "turnEnd",
  resolve(_ctx, self) {
    self.grantedAbilities = self.grantedAbilities.filter(
      (r) => r !== "tempys:set3-frost-expire-2" && r !== "tempys:frozen-solid",
    );
  },
});

// Frostmane Dragon's one-shot "was Forged last turn" marker (see header note).
// Two-phase resolve: the first call consumes the marker and asks; the second
// (accepted) call puts the egg into a random open space. A decline never
// re-enters resolve, so the marker is gone either way.
registerGranted("tempys:set3-frostmane-hatch", {
  id: "tempys:set3-frostmane-hatch",
  trigger: "turnStart",
  condition: (game, self) => game.state.active === self.owner,
  resolve(ctx, self, _evt, choice) {
    if (choice === null) {
      self.grantedAbilities = self.grantedAbilities.filter((r) => r !== "tempys:set3-frostmane-hatch");
      if (!openLanes(ctx.game, self.owner).length) return;
      return {
        kind: "yesNo" as const,
        prompt: `Put a level ${self.level} Frostmane Egg into one of your available spaces?`,
        optional: true,
      };
    }
    spawnCreature(ctx.game, ctx.events, self.owner, "frostmane-egg", self.level, {});
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Ashurian Flamesculptor (Set 3.1; L2+ Forge: an additional Tempys spell) ---
registerCard({
  defId: "ashurian-flamesculptor",
  levels: {
    1: {}, // vanilla 5/3
    ...Object.fromEntries(
      [2, 3].map((lvl) => [lvl, {
        abilities: [{
          id: "extra-spell",
          trigger: "enterFromHand" as const,
          // level/faction gate on the bonus spell cannot be enforced (see header)
          resolve: (ctx: Ctx) => {
            ctx.game.state.playsLeft += 1;
          },
        }],
      }]),
    ),
  },
});

// --- Borean Stormweaver (Activate: deal N damage to a creature) ---
registerCard({
  defId: "borean-stormweaver",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "stormbolt",
        prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Cinderbound Barbarian (Forge at Rank gate: N damage to an enemy creature) ---
registerCard({
  defId: "cinderbound-barbarian",
  levels: Object.fromEntries(
    ([[1, 2, 6], [2, 3, 9], [3, 4, 12]] as const).map(([lvl, rank, n]) => [lvl, {
      abilities: [{
        id: "forge-burn",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].rank >= rank,
        prompt: (game: Game, self: CreatureState) => req(
          `Deal ${n} damage to an enemy creature`,
          "enemyCreature",
          enemyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Flamerift Instigator (Forge: Negate Defender from a creature) ---
registerCard({
  defId: "flamerift-instigator",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-melt",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game) => req(
          "Negate Defender from a creature",
          "anyCreature",
          // static-aura Defender cannot be negated (see header note)
          boardUids(game, (c) =>
            c.keywords.some((k) => k.keyword === "Defender")
            || c.tempKeywords.some((k) => k.keyword === "Defender")),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) negateKeyword(ctx.events, c, "Defender");
        },
      }],
    }]),
  ),
});

// --- Frostfang Maiden (when a friendly creature moves, N to the creature opposing it) ---
// "a friendly creature" includes the maiden itself (Emberwind Evoker precedent):
// friendlyCreatureMoved skips the mover, so a moved trigger covers self-moves.
registerCard({
  defId: "frostfang-maiden",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "frostbite-self",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const opp = opposingCreature(ctx.game, self);
            if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, n, self);
          },
        },
        {
          id: "frostbite",
          trigger: "friendlyCreatureMoved" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            const mover = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
            if (!mover) return;
            const opp = ctx.game.state.players[opposing(mover.owner)].lanes[mover.lane];
            if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, n, self);
          },
        },
      ],
    }]),
  ),
});

// --- Frostmane Dragon (start of your turn after being Forged: optional Egg) ---
registerCard({
  defId: "frostmane-dragon",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "lay-egg",
        trigger: "enterFromHand" as const,
        resolve: (_ctx: Ctx, self: CreatureState) => {
          if (!self.grantedAbilities.includes("tempys:set3-frostmane-hatch")) {
            self.grantedAbilities.push("tempys:set3-frostmane-hatch");
          }
        },
      }],
    }]),
  ),
});

// --- Frostmane Egg (token; when you gain a Rank, replace with same-level Dragon) ---
registerCard({
  defId: "frostmane-egg",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "hatch",
        trigger: "rankGained" as const,
        // rankGained fires during the ranking player's endTurn, while they are still active
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "frostmane-dragon", self.level, { lane: self.lane, replace: true });
        },
      }],
    }]),
  ),
});

// --- Hammerfang (enemy enters play opposing it: move to a random open space) ---
registerCard({
  defId: "hammerfang",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "sidestep",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === opposing(self.owner) && evt.lane === self.lane,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const open = openLanes(ctx.game, self.owner);
          if (open.length) moveCreature(ctx.game, ctx.events, self, ctx.rng.pick(open));
        },
      }],
    }]),
  ),
});

// --- Herald of Destruction (un-Forged enemy entry: attack damage to that player) ---
registerCard({
  defId: "herald-of-destruction",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "omen",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === opposing(self.owner) && !evt.fromHand,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          dealPlayerDamage(
            ctx.game, ctx.events,
            evt.sourceOwner ?? opposing(self.owner),
            getStats(ctx.game, self).attack,
            self,
          );
        },
      }],
    }]),
  ),
});

// --- Iztek, Khan of Arrachtor (Solbind; Iztek spells flip it into Avatars) ---
registerCard({
  defId: "iztek-khan-of-arrachtor",
  solbind: ["izteks-frost", "izteks-flame"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "ascend",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && (evt.sourceDefId === "izteks-frost" || evt.sourceDefId === "izteks-flame"),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          flipIztek(ctx, self, evt.sourceDefId === "izteks-frost" ? "iztek-avatar-of-frost" : "iztek-avatar-of-flame");
        },
      }],
    }]),
  ),
});

// --- Iztek, Avatar of Flame (token; battle damage to a player is dealt again;
//     flips to Avatar of Frost when you play Iztek's Frost) ---
registerCard({
  defId: "iztek-avatar-of-flame",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [
        {
          id: "double-tap",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            // ability damage, NOT battle damage (battle=true would retrigger itself)
            dealPlayerDamage(ctx.game, ctx.events, evt.targetPlayer ?? opposing(self.owner), evt.amount ?? 0, self);
          },
        },
        {
          id: "chill",
          trigger: "spellPlayed" as const,
          condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner && evt.sourceDefId === "izteks-frost",
          resolve: (ctx: Ctx, self: CreatureState) => {
            flipIztek(ctx, self, "iztek-avatar-of-frost");
          },
        },
      ],
    }]),
  ),
});

// --- Iztek, Avatar of Frost (token; Activate: N to a creature; flips to
//     Avatar of Flame when you play Iztek's Flame) ---
registerCard({
  defId: "iztek-avatar-of-frost",
  levels: Object.fromEntries(
    ([[1, 2], [2, 5], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "blaze",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceDefId === "izteks-flame",
        resolve: (ctx: Ctx, self: CreatureState) => {
          flipIztek(ctx, self, "iztek-avatar-of-flame");
        },
      }],
      activates: [{
        id: "frostbolt",
        prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Oratek Warhammer (Allied Alloyin: battle damage to a player on your
//     turn -> you may discard and level up a card) ---
registerCard({
  defId: "oratek-warhammer",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "allied-alloyin",
        trigger: "battleDamageToPlayer" as const,
        targeted: true,
        // enemy creatures can deal battle damage during the enemy's battle; "on your turn" excludes that
        condition: (game: Game, self: CreatureState) =>
          game.state.active === self.owner && hasFactionInHand(game, self.owner, "Alloyin"),
        prompt: (game: Game, self: CreatureState) => req(
          "You may discard and level up a card",
          "cardInHand",
          game.state.players[self.owner].hand.map((_, i) => i),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Burnout (Overload; 8 damage to a creature or player) ---
registerCard({
  defId: "burnout",
  spell: {
    1: {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: "Deal 8 damage to a creature or player",
        options: [-1, -2, ...boardUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        damageChoice(ctx, choice, 8);
      },
    },
  },
});

// --- Iztek's Flame (Solbind token; N damage to a creature or player) ---
registerCard({
  defId: "izteks-flame",
  spell: Object.fromEntries(
    ([[1, 6], [2, 9], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: `Deal ${n} damage to a creature or player`,
        options: [-1, -2, ...boardUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        damageChoice(ctx, choice, n);
      },
    }]),
  ),
});

// --- Iztek's Frost (Solbind token; "when dealt damage, destroy it" until the
//     end of the next turn — expiry chain in the header note; L3 Free is an
//     inherent keyword from the card data) ---
registerCard({
  defId: "izteks-frost",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 2
          ? "Give a level 2 or lower creature \"When this creature is dealt damage, destroy it\" until the end of the next turn"
          : "Give a creature \"When this creature is dealt damage, destroy it\" until the end of the next turn",
        "anyCreature",
        boardUids(game, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        c.grantedAbilities.push("tempys:frozen-solid", "tempys:set3-frost-expire-1");
      },
    }]),
  ),
});

// --- Oratek Battlebrand (N to a creature; Allied Alloyin: chained optional
//     discard-and-level-up) ---
registerCard({
  defId: "oratek-battlebrand",
  spell: Object.fromEntries(
    ([[1, 7], [2, 10], [3, 13]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        // priorAnswers includes the current answer: 0 = fizzle (no target was
        // available), 1 = damage step, 2 = the Allied discard step.
        if (ctx.priorAnswers.length >= 2) {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, player, choice.handIndex);
          return;
        }
        const c = targetOf(ctx, choice);
        if (c) dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (!hasFactionInHand(ctx.game, player, "Alloyin")) return; // no Allied rider
        const hand = ctx.game.state.players[player].hand;
        if (!hand.length) return;
        return {
          kind: "cardInHand" as const,
          prompt: "You may discard and level up a card",
          options: hand.map((_, i) => i),
          optional: true,
        };
      },
    }]),
  ),
});

// --- Rage of Kadras (Set 3.1, Overload; friendly Tempys +1 attack, then each
//     deals its attack to the creature opposing it) ---
registerCard({
  defId: "rage-of-kadras",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (!c || ctx.game.state.cards[c.defId]?.faction !== "Tempys") continue;
          buffCreature(ctx.game, ctx.events, c, 1, 0); // permanent ("gets +1 attack", no "this turn")
          const opp = ctx.game.state.players[opposing(player)].lanes[c.lane];
          if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, getStats(ctx.game, c).attack, c);
        }
      },
    },
  },
});

// --- Seal of Kadras (N damage to a creature or player; L3 is 25 per the
//     scraped text — see header note) ---
registerCard({
  defId: "seal-of-kadras",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 25]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: `Deal ${n} damage to a creature or player`,
        options: [-1, -2, ...boardUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        damageChoice(ctx, choice, n);
      },
    }]),
  ),
});
