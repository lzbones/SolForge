/**
 * Set 6 (Darkforge Uprising) + 6.1 + 6.2 — Nekrium card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set5-nekrium.ts / set6-alloyin.ts):
 *  - Ariadne, Spider Queen: "Destroy a Web" means ANY Web, either side (the
 *    printed text has no "friendly") — that is what makes the Spiderling combo
 *    work, since Spiderling's Forge puts the Web on the ENEMY side (it replaces
 *    the opposing creature). The buff copies the Web's current effective stats
 *    (getStats) at destroy time.
 *  - Spiderling / Web: the Web's printed "Upgrade: Web's attack and health
 *    become equal to the creature it replaced" cannot live on the Web itself —
 *    the enterReplace payload carries the replaced creature's attack
 *    (evt.amount) but not its health (engine gap). The stat copy is therefore
 *    done at the replacement site (Spiderling's Forge) via overrideStats, using
 *    the target's permanent attack/health (temp mods / static auras excluded,
 *    matching the engine's enterReplace amount convention). The Web is Spawned
 *    at the Spiderling's level under the REPLACED creature's owner; Defender is
 *    granted script-side at L2/L3 because the scraped Web text is empty there
 *    (scraper gap — L1 parses it from the text). The Web token itself needs no
 *    script (Funguy convention, set3-uterra.ts).
 *  - Demonweb Watcher: battle damage dealt directly to a PLAYER cannot be
 *    hooked — pushDamageTriggers only broadcasts board-wide
 *    (anyCreatureDamaged) for creature targets, and battleDamageToPlayer /
 *    friendlyBattleDamageToPlayer fire only for the attacker and its allies.
 *    TODO: board-wide broadcast for battle damage to a player carrying the
 *    source uid. Battle damage to creatures IS covered: "damaged" when the
 *    Watcher itself is hit, anyCreatureDamaged (evt.fromHand = battle flag,
 *    evt.targetPlayer = source owner) otherwise; the attacker is recovered by
 *    lane (engine battle damage is always same-lane) and must have Aggressive.
 *  - Plunder Imp: the forced enemy discard does NOT level the discarded card
 *    (Aetherphage convention, set3-uterra.ts); the Imp's controller chooses via
 *    kind "cardInHand" over the ENEMY hand's indexes.
 *  - Grimgaunt Warrior: "adjacent" = same side, lanes ±1 (Xithian Shambler
 *    convention, set1-nekrium.ts).
 *  - Xerxes, the Executioner: creatures already at lethal damage before the
 *    Activate are not "destroyed this way". The Spawn is a fresh copy at the
 *    destroyed creature's level in a random open space (Suruzal convention);
 *    the doomed enemies still occupy their lanes until the batch ends, so the
 *    Spawn can only land in an already-open space and fizzles on a full board
 *    (Sparky convention, set6-alloyin.ts). The Activate has no prompt, so it
 *    resolves outside a batch and triggers off the debuffs/Spawn are dropped —
 *    known engine gap (Marty McGear convention).
 *  - Infernal Ritual: "You get, 'Each friendly Nekrium creature in a side
 *    space gets Regenerate 2'" is a continuous player aura, but player-level
 *    effects are trigger-only. Approximated with permanent grants: the spell
 *    sweeps immediately and a permanent turnStart player effect re-sweeps at
 *    every turn start (per-game uid census dedups; Nexus Bubble convention,
 *    set6-alloyin.ts). Corners: Regenerate is not revoked when a creature
 *    moves to the center space; mid-turn entries/moves into a side space wait
 *    for the next turn start; a negateKeyword strips the grant permanently;
 *    a second Infernal Ritual does not stack on already-granted creatures.
 *    Overload is an engine keyword (the card is still removed).
 *  - Darkheart Conjurer's Solbind card Dysian Infusion is scripted below as a
 *    support card (spirit-torrent convention from set5-nekrium.ts).
 *  - Subtype matching: the scraper stores combined subtype strings
 *    ("Darkforged Grimgaunt"), so Darkforged/Web membership is a word match
 *    (set6-alloyin.ts convention).
 */
import { registerCard, registerGranted, registerPlayerEffect } from "./registry.js";
import {
  addPlayerEffect, banishFromDiscard, buffCreature, dealPlayerDamage, destroyCreature, getStats,
  grantKeyword, isDeadEffective, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, opposing,
  type CardInstance, type CreatureState, type PlayerId,
} from "../state.js";
import { typeAt } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, GameEvent, TriggerPayload } from "../triggers.js";

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

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

/** Word-match against combined subtype strings ("Darkforged Grimgaunt" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

function isDarkforged(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Darkforged");
}

function isWeb(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Web");
}

/** Attack of a creature card in a hand, at its current level (null if not a creature). */
function handCreatureAttack(game: Game, inst: CardInstance): number | null {
  const def = game.state.cards[inst.defId];
  if (!def || typeAt(def, inst.level) !== "Creature") return null;
  return def.levels.find((l) => l.level === inst.level)?.attack ?? null;
}

