/** Set 1 card scripts — see docs/CARD_SCRIPTING.md. */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, destroyCreature, drawCardsEffect, getStats, grantKeyword,
  negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, isDead, keywordValue, opposing } from "../state.js";
import { maxLevel, type Keyword } from "../types.js";
import type { Game } from "../game.js";
import type { CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, Ctx, LevelScript, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- shared helpers ----------

function isRobot(game: Game, c: CreatureState): boolean {
  return game.state.cards[c.defId]?.subtypes.includes("Robot") ?? false;
}

function isRobotGuardian(game: Game, c: CreatureState): boolean {
  return game.state.cards[c.defId]?.subtypes.includes("Robot Guardian") ?? false;
}

function creatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

/**
 * "Discard and level up a card" / "Level up a card in your hand" — the
 * discardToLevel action as an effect (no primitive exists for hand manipulation).
 * Mirrors game.ts levelUpCopy: the leveled copy goes to the discard pile.
 */
function levelUpHandCard(ctx: Ctx, player: PlayerId, handIndex: number, discardFirst: boolean): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  if (discardFirst) {
    pl.hand.splice(handIndex, 1);
    pl.discard.push(inst);
    ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  }
  const def = ctx.game.state.cards[inst.defId];
  if (def && inst.level < maxLevel(def)) {
    pl.discard.push({ uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player });
    ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
  }
}

// --- Alloyin General (static: adjacent creatures get +N attack) ---
registerCard({
  defId: "alloyin-general",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "adjacent-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.uid !== self.uid && target.owner === self.owner && Math.abs(target.lane - self.lane) === 1) {
            stats.attack += n;
          }
        },
      }],
    }]),
  ),
});

// --- Alloyin Highlander (static: while your only friendly creature, +N attack and Armor X) ---
registerCard({
  defId: "alloyin-highlander",
  levels: Object.fromEntries(
    ([[1, 4, 2], [2, 8, 4], [3, 16, 8]] as const).map(([lvl, n, armor]) => [lvl, {
      statics: [{
        id: "lone-warrior",
        apply: (game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid !== self.uid) return;
          const allies = game.state.players[self.owner].lanes.filter((c) => c && !isDead(c));
          if (allies.length === 1) {
            stats.attack += n;
            stats.keywords.push({ keyword: "Armor", value: armor });
          }
        },
      }],
    }]),
  ),
});

// --- Arcflight Squadron (Activate: you may play an additional Robot this turn) ---
registerCard({
  defId: "arcflight-squadron",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "extra-play",
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += 1;
        },
      }],
    }]),
  ),
});
// TODO(arcflight-squadron): the "additional level 1 / level 2 or lower / any
// *Robot*" restriction cannot be enforced — the engine has no way to constrain
// what the extra play is spent on. Implemented as a plain +1 play this turn.

// --- Battle Techtician (static: in the center space, other friendly creatures get +N attack) ---
registerCard({
  defId: "battle-techtician",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "center-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (self.lane === 2 && target.owner === self.owner && target.uid !== self.uid) stats.attack += n;
        },
      }],
    }]),
  ),
});

// --- Brightsteel Sentinel (Forge: each friendly Robot gets Armor X this turn) ---
registerCard({
  defId: "brightsteel-sentinel",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "forge-armor-robots",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && isRobot(ctx.game, c)) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor }, true);
          }
        },
      }],
    }]),
  ),
});

// --- Bulwark Bash (deal X × the Armor on a friendly creature to an enemy creature) ---
// Two-step choice chain: the first prompt picks the friendly creature whose
// Armor is measured; resolve returns a second ChoiceRequest for the enemy target
// (ctx.priorAnswers[0] carries the first answer on the chained call).
registerCard({
  defId: "bulwark-bash",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((mult) => [mult, {
      prompt: (game: Game, player: PlayerId) => {
        const armored = game.state.players[player].lanes
          .filter((c): c is CreatureState => !!c && keywordValue(c, "Armor") > 0)
          .map((c) => c.uid);
        const foes = game.state.players[opposing(player)].lanes.filter(Boolean).map((c) => c!.uid);
        if (!armored.length || !foes.length) return null;
        return {
          kind: "friendlyCreature" as const,
          prompt: `Deal damage equal to ${mult === 1 ? "" : `${mult}X `}the Armor on a friendly creature to an enemy creature`,
          options: armored,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const firstUid = ctx.priorAnswers[0]?.targetUid ?? choice?.targetUid;
        if (firstUid === undefined) return; // prompt found no targets: fizzle
        if (ctx.priorAnswers.length < 2) {
          const foes = ctx.game.state.players[opposing(player)].lanes.filter(Boolean).map((c) => c!.uid);
          if (!foes.length) return;
          return {
            kind: "enemyCreature" as const,
            prompt: "Deal that much damage to an enemy creature",
            options: foes,
          };
        }
        const secondUid = ctx.priorAnswers[1]?.targetUid ?? choice?.targetUid;
        const source = findCreature(ctx.game.state, firstUid);
        const target = secondUid !== undefined ? findCreature(ctx.game.state, secondUid) : null;
        if (source && target) {
          dealCreatureDamage(ctx.game, ctx.events, target, keywordValue(source, "Armor") * mult);
        }
      },
    }]),
  ),
});

