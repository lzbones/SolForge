/**
 * Set 3 (Secrets of Solis) + 3.1 — Alloyin card scripts, plus the neutral
 * Iron Maiden. See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set2-alloyin.ts):
 *  - Killion L3: "Level up a card in your hand and discard pile" is read as
 *    one card from your hand AND one from your discard pile (two chained
 *    choices). Leveling a card in the deck/discard replaces it in place with
 *    the next-level version; leveling a hand card keeps the original in hand
 *    and puts the leveled copy into the discard (mirrors game.ts levelUpCopy).
 *  - Killion L4 levels the discard BEFORE adding hand copies, so the fresh
 *    copies are not leveled a second time.
 *  - Forge Guardian Delta: "put a N/N Forge Guardian Omega into your discard
 *    pile" pushes a level-matching forge-guardian-omega instance (its token
 *    levels are exactly 25/25, 50/50, 80/80) and reuses the "discard" event.
 *  - Nanoswarm: "remove all of its abilities" is modeled as silence (same as
 *    Metasculpt in set1-alloyin.ts): triggered/granted abilities stop firing;
 *    keywords, static auras and Activate abilities are unaffected.
 *  - Oratek Explosives: the Allied rider is a granted battleDamageToPlayer
 *    ability plus a turnEnd expire ref (same pattern as nekrium:keeper-expire),
 *    giving it "this turn" duration.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, grantKeyword,
} from "../effects.js";
import { allCreatures, findCreature, opposing } from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { Ability, ChoiceAnswer, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function boardCreatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

/** Allied condition: a card of `faction` remains in the player's hand. */
function handHasFaction(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand
    .some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

/** "Discard and level up a card" — same shape as discardAndLevel in set2-alloyin.ts. */
function discardAndLevel(ctx: Ctx, player: PlayerId, handIndex: number): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  pl.hand.splice(handIndex, 1);
  pl.discard.push(inst);
  ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  levelUpCopy(ctx, player, inst);
}

/** Push the level+1 copy of a card into its owner's discard pile. */
function levelUpCopy(ctx: Ctx, player: PlayerId, inst: CardInstance): void {
  const def = ctx.game.state.cards[inst.defId];
  if (!def || inst.level >= maxLevel(def)) return;
  ctx.game.state.players[player].discard.push({
    uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player,
  });
  ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
}

/** Level a deck/discard card in place (Killion). */
function levelCardInPlace(ctx: Ctx, player: PlayerId, inst: CardInstance): void {
  const def = ctx.game.state.cards[inst.defId];
  if (!def || inst.level >= maxLevel(def)) return;
  inst.level += 1;
  ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level - 1, toLevel: inst.level });
}

/** Hand indexes of cards that can still level up. */
function levelableHand(game: Game, p: PlayerId): number[] {
  return game.state.players[p].hand
    .map((inst, i) => {
      const def = game.state.cards[inst.defId];
      return def && inst.level < maxLevel(def) ? i : -1;
    })
    .filter((i) => i >= 0);
}

/** Discard-pile indexes of cards at `gate` level or lower that can still level up. */
function levelableDiscard(game: Game, p: PlayerId, gate: number): number[] {
  return game.state.players[p].discard
    .map((inst, i) => {
      const def = game.state.cards[inst.defId];
      return def && inst.level <= gate && inst.level < maxLevel(def) ? i : -1;
    })
    .filter((i) => i >= 0);
}

// ============================================================
// Creatures
// ============================================================