/** Whether a discard-pile card is a creature at its current level. */
function isCreatureInstance(game: Game, inst: CardInstance): boolean {
  const def = game.state.cards[inst.defId];
  return !!def && typeAt(def, inst.level) === "Creature";
}

// ---------- granted abilities ----------

// Nether Decay: the target gets "When a creature is destroyed, this gets
// -N attack and -N health." Stacks when applied multiple times.
for (const n of [5, 6, 7] as const) {
  registerGranted(`nekrium:nether-decay-${n}`, {
    id: `nekrium:nether-decay-${n}`,
    trigger: "anyCreatureDestroyed",
    resolve(ctx, self) {
      buffCreature(ctx.game, ctx.events, self, -n, -n);
    },
  });
}

// ============================================================
// Creatures
// ============================================================

// --- Ariadne, Spider Queen: Activate — destroy a Web (either side, see
//     header); Ariadne gets +attack/+health equal to the destroyed creature.
//     Solbind: 2x Spiderling (engine adds them to the deck). ---
registerCard({
  defId: "ariadne-spider-queen",
  solbind: ["spiderling", "spiderling"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "devour-web",
        condition: (game: Game) =>
          boardUids(game, (c) => isWeb(game, c.defId)).length > 0,
        prompt: (game: Game) => req(
          "Destroy a Web: Ariadne gets +Attack and +Health equal to the destroyed creature",
          "anyCreature",
          boardUids(game, (c) => isWeb(game, c.defId)),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || !isWeb(ctx.game, c.defId)) return;
          const gained = getStats(ctx.game, c);
          destroyCreature(ctx.game, ctx.events, c);
          buffCreature(ctx.game, ctx.events, self, gained.attack, gained.health);
        },
      }],
    }]),
  ),
});

// --- Darkheart Conjurer: when you play a spell, give a friendly creature
//     Regenerate N. Solbind: Dysian Infusion (scripted below). ---
registerCard({
  defId: "darkheart-conjurer",
  solbind: ["dysian-infusion"],
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "spellweave",
        trigger: "spellPlayed" as const,
        targeted: true,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner,
        prompt: (game: Game, self: CreatureState) => req(
          `Give a friendly creature Regenerate ${n}`,
          "friendlyCreature",
          friendlyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.owner === self.owner) {
            grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
          }
        },
      }],
    }]),
  ),
});

// --- Darkshard Witch: Forge — deal N damage to the enemy player and gain
//     N health for each friendly Darkforged (itself included). ---
registerCard({
  defId: "darkshard-witch",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-darkshard",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
          const count = ctx.game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && isDarkforged(ctx.game, c.defId))
            .length;
          if (count > 0) buffCreature(ctx.game, ctx.events, self, 0, n * count);
        },
      }],
    }]),
  ),
});

// --- Demonweb Watcher: when an enemy creature with Aggressive deals battle
//     damage, it gets -N/-N (battle damage to players not hooked — see header). ---
registerCard({
  defId: "demonweb-watcher",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          // the Watcher itself is dealt battle damage by an enemy Aggressive creature
          id: "web-snare-self",
          trigger: "damaged" as const,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) => {
            if (evt.battle !== true || evt.sourceOwner !== opposing(self.owner)) return false;
            const src = evt.sourceUid !== undefined ? findCreature(game.state, evt.sourceUid) : null;
            return !!src && hasKeyword(src, "Aggressive");
          },
          resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
            const src = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
            if (src) buffCreature(ctx.game, ctx.events, src, -n, -n);
          },
        },
        {
          // battle damage to another creature: the anyCreatureDamaged payload
          // carries the TARGET (source* fields), fromHand = battle flag,
          // targetPlayer = damage source's owner; the attacker opposes the target
          id: "web-snare-other",
          trigger: "anyCreatureDamaged" as const,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) => {
            if (evt.fromHand !== true || evt.targetPlayer !== opposing(self.owner)) return false;
            if (evt.lane === undefined) return false;
            const attacker = game.state.players[opposing(self.owner)].lanes[evt.lane];
            return !!attacker && hasKeyword(attacker, "Aggressive");
          },
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            if (evt.lane === undefined) return;
            const attacker = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
            if (attacker) buffCreature(ctx.game, ctx.events, attacker, -n, -n);
          },
        },
      ],
    }]),
  ),
});