// --- Cypien Augmentation (give a creature in a center space +N/+N; Free at L2+) ---
registerCard({
  defId: "cypien-augmentation",
  spell: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game, (c) => c.lane === 2);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature in a center space +${n}/+${n}`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, n);
      },
    }]),
  ),
});

// --- Electro Net (give a creature −N attack) ---
registerCard({
  defId: "electro-net",
  spell: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature −${n} attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
      },
    }]),
  ),
});

// --- Energy Prison (give a level N-or-lower creature Defender; Free at L3) ---
registerCard({
  defId: "energy-prison",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, gate]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game, (c) => c.level <= gate);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: "Give a creature Defender", options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
      },
    }]),
  ),
});

// --- Flowsteel Prototype (when you play a level N-or-lower creature, +attack equal to its attack) ---
function flowsteel(gate: number): LevelScript {
  return {
    abilities: [{
      id: "grow",
      trigger: "creaturePlayed",
      condition: (game: Game, self: CreatureState, evt: TriggerPayload) => {
        if (evt.sourceOwner !== self.owner || evt.lane === undefined) return false;
        const played = game.state.players[self.owner].lanes[evt.lane];
        return !!played && played.uid !== self.uid && played.level <= gate;
      },
      resolve: (ctx: Ctx, self: CreatureState) => {
        buffCreature(ctx.game, ctx.events, self, getStats(ctx.game, self).attack, 0);
      },
    }],
  };
}
registerCard({
  defId: "flowsteel-prototype",
  levels: {
    1: {}, // no ability at L1
    2: flowsteel(1),
    3: flowsteel(2),
  },
});

// --- Forcefield (give a creature Armor X this turn) ---
registerCard({
  defId: "forcefield",
  spell: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 20]] as const).map(([lvl, armor]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature Armor ${armor} this turn`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor }, true);
      },
    }]),
  ),
});

// --- Forge Guardian Gamma (Activate, sacrifice five friendly Robot Guardians: spawn Forge Guardian Omega) ---
registerCard({
  defId: "forge-guardian-gamma",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "assemble-omega",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].lanes.filter((c) => c && !isDead(c) && isRobotGuardian(game, c)).length >= 5,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const others = ctx.game.state.players[self.owner].lanes.filter(
            (c): c is CreatureState => !!c && !isDead(c) && isRobotGuardian(ctx.game, c) && c.uid !== self.uid,
          );
          // Self is always one of the five; its lane is freed for Omega.
          for (const g of [self, ...others].slice(0, 5)) destroyCreature(ctx.game, ctx.events, g);
          // replace: self is dead-marked but still occupies the lane until batch end;
          // its "destroyed" event is consumed by the replacement (sacrifice).
          spawnCreature(ctx.game, ctx.events, self.owner, "forge-guardian-omega", self.level,
            { lane: self.lane, replace: true });
        },
      }],
    }]),
  ),
});