// --- Cerebral Scout (Forge: you may discard and level up a Metamind) ---
registerCard({
  defId: "cerebral-scout",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "recycle-metamind",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].hand
            .map((inst, i) => game.state.cards[inst.defId]?.subtypes.includes("Metamind") ? i : -1)
            .filter((i) => i >= 0);
          if (!options.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "You may discard and level up a Metamind",
            options,
            optional: true,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Cypien Shieldwarden (Activate: give a creature Armor N this turn) ---
registerCard({
  defId: "cypien-shieldwarden",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, armor]) => [lvl, {
      activates: [{
        id: "shield",
        prompt: (game: Game) => {
          const options = boardCreatureUids(game);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give a creature Armor ${armor} this turn`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor }, true);
        },
      }],
    }]),
  ),
});

// --- Forge Guardian Delta (Solbind Alpha/Beta/Gamma; enters play with all
//     three in play -> a level-matching Forge Guardian Omega hits the discard) ---
registerCard({
  defId: "forge-guardian-delta",
  solbind: ["forge-guardian-alpha", "forge-guardian-beta", "forge-guardian-gamma"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "assemble-omega",
        trigger: "enterPlay" as const, // "When Forge Guardian Delta enters play"
        condition: (game: Game, self: CreatureState) => {
          const present = new Set(
            game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.defId),
          );
          return present.has("forge-guardian-alpha")
            && present.has("forge-guardian-beta")
            && present.has("forge-guardian-gamma");
        },
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].discard.push({
            uid: ctx.game.state.nextUid++, defId: "forge-guardian-omega", level: self.level, owner: self.owner,
          });
          ctx.events.push({ type: "discard", player: self.owner, defId: "forge-guardian-omega", level: self.level });
        },
      }],
    }]),
  ),
});

// --- Ironbound Reinforcements (Forge: at Rank N+, give a creature +N attack) ---
registerCard({
  defId: "ironbound-reinforcements",
  levels: Object.fromEntries(
    ([[1, 2, 5], [2, 3, 8], [3, 4, 12]] as const).map(([lvl, rank, n]) => [lvl, {
      abilities: [{
        id: "forge-buff",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => game.state.players[self.owner].rank >= rank,
        prompt: (game: Game) => {
          const options = boardCreatureUids(game);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
        },
      }],
    }]),
  ),
});

// --- Killion, Infinity Warden (4-level Forgeborn; Forge: level up cards) ---
function killionDiscard(gate: number): Ability {
  return {
    id: "forge-level-discard",
    trigger: "enterFromHand" as const,
    targeted: true,
    prompt: (game: Game, self: CreatureState) => {
      const options = levelableDiscard(game, self.owner, gate);
      if (!options.length) return null;
      return {
        kind: "cardInDiscard" as const,
        prompt: gate === 1
          ? "Level up a level 1 card in your discard pile"
          : `Level up a level ${gate} or lower card in your discard pile`,
        options,
      };
    },
    resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
      if (choice?.handIndex === undefined) return;
      const inst = ctx.game.state.players[self.owner].discard[choice.handIndex];
      if (inst) levelCardInPlace(ctx, self.owner, inst);
    },
  };
}

// L3: "Level up a card in your hand and discard pile" — one card from each.
// The hand choice is always offered first when the hand has a levelable card,
// and state is unchanged between prompt and resolve, so at resolve time a
// levelable hand means the current answer is the hand half.
const killionHandAndDiscard = (): Ability => ({
  id: "forge-level-hand-discard",
  trigger: "enterFromHand" as const,
  targeted: true,
  prompt: (game: Game, self: CreatureState) => {
    const handOpts = levelableHand(game, self.owner);
    if (handOpts.length) {
      return { kind: "cardInHand" as const, prompt: "Level up a card in your hand", options: handOpts };
    }
    const discOpts = levelableDiscard(game, self.owner, 99);
    if (discOpts.length) {
      return { kind: "cardInDiscard" as const, prompt: "Level up a card in your discard pile", options: discOpts };
    }
    return null;
  },
  resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
    if (choice?.handIndex === undefined) return;
    if (ctx.priorAnswers.length === 1 && levelableHand(ctx.game, self.owner).length) {
      const inst = ctx.game.state.players[self.owner].hand[choice.handIndex];
      if (inst) levelUpCopy(ctx, self.owner, inst);
      const discOpts = levelableDiscard(ctx.game, self.owner, 99);
      if (!discOpts.length) return;
      return {
        kind: "cardInDiscard" as const,
        prompt: "Level up a card in your discard pile",
        options: discOpts,
      };
    }
    const inst = ctx.game.state.players[self.owner].discard[choice.handIndex];
    if (inst) levelCardInPlace(ctx, self.owner, inst);
  },
});

// L4: "Level up each card in your hand, deck, and discard pile."
const killionAll = (): Ability => ({
  id: "forge-level-all",
  trigger: "enterFromHand" as const,
  resolve: (ctx: Ctx, self: CreatureState) => {
    const pl = ctx.game.state.players[self.owner];
    for (const inst of pl.deck) levelCardInPlace(ctx, self.owner, inst);
    for (const inst of [...pl.discard]) levelCardInPlace(ctx, self.owner, inst); // before hand copies land
    for (const inst of [...pl.hand]) levelUpCopy(ctx, self.owner, inst);
  },
});
registerCard({
  defId: "killion-infinity-warden",
  levels: {
    1: { abilities: [killionDiscard(1)] },
    2: { abilities: [killionDiscard(2)] },
    3: { abilities: [killionHandAndDiscard()] },
    4: { abilities: [killionAll()] },
  },
});

// --- Nexus Gunner (Activate, center space only: give a creature +N attack) ---
registerCard({
  defId: "nexus-gunner",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "center-shot",
        condition: (_game: Game, self: CreatureState) => self.lane === 2,
        prompt: (game: Game) => {
          const options = boardCreatureUids(game);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
        },
      }],
    }]),
  ),
});

// --- Steelskin Spelunker (Forge: the other friendly center-space creature gets Armor N) ---
registerCard({
  defId: "steelskin-spelunker",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "forge-armor-center",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => {
          const c = game.state.players[self.owner].lanes[2];
          return !!c && c.uid !== self.uid;
        },
        resolve: (ctx: Ctx, self: CreatureState) => {
          const c = ctx.game.state.players[self.owner].lanes[2];
          if (c && c.uid !== self.uid) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Forge Oracle (Forge: you may discard and level up an Alloyin card) ---
registerCard({
  defId: "forge-oracle",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "recycle-alloyin",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].hand
            .map((inst, i) => game.state.cards[inst.defId]?.faction === "Alloyin" ? i : -1)
            .filter((i) => i >= 0);
          if (!options.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "You may discard and level up an Alloyin card",
            options,
            optional: true,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Nexus Aeronaut (center: other friendly creatures +N attack; else: self Armor N) ---
registerCard({
  defId: "nexus-aeronaut",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "center-or-armor",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (self.lane === 2) {
            if (target.uid !== self.uid && target.owner === self.owner) stats.attack += n;
          } else if (target.uid === self.uid) {
            stats.keywords.push({ keyword: "Armor", value: n });
          }
        },
      }],
    }]),
  ),
});

// --- Iron Maiden (neutral Legendary; L3: when dealt damage, deal that much
//     to the enemy player; L1 vanilla, L2 Consistent — keyword only) ---
registerCard({
  defId: "iron-maiden",
  levels: {
    1: {},
    2: {},
    3: {
      abilities: [{
        id: "retaliate",
        trigger: "damaged" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.amount) {
            dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), evt.amount, self);
          }
        },
      }],
    },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Nanoswarm (give a (level-gated) creature −N attack and remove its abilities) ---
registerCard({
  defId: "nanoswarm",
  spell: Object.fromEntries(
    ([[1, 5, 1], [2, 10, 2], [3, 15, 99]] as const).map(([lvl, n, gate]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game, (c) => c.level <= gate);
        if (!options.length) return null;
        const what = gate === 1 ? "a level 1 creature" : gate === 2 ? "a level 2 or lower creature" : "a creature";
        return {
          kind: "anyCreature" as const,
          prompt: `Give ${what} −${n} attack and remove all of its abilities`,
          options,
        };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, -n, 0);
        c.silenced = true;
      },
    }]),
  ),
});

// --- Oratek Explosives (friendly creature +5 attack; Allied Tempys: this turn,
//     its battle damage to a player also hits N enemy creatures) ---
for (const lvl of [1, 2, 3] as const) {
  registerGranted(`alloyin:oratek-boom-${lvl}`, {
    id: `alloyin:oratek-boom-${lvl}`,
    trigger: "battleDamageToPlayer",
    resolve(ctx, self, evt) {
      const amount = evt.amount ?? 0;
      if (amount <= 0) return;
      const foes = ctx.game.state.players[opposing(self.owner)].lanes
        .filter((c): c is CreatureState => !!c);
      if (!foes.length) return;
      const targets =
        lvl === 1 ? [ctx.rng.pick(foes)]
          : lvl === 2 ? ctx.rng.shuffle([...foes]).slice(0, 2) // "up to two ... at random"
            : foes; // "each enemy creature"
      for (const f of targets) dealCreatureDamage(ctx.game, ctx.events, f, amount, self);
    },
  });
}
registerGranted("alloyin:oratek-expire", {
  id: "alloyin:oratek-expire",
  trigger: "turnEnd",
  resolve(_ctx, self) {
    self.grantedAbilities = self.grantedAbilities.filter((r) => !r.startsWith("alloyin:oratek-"));
  },
});
registerCard({
  defId: "oratek-explosives",
  spell: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes.filter(Boolean).map((c) => c!.uid);
        if (!options.length) return null;
        return { kind: "friendlyCreature" as const, prompt: "Give a friendly creature +5 attack", options };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, 5, 0);
        if (handHasFaction(ctx.game, player, "Tempys")) {
          c.grantedAbilities.push(`alloyin:oratek-boom-${lvl}`, "alloyin:oratek-expire");
        }
      },
    }]),
  ),
});

// --- Perilous Insight (Overload; discard and level up 2 cards — same chain
//     shape as Metasight in set15.ts) ---
registerCard({
  defId: "perilous-insight",
  spell: {
    1: {
      prompt: (game: Game, player: PlayerId) => {
        const hand = game.state.players[player].hand;
        if (!hand.length) return null;
        return {
          kind: "cardInHand" as const,
          prompt: "Discard and level up a card",
          options: hand.map((_, i) => i),
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (choice?.handIndex === undefined) return;
        discardAndLevel(ctx, player, choice.handIndex);
        if (ctx.priorAnswers.length >= 2) return; // both discards done
        const hand = ctx.game.state.players[player].hand;
        if (!hand.length) return; // fewer than 2 cards to discard
        return {
          kind: "cardInHand" as const,
          prompt: "Discard and level up a card",
          options: hand.map((_, i) => i),
        };
      },
    },
  },
});

// --- Seal of Anvillon (give a creature +N attack; Consistent at L2+) ---
registerCard({
  defId: "seal-of-anvillon",
  spell: Object.fromEntries(
    ([[1, 3], [2, 10], [3, 20]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
      },
    }]),
  ),
});