// --- Grimgaunt Betrayer: when a friendly Darkforged is destroyed, the
//     creature opposing it gets -N/-N. ---
registerCard({
  defId: "grimgaunt-betrayer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "betray-darkforged",
        trigger: "friendlyCreatureDestroyed" as const,
        condition: (game: Game, _s: CreatureState, evt: TriggerPayload) =>
          !!evt.sourceDefId && isDarkforged(game, evt.sourceDefId),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          const foe = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (foe) buffCreature(ctx.game, ctx.events, foe, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Plunder Imp: Forge — choose a creature with cap or less attack in the
//     ENEMY hand; the enemy player discards it (no level-up — see header). ---
registerCard({
  defId: "plunder-imp",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-plunder",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[opposing(self.owner)].hand;
          const options = hand
            .map((inst, i) => {
              const atk = handCreatureAttack(game, inst);
              return atk !== null && atk <= cap ? i : -1;
            })
            .filter((i) => i >= 0);
          return req(
            `Choose a creature with ${cap} or less attack in the enemy player's hand; the enemy player discards it`,
            "cardInHand",
            options,
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const foe = ctx.game.state.players[opposing(self.owner)];
          const inst = foe.hand[choice.handIndex];
          const atk = inst ? handCreatureAttack(ctx.game, inst) : null;
          if (!inst || atk === null || atk > cap) return; // re-validate
          foe.hand.splice(choice.handIndex, 1);
          foe.discard.push(inst);
          ctx.events.push({ type: "discard", player: opposing(self.owner), defId: inst.defId, level: inst.level });
        },
      }],
    }]),
  ),
});

// --- Shadeclaw Zombie: Regenerate N (inherent); when another friendly
//     Darkforged enters play, Shadeclaw Zombie gets +N/+N. ---
registerCard({
  defId: "shadeclaw-zombie",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "darkforged-growth",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceUid !== self.uid
          && !!evt.sourceDefId && isDarkforged(game, evt.sourceDefId),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Xerxes, the Executioner: Activate — each non-Nekrium creature gets
//     -N/-N; if any enemy creatures are destroyed this way, Spawn one of them
//     at random (fresh copy at its level, random open space — see header). ---
registerCard({
  defId: "xerxes-the-executioner",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "execute",
        resolve: (ctx: Ctx, self: CreatureState) => {
          const victims: CreatureState[] = [];
          for (const c of allCreatures(ctx.game.state)) {
            if (ctx.game.state.cards[c.defId]?.faction !== "Nekrium") victims.push(c);
          }
          const alreadyDead = new Set(
            victims.filter((c) => isDeadEffective(ctx.game, c)).map((c) => c.uid),
          );
          for (const c of victims) buffCreature(ctx.game, ctx.events, c, -n, -n);
          const doomed = victims.filter((c) =>
            c.owner !== self.owner && !alreadyDead.has(c.uid) && isDeadEffective(ctx.game, c));
          if (!doomed.length) return;
          const pick = ctx.rng.pick(doomed);
          spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- Zombie Dreadknight: Forge — each friendly creature with Regenerate
//     gets +N/+N. ---
registerCard({
  defId: "zombie-dreadknight",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-regenerate-rally",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && hasKeyword(c, "Regenerate")) buffCreature(ctx.game, ctx.events, c, n, n);
          }
        },
      }],
    }]),
  ),
});

// --- Patron of Tarsus: Forge — with 3+ Nekrium cards in hand, each enemy
//     creature gets -N/-N. ---
registerCard({
  defId: "patron-of-tarsus",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-tarsus-wither",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand
            .filter((inst) => game.state.cards[inst.defId]?.faction === "Nekrium")
            .length >= 3,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, -n, -n);
          }
        },
      }],
    }]),
  ),
});

// --- Grimgaunt Warrior: when an adjacent creature is destroyed (same side,
//     lanes ±1 — see header), Grimgaunt Warrior gets +N/+N. ---
registerCard({
  defId: "grimgaunt-warrior",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "scavenge",
        trigger: "anyCreatureDestroyed" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.lane !== undefined
          && Math.abs(evt.lane - self.lane) === 1,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Blood Bindings: give a creature -N/-N, plus an extra -N/-N if a
//     creature was destroyed this turn (either side — Blood Barrier convention). ---
registerCard({
  defId: "blood-bindings",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature -${n} attack and -${n} health`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, -n, -n);
        if (ctx.game.state.deathLog.length > 0) { // any creature, either side, this turn
          buffCreature(ctx.game, ctx.events, c, -n, -n);
        }
      },
    }]),
  ),
});

// --- Nether Decay: give a creature "When a creature is destroyed, this gets
//     -N attack and -N health" (granted ability — see the registry above). ---
registerCard({
  defId: "nether-decay",
  spell: Object.fromEntries(
    ([[1, 5], [2, 6], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature "When a creature is destroyed, this gets -${n} attack and -${n} health"`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) c.grantedAbilities.push(`nekrium:nether-decay-${n}`);
      },
    }]),
  ),
});

