/**
 * Set 4 (Imprisoned Heralds) + 4.1 + 4.2 — Alloyin card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set3-alloyin.ts):
 *  - Upgrade (Oreian Scavenger, Steelwatch Guard, Vault Welder, Steeleye
 *    Researcher, Relic Hunter): the engine never fires "enterReplace" (the
 *    trigger is declared in triggers.ts but collected nowhere), so Upgrade is
 *    emulated on enterPlay plus a discard-pile check — see replacedInstance().
 *    Corners: a max-level play onto an empty lane with a creature on top of
 *    the discard pile misfires, and the replaced creature's stats are its
 *    BASE stats (buffs are lost when it leaves play), which matters only for
 *    Relic Hunter.
 *  - Anatomize: "play an additional Anatomize this turn" grants an
 *    unrestricted extra play (playsLeft += 1); legalActions cannot gate the
 *    bonus play by card (same convention as Xrath's Will in set2-nekrium.ts).
 *  - Aegis Wings: "the highest attack" reads as "no other creature in play
 *    has strictly higher attack" (ties count; both sides are counted).
 *  - Esperian Sage: "another space" is a random other open space (no lane
 *    choice kind exists); the copy re-triggers the enter-play discard, since
 *    the text triggers whenever Esperian Sage enters play.
 *  - War Tinker: the copy enters play at the deck card's current level with
 *    fresh base stats ("a copy of a random Robot from your deck").
 *  - Epoch Hawk: "while you have 6 or more cards in hand" gates the
 *    Activate's condition (the engine has no dynamic activate grants).
 *  - Gauntlets of Sulgrim L1/L2 are spells, but isCreature() is per-card, so
 *    they currently enter play as 0/0 creatures and die immediately (their
 *    triggers are skipped by the dead-creature check); the spell scripts
 *    below are unreachable until the engine supports per-level types. TODO.
 *  - Spiritsteel Infiltrator's threshold counts only its own permanent/temp
 *    attack (calling getStats inside a static would recurse through
 *    computeStatics), so other creatures' static auras don't count.
 *  - relic-scout / epoch-soldier token scripts are out of scope for this
 *    file; both work as vanilla tokens (relic-scout's "when replaced" grant
 *    and epoch-soldier's end-of-turn draw are unimplemented).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, destroyCreature, getStats, grantKeyword, negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, keywordValue, opposing } from "../state.js";
import { isCreature, maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { Ability, ChoiceAnswer, Ctx, ResolveResult, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function boardCreatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
}

function friendlyUids(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.filter((c): c is CreatureState => !!c).map((c) => c.uid);
}

function enemyUids(game: Game, p: PlayerId): number[] {
  return game.state.players[opposing(p)].lanes.filter((c): c is CreatureState => !!c).map((c) => c.uid);
}

/** Allied condition: a card of `faction` remains in the player's hand. */
function handHasFaction(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand
    .some((inst) => game.state.cards[inst.defId]?.faction === faction);
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

/** Push the level+1 copy of a card into its owner's discard pile. */
function levelUpCopy(ctx: Ctx, player: PlayerId, inst: CardInstance): void {
  const def = ctx.game.state.cards[inst.defId];
  if (!def || inst.level >= maxLevel(def)) return;
  ctx.game.state.players[player].discard.push({
    uid: ctx.game.state.nextUid++, defId: inst.defId, level: inst.level + 1, owner: player,
  });
  ctx.events.push({ type: "levelUp", player, defId: inst.defId, fromLevel: inst.level, toLevel: inst.level + 1 });
}

/**
 * Upgrade emulation (see header). When a creature enters play by replacing
 * another, spawnCreature(replace: true) pushes the replaced creature to the
 * discard right before triggers are collected, so at collect time the
 * replaced creature is the top of the discard pile. A from-hand play onto an
 * empty lane instead leaves the level-up copy on top, and that copy's uid is
 * always self.uid - 1 (playCard: levelUpCopy takes nextUid, then
 * spawnCreature takes the next one). Returns the replaced card instance.
 */
function replacedInstance(game: Game, self: CreatureState): CardInstance | null {
  const discard = game.state.players[self.owner].discard;
  const top = discard[discard.length - 1];
  if (!top) return null;
  if (top.uid === self.uid - 1) return null; // the level-up copy: no replacement
  const def = game.state.cards[top.defId];
  return def && isCreature(def) ? top : null;
}

/** Shared "deal damage equal to a friendly creature's Armor" chain. */
function armorBlast(
  ctx: Ctx, owner: PlayerId, choice: ChoiceAnswer | null,
  grant: { keyword: "Armor"; value: number } | null,
): ResolveResult {
  if (ctx.priorAnswers.length < 2) {
    const giver = targetOf(ctx, choice);
    if (!giver) return;
    if (grant) grantKeyword(ctx.events, giver, grant);
    const foes = enemyUids(ctx.game, owner);
    if (!foes.length) return;
    return {
      kind: "enemyCreature" as const,
      prompt: "Deal damage equal to its Armor to an enemy creature",
      options: foes,
    };
  }
  const giverUid = ctx.priorAnswers[0]?.targetUid;
  const giver = giverUid !== undefined ? findCreature(ctx.game.state, giverUid) : null;
  const target = targetOf(ctx, choice);
  if (!giver || !target) return;
  dealCreatureDamage(ctx.game, ctx.events, target, keywordValue(giver, "Armor"));
}

// ============================================================
// Creatures
// ============================================================

// --- Anvillon Arbiter (when the enemy plays their 2nd card, they discard their hand) ---
registerCard({
  defId: "anvillon-arbiter",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "second-card-punish",
        trigger: "cardPlayed" as const,
        // cardsPlayedThisTurn counts the active player's plays, and only the
        // active player can play cards, so this fires exactly on the enemy's
        // second card of their turn.
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === opposing(self.owner) && game.state.cardsPlayedThisTurn === 2,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = opposing(self.owner);
          const pl = ctx.game.state.players[foe];
          for (const inst of pl.hand.splice(0)) {
            pl.discard.push(inst);
            ctx.events.push({ type: "discard", player: foe, defId: inst.defId, level: inst.level });
          }
        },
      }],
    }]),
  ),
});