// --- Ghox, Metamind Paragon (at the start of your turn, draw N cards) ---
registerCard({
  defId: "ghox-metamind-paragon",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "draw",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          drawCardsEffect(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Heavy Artillery (give a creature +N attack) ---
registerCard({
  defId: "heavy-artillery",
  spell: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game);
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

// --- Hinterland Watchman (static: while it has N+ attack, it gets bonus keywords) ---
// Approximation: the attack threshold reads permanent attack + temp mods + the
// static bonuses accumulated so far this pass (stats.attack, lane order) instead
// of getStats(), which would recurse through computeStatics. Static attack buffs
// from providers later in lane order are not counted toward the threshold.
const watchman: Record<number, { gate: number; kws: { keyword: Keyword; value: number }[] }> = {
  1: { gate: 5, kws: [{ keyword: "Mobility", value: 3 }] },
  2: { gate: 10, kws: [{ keyword: "Armor", value: 5 }, { keyword: "Mobility", value: 3 }] },
  3: {
    gate: 20,
    kws: [
      { keyword: "Armor", value: 5 }, { keyword: "Breakthrough", value: 0 },
      { keyword: "Aggressive", value: 0 }, { keyword: "Mobility", value: 3 },
      { keyword: "Regenerate", value: 5 },
    ],
  },
};
registerCard({
  defId: "hinterland-watchman",
  levels: Object.fromEntries(
    Object.entries(watchman).map(([lvl, { gate, kws }]) => [lvl, {
      statics: [{
        id: "high-attack",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid !== self.uid) return;
          const atk = target.attack + target.tempMods.reduce((s, m) => s + m.attack, 0) + stats.attack;
          if (atk >= gate) for (const kw of kws) stats.keywords.push({ ...kw });
        },
      }],
    }]),
  ),
});

// --- Jet Pack (give a creature +N attack and Mobility 1) ---
registerCard({
  defId: "jet-pack",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack and Mobility 1`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) {
          buffCreature(ctx.game, ctx.events, c, n, 0);
          grantKeyword(ctx.events, c, { keyword: "Mobility", value: 1 });
        }
      },
    }]),
  ),
});

// --- Lightshield Patrol (static: while it has N+ attack, it gets Armor X) ---
// Same threshold approximation as Hinterland Watchman (see above).
const patrol: Record<number, { gate: number; armor: number }> = {
  1: { gate: 5, armor: 2 }, 2: { gate: 10, armor: 3 }, 3: { gate: 20, armor: 4 },
};
registerCard({
  defId: "lightshield-patrol",
  levels: Object.fromEntries(
    Object.entries(patrol).map(([lvl, { gate, armor }]) => [lvl, {
      statics: [{
        id: "high-attack",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
          if (target.uid !== self.uid) return;
          const atk = target.attack + target.tempMods.reduce((s, m) => s + m.attack, 0) + stats.attack;
          if (atk >= gate) stats.keywords.push({ keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Matrix Warden (Forge: give a friendly creature +N attack) ---
registerCard({
  defId: "matrix-warden",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-buff",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => ({
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature +${n} attack`,
          options: game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.uid),
        }),
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
        },
      }],
    }]),
  ),
});

// --- Metamind Adept (Forge: draw N cards) ---
registerCard({
  defId: "metamind-adept",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-draw",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          drawCardsEffect(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Metasculpt (remove all abilities from a (level-<=2 at L1) creature) ---
// "Remove all abilities" is modeled as silence: a silenced creature's triggered
// abilities (inherent and granted) are never collected (collectFor skips it).
// Limitation: Activate abilities, keywords and static auras are unaffected —
// the engine's silence flag only gates trigger collection.
registerCard({
  defId: "metasculpt",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game, (c) => c.level <= cap);
        if (!options.length) return null;
        return {
          kind: "anyCreature" as const,
          prompt: cap === 2 ? "Remove all abilities from a level 2 or lower creature" : "Remove all abilities from a creature",
          options,
        };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.silenced = true;
      },
    }]),
  ),
});