// --- Remembrance: Banish a level-capped creature from your discard pile,
//     then Spawn a copy of it (fresh copy at the banished card's level). ---
registerCard({
  defId: "remembrance",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, Infinity]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].discard
          .map((inst, i) => (inst.level <= cap && isCreatureInstance(game, inst)) ? i : -1)
          .filter((i) => i >= 0);
        return req(
          cap === 1
            ? "Banish a level 1 creature from your discard pile, then Spawn a copy of it"
            : cap === 2
              ? "Banish a level 2 or lower creature from your discard pile, then Spawn a copy of it"
              : "Banish a creature from your discard pile, then Spawn a copy of it",
          "cardInDiscard",
          options,
        );
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        if (choice?.handIndex === undefined) return;
        const inst = ctx.game.state.players[player].discard[choice.handIndex];
        if (!inst || inst.level > cap || !isCreatureInstance(ctx.game, inst)) return; // re-validate
        const { defId, level } = inst;
        banishFromDiscard(ctx.game, ctx.events, player, choice.handIndex);
        spawnCreature(ctx.game, ctx.events, player, defId, level, { lane: "random" });
      },
    }]),
  ),
});

// --- Infernal Ritual: "You get, 'Each friendly Nekrium creature in a side
//     space gets Regenerate 2'" is a continuous player aura; player effects
//     are trigger-only, so it is approximated with PERMANENT grants: the
//     spell sweeps immediately and a permanent turnStart player effect
//     re-sweeps every turn (per-game uid census dedups — Nexus Bubble
//     convention, set6-alloyin.ts). Side space = any lane but the center.
//     Corners: Regenerate is not revoked when a creature moves to the center;
//     mid-turn entries/moves into a side space wait for the next turn start;
//     a negateKeyword strips the grant for good; a second Infernal Ritual
//     does not stack on already-granted creatures. ---
const RITUAL_CENTER_LANE = 2;
const ritualGranted = new WeakMap<Game, Set<number>>();

function ritualSweep(game: Game, events: GameEvent[], player: PlayerId): void {
  let granted = ritualGranted.get(game);
  if (!granted) { granted = new Set(); ritualGranted.set(game, granted); }
  for (const c of game.state.players[player].lanes) {
    if (!c || c.lane === RITUAL_CENTER_LANE || granted.has(c.uid)) continue;
    if (game.state.cards[c.defId]?.faction !== "Nekrium") continue;
    grantKeyword(events, c, { keyword: "Regenerate", value: 2 });
    granted.add(c.uid);
  }
}

registerPlayerEffect("nekrium:infernal-ritual", {
  trigger: "turnStart", // both players' turn starts: top up late entries
  resolve: (ctx: Ctx, player: PlayerId) => {
    ritualSweep(ctx.game, ctx.events, player);
  },
});
registerCard({
  defId: "infernal-ritual",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        ritualSweep(ctx.game, ctx.events, player); // aura applies immediately
        addPlayerEffect(ctx.game, ctx.events, player, "nekrium:infernal-ritual", null);
      },
    },
  },
});

// ============================================================
// Support cards (Solbind tokens scripted here — see header)
// ============================================================

// --- Spiderling (Ariadne's Solbind token): Forge — replace the opposing
//     level-capped creature with a Web; the Web copies its permanent stats at
//     the replacement site (see header) and belongs to the replaced creature's
//     owner. ---
registerCard({
  defId: "spiderling",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-web",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => {
          const foe = game.state.players[opposing(self.owner)].lanes[self.lane];
          return !!foe && foe.level <= cap;
        },
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = ctx.game.state.players[opposing(self.owner)].lanes[self.lane];
          if (!foe || foe.level > cap) return;
          const web = spawnCreature(ctx.game, ctx.events, foe.owner, "web", lvl, {
            lane: foe.lane,
            replace: true,
            overrideStats: { attack: foe.attack, health: foe.health },
          });
          // L2/L3 scraped Web text is empty, so Defender only parses at L1 (see header)
          if (web && !hasKeyword(web, "Defender")) {
            grantKeyword(ctx.events, web, { keyword: "Defender", value: 0 });
          }
        },
      }],
    }]),
  ),
});

// --- Dysian Infusion (Darkheart Conjurer's Solbind token): give a creature
//     +N attack, +N health and Regenerate M. ---
registerCard({
  defId: "dysian-infusion",
  spell: Object.fromEntries(
    ([[1, 4, 1], [2, 7, 3], [3, 10, 5]] as const).map(([lvl, n, regen]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${n} attack, +${n} health and Regenerate ${regen}`,
        "anyCreature",
        boardUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        grantKeyword(ctx.events, c, { keyword: "Regenerate", value: regen });
      },
    }]),
  ),
});