// --- Battletech Inventor (Forge: enemy creature -N attack) ---
registerCard({
  defId: "battletech-inventor",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-debuff",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = enemyUids(game, self.owner);
          if (!options.length) return null;
          return { kind: "enemyCreature" as const, prompt: `Give an enemy creature -${n} attack`, options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        },
      }],
    }]),
  ),
});

// --- Epoch Hawk (with 6+ cards in hand, Activate: spawn an Epoch Soldier) ---
registerCard({
  defId: "epoch-hawk",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "epoch-soldier",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand.length >= 6,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // epoch-soldier levels are exactly 4/4, 7/7, 10/10 — the hawk's level
          spawnCreature(ctx.game, ctx.events, self.owner, "epoch-soldier", self.level, {});
        },
      }],
    }]),
  ),
});

// --- Esperian Sage (enters play: discard and level up; Allied Uterra: copy itself) ---
registerCard({
  defId: "esperian-sage",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [
        {
          id: "enter-discard-level",
          trigger: "enterPlay" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => {
            const hand = game.state.players[self.owner].hand;
            if (!hand.length) return null;
            return {
              kind: "cardInHand" as const,
              prompt: "Discard and level up a card",
              options: hand.map((_, i) => i),
            };
          },
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
            if (choice?.handIndex === undefined) return;
            discardAndLevel(ctx, self.owner, choice.handIndex);
          },
        },
        {
          id: "allied-copy",
          trigger: "enterFromHand" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState) => handHasFaction(game, self.owner, "Uterra"),
          prompt: (game: Game, self: CreatureState) => {
            if (!game.state.players[self.owner].lanes.some((c) => !c)) return null;
            return {
              kind: "yesNo" as const,
              prompt: "Put a copy of Esperian Sage into another space?",
              optional: true,
            };
          },
          resolve: (ctx: Ctx, self: CreatureState) => {
            // self's lane is occupied, so any open space is "another space"
            spawnCreature(ctx.game, ctx.events, self.owner, "esperian-sage", self.level, {});
          },
        },
      ],
    }]),
  ),
});