// --- Munitions Drone (Activate: give another creature +N attack) ---
registerCard({
  defId: "munitions-drone",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "buff-other",
        prompt: (game: Game, self: CreatureState) => {
          const options = creatureUids(game, (c) => c.uid !== self.uid);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give another creature +${n} attack`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
        },
      }],
    }]),
  ),
});

// --- Nexus Pilot (static: in the center space, +N attack and +M health) ---
registerCard({
  defId: "nexus-pilot",
  levels: Object.fromEntries(
    ([[1, 3, 4], [2, 5, 7], [3, 8, 10]] as const).map(([lvl, a, h]) => [lvl, {
      statics: [{
        id: "center-boost",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.uid === self.uid && self.lane === 2) {
            stats.attack += a;
            stats.health += h;
          }
        },
      }],
    }]),
  ),
});

// --- Oreian Warwalker (Activate: gets 2X/2X/3X attack) ---
registerCard({
  defId: "oreian-warwalker",
  levels: Object.fromEntries(
    ([[1, 2], [2, 2], [3, 3]] as const).map(([lvl, mult]) => [lvl, {
      activates: [{
        id: "amplify",
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, getStats(ctx.game, self).attack * (mult - 1), 0);
        },
      }],
    }]),
  ),
});

// --- Palladium Pulsemage (Activate: give a creature −N attack this turn) ---
registerCard({
  defId: "palladium-pulsemage",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "debuff",
        prompt: (game: Game) => {
          const options = creatureUids(game);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: `Give a creature −${n} attack this turn`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0, true);
        },
      }],
    }]),
  ),
});

// --- Sonic Pulse (each enemy creature gets −N attack) ---
registerCard({
  defId: "sonic-pulse",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        }
      },
    }]),
  ),
});

// --- Stasis Warden (when you play a spell, give a friendly creature Defender
//     until the start of your next turn) ---
// "Until the start of your next turn" outlives the current turn, so a temp
// keyword is too short: grant Defender permanently and attach a one-shot
// turnStart trigger that removes it (same pattern as Uranti Bolt). Caveat: if
// the target had inherent Defender, the expiry removes that too.
registerGranted("alloyin:defender-expire", {
  id: "alloyin:defender-expire",
  trigger: "turnStart",
  condition: (game, self) => game.state.active === self.owner,
  resolve(ctx, self) {
    negateKeyword(ctx.events, self, "Defender");
    self.grantedAbilities = self.grantedAbilities.filter((r) => r !== "alloyin:defender-expire");
  },
});
registerCard({
  defId: "stasis-warden",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "spell-shield",
        trigger: "spellPlayed" as const,
        targeted: true,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.uid);
          if (!options.length) return null;
          return {
            kind: "friendlyCreature" as const,
            prompt: "Give a friendly creature Defender until the start of your next turn",
            options,
          };
        },
        resolve: (ctx: Ctx, _self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
          c.grantedAbilities.push("alloyin:defender-expire");
        },
      }],
    }]),
  ),
});

// --- Steelforged Avatar (Forge: +N/+N for each Alloyin card in your hand) ---
registerCard({
  defId: "steelforged-avatar",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-hand",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].hand
            .filter((inst) => ctx.game.state.cards[inst.defId]?.faction === "Alloyin").length;
          if (count) buffCreature(ctx.game, ctx.events, self, count * n, count * n);
        },
      }],
    }]),
  ),
});

// --- Steelshaper Savant (when you play a level-<=gate Alloyin card, you may
//     give a friendly creature Armor X) ---
registerCard({
  defId: "steelshaper-savant",
  levels: {
    1: {}, // vanilla 4/6
    ...Object.fromEntries(
      ([[2, 1, 2], [3, 2, 4]] as const).map(([lvl, gate, armor]) => [lvl, {
        abilities: [{
          id: "armor-up",
          trigger: "cardPlayed" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner
            && evt.sourceLevel !== undefined && evt.sourceLevel <= gate
            && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Alloyin",
          prompt: (game: Game, self: CreatureState) => {
            const options = game.state.players[self.owner].lanes.filter(Boolean).map((c) => c!.uid);
            if (!options.length) return null;
            return {
              kind: "friendlyCreature" as const,
              prompt: `Give a friendly creature Armor ${armor}`,
              options,
              optional: true,
            };
          },
          resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
          },
        }],
      }]),
    ),
  },
});

// --- Synapsis Oracle (Activate: discard and level up a card / L3: level up a card in hand) ---
registerCard({
  defId: "synapsis-oracle",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: lvl < 3 ? "discard-level" : "level-hand",
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[self.owner].hand;
          if (!hand.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: lvl < 3 ? "Discard and level up a card" : "Level up a card in your hand",
            options: hand.map((_, i) => i),
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          levelUpHandCard(ctx, self.owner, choice.handIndex, lvl < 3);
        },
      }],
    }]),
  ),
});

// --- Tech Upgrade (give a friendly Robot +N attack and Armor M) ---
registerCard({
  defId: "tech-upgrade",
  spell: Object.fromEntries(
    ([[1, 4, 2], [2, 6, 3], [3, 12, 6]] as const).map(([lvl, n, armor]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes
          .filter((c): c is CreatureState => !!c && isRobot(game, c)).map((c) => c.uid);
        if (!options.length) return null;
        return { kind: "friendlyCreature" as const, prompt: `Give a friendly Robot +${n} attack and Armor ${armor}`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) {
          buffCreature(ctx.game, ctx.events, c, n, 0);
          grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        }
      },
    }]),
  ),
});

// --- Technosmith (Forge: you may discard and level up a card) ---
registerCard({
  defId: "technosmith",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-recycle",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[self.owner].hand;
          if (!hand.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "You may discard and level up a card",
            options: hand.map((_, i) => i),
            optional: true,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          levelUpHandCard(ctx, self.owner, choice.handIndex, true);
        },
      }],
    }]),
  ),
});

// vault-technician: vanilla (rules text "-"), no script required.

// --- Warmonger Mod (give a creature 2X/2X/3X attack; L1: level 2 or lower only) ---
registerCard({
  defId: "warmonger-mod",
  spell: Object.fromEntries(
    ([[1, 2, 2], [2, 2, 99], [3, 3, 99]] as const).map(([lvl, mult, gate]) => [lvl, {
      prompt: (game: Game) => {
        const options = creatureUids(game, (c) => c.level <= gate);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature ${mult}X attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, c).attack * (mult - 1), 0);
      },
    }]),
  ),
});