// --- Oreian Scavenger (Upgrade: Armor N) ---
registerCard({
  defId: "oreian-scavenger",
  levels: Object.fromEntries(
    ([[1, 6], [2, 9], [3, 16]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "upgrade-armor",
        trigger: "enterPlay" as const, // Upgrade emulation (see header)
        condition: (game: Game, self: CreatureState) => replacedInstance(game, self) !== null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Relic Hunter (Solbind Relic Scout; Upgrade: absorb the replaced creature) ---
registerCard({
  defId: "relic-hunter",
  solbind: ["relic-scout"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "upgrade-absorb",
        trigger: "enterPlay" as const, // Upgrade emulation (see header)
        condition: (game: Game, self: CreatureState) => replacedInstance(game, self) !== null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const inst = replacedInstance(ctx.game, self);
          const lvlDef = inst
            ? ctx.game.state.cards[inst.defId]?.levels.find((l) => l.level === inst.level)
            : undefined;
          if (!lvlDef) return;
          // approximation: base stats of the replaced card (buffs are lost)
          const attack = lvlDef.attack ?? 0;
          const health = lvlDef.health ?? 0;
          if (attack || health) buffCreature(ctx.game, ctx.events, self, attack, health);
        },
      }],
    }]),
  ),
});

// --- Spiritsteel Infiltrator (while attack >= threshold: Mobility M and Armor A) ---
registerCard({
  defId: "spiritsteel-infiltrator",
  levels: Object.fromEntries(
    ([[1, 5, 1, 2], [2, 10, 2, 4], [3, 20, 3, 6]] as const).map(([lvl, gate, mob, armor]) => [lvl, {
      statics: [{
        id: "powered-up",
        apply: (_game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.uid !== self.uid) return;
          // getStats() would recurse through computeStatics; count only the
          // creature's own permanent and temporary attack (see header).
          const attack = self.attack + self.tempMods.reduce((s, m) => s + m.attack, 0);
          if (attack >= gate) {
            out.keywords.push({ keyword: "Mobility", value: mob }, { keyword: "Armor", value: armor });
          }
        },
      }],
    }]),
  ),
});

// --- Steeleye Researcher (Upgrade: you may discard and level up a card) ---
registerCard({
  defId: "steeleye-researcher",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "upgrade-recycle",
        trigger: "enterPlay" as const, // Upgrade emulation (see header)
        targeted: true,
        condition: (game: Game, self: CreatureState) => replacedInstance(game, self) !== null,
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
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Steelwatch Guard (Upgrade: +N/+N) ---
registerCard({
  defId: "steelwatch-guard",
  levels: Object.fromEntries(
    ([[1, 4], [2, 7], [3, 11]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "upgrade-buff",
        trigger: "enterPlay" as const, // Upgrade emulation (see header)
        condition: (game: Game, self: CreatureState) => replacedInstance(game, self) !== null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Tech Explorer (Forge: you may discard and level up a creature) ---
registerCard({
  defId: "tech-explorer",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-recycle",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].hand
            .map((inst, i) => {
              const def = game.state.cards[inst.defId];
              return def && isCreature(def) ? i : -1;
            })
            .filter((i) => i >= 0);
          if (!options.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "You may discard and level up a creature",
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

// --- Uriel Ironwing (Forge/Flank: the opposing creature gets -N attack;
//     L3 also destroys it at 0 or less attack) ---
function urielDebuff(trigger: "enterFromHand" | "moved", n: number, kill: boolean): Ability {
  return {
    id: trigger === "enterFromHand" ? "forge-debuff" : "flank-debuff",
    trigger,
    resolve: (ctx: Ctx, self: CreatureState) => {
      const foe = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
      if (!foe) return;
      buffCreature(ctx.game, ctx.events, foe, -n, 0);
      if (kill && getStats(ctx.game, foe).attack <= 0) destroyCreature(ctx.game, ctx.events, foe);
    },
  };
}
registerCard({
  defId: "uriel-ironwing",
  levels: Object.fromEntries(
    ([[1, 2, false], [2, 4, false], [3, 6, true]] as const).map(([lvl, n, kill]) => [lvl, {
      abilities: [urielDebuff("enterFromHand", n, kill), urielDebuff("moved", n, kill)],
    }]),
  ),
});

// --- Vault Welder (Upgrade: Negate Defender) ---
registerCard({
  defId: "vault-welder",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "upgrade-negate-defender",
        trigger: "enterPlay" as const, // Upgrade emulation (see header)
        condition: (game: Game, self: CreatureState) => replacedInstance(game, self) !== null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          negateKeyword(ctx.events, self, "Defender");
        },
      }],
    }]),
  ),
});

// --- War Tinker (end of the enemy's turn: replace with a random Robot from deck) ---
registerCard({
  defId: "war-tinker",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "robot-morph",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === opposing(self.owner),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const robots = pl.deck
            .filter((inst) => ctx.game.state.cards[inst.defId]?.subtypes.includes("Robot"));
          if (!robots.length) return;
          const pick = ctx.rng.pick(robots);
          spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level,
            { lane: self.lane, replace: true });
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells (+ Gauntlets of Sulgrim, a spell at L1/L2 and a creature at L3)
// ============================================================

// --- Aegis Wings (+N attack; if highest attack, also Mobility 1 and Armor M) ---
registerCard({
  defId: "aegis-wings",
  spell: Object.fromEntries(
    ([[1, 3, 2], [2, 6, 4], [3, 9, 6]] as const).map(([lvl, n, armor]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, 0);
        const attack = getStats(ctx.game, c).attack;
        const highest = [...allCreatures(ctx.game.state)]
          .every((o) => o.uid === c.uid || getStats(ctx.game, o).attack <= attack);
        if (highest) {
          grantKeyword(ctx.events, c, { keyword: "Mobility", value: 1 });
          grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
        }
      },
    }]),
  ),
});

// --- Anatomize (creature -N attack; you may play an additional Anatomize) ---
registerCard({
  defId: "anatomize",
  spell: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 16]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature -${n} attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, -n, 0);
        // "additional Anatomize" gate cannot be enforced (see header)
        ctx.game.state.playsLeft += 1;
      },
    }]),
  ),
});

// --- Discordant Strike (enemy creature -N attack; Allied Nekrium: also -N health) ---
registerCard({
  defId: "discordant-strike",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = enemyUids(game, player);
        if (!options.length) return null;
        return { kind: "enemyCreature" as const, prompt: `Give an enemy creature -${n} attack`, options };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null): ResolveResult => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        if (ctx.priorAnswers.length >= 2) { // second leg: the Allied health debuff
          buffCreature(ctx.game, ctx.events, c, 0, -n);
          return;
        }
        buffCreature(ctx.game, ctx.events, c, -n, 0);
        if (!handHasFaction(ctx.game, player, "Nekrium")) return;
        const foes = enemyUids(ctx.game, player);
        if (!foes.length) return;
        return {
          kind: "enemyCreature" as const,
          prompt: `Give an enemy creature -${n} health`,
          options: foes,
        };
      },
    }]),
  ),
});

// --- Gauntlets of Sulgrim (L1/L2 spells are UNREACHABLE — see header TODO) ---
registerCard({
  defId: "gauntlets-of-sulgrim",
  spell: Object.fromEntries(
    ([[1, 2], [2, 5]] as const).map(([lvl, armor]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = friendlyUids(game, player);
        if (!options.length) return null;
        return {
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature Armor ${armor}`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) =>
        armorBlast(ctx, player, choice, { keyword: "Armor", value: armor }),
    }]),
  ),
  levels: {
    3: {
      abilities: [{
        id: "forge-armor-all",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: 6 });
          }
        },
      }],
      activates: [{
        id: "armor-blast",
        prompt: (game: Game, self: CreatureState) => {
          const options = friendlyUids(game, self.owner);
          if (!options.length) return null;
          return {
            kind: "friendlyCreature" as const,
            prompt: "Choose a friendly creature",
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) =>
          armorBlast(ctx, self.owner, choice, null),
      }],
    },
  },
});

// --- Palladium Wave (each enemy creature gets -2x your Rank attack) ---
registerCard({
  defId: "palladium-wave",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const x = 2 * ctx.game.state.players[player].rank;
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, -x, 0);
        }
      },
    },
  },
});
