/**
 * Set 7 (Raiders Unchained) + 7.1 + 7.2 + 7.3 — Tempys card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set6-tempys.ts / set7-nekrium.ts):
 *  - Raid (new Set 7 keyword): turnEnd + condition (own turn, 3+ friendly
 *    creatures hasBattled) per CARD_SCRIPTING.md. hasBattled is only set for
 *    creatures that initiated battle, which matches the wiki Raid rulings
 *    (defensive battlers don't count); the Raid creature itself need not have
 *    battled, and one that died before the end-of-turn batch loses its pending
 *    trigger (standard engine rule).
 *  - Cauldron Mystic: "When a friendly creature enters play" includes the
 *    Mystic's own entry (Arc Wurm / Frostfang Maiden precedent, set6-tempys.ts
 *    / set3-tempys.ts): an enterPlay ability covers self-entry,
 *    anyCreatureEnterPlay covers the others. The random target is picked among
 *    the enemy creatures AND the enemy player (Ignir "randomOrPlayer"
 *    convention).
 *  - Chaos Twister: "if it is in Formation" is evaluated on the TARGET's side
 *    (both spaces adjacent to the target occupied by its allies).
 *  - Iceshard Berserker: "while opposed" is a static self-buff (Cloudcleaver
 *    Titan precedent, set2-tempys.ts, inverted).
 *  - Slumbering Shrine: "you may Negate Defender from a friendly creature" is
 *    an optional targeted pick among friendly creatures that currently have
 *    Defender. negateKeyword is permanent, but cannot strip Defender granted
 *    by a static aura (static keywords recompute on every read). Solbind adds
 *    one Magmify (scripted below as a support card).
 *  - Unstable Asir: the Vengeance damage uses the last-known attack (getStats
 *    on the death snapshot: base + temp mods + remaining statics).
 *  - Uranti Stormshaper: L1/L2 Spawn one Lightning Wyrm (a real Set 1 card)
 *    into a random open space; L3 fills EVERY open space ("each available
 *    space").
 *  - Warhound Raider: static — it has Aggressive while any friendly Warhound
 *    Courser is in play. Warhound Courser's own Aggressive is missing from the
 *    parsed data ("{{Free}}." — the period ends extractKeywords' leading
 *    template run before "{{Aggressive}}"), so the Courser gets an enterPlay
 *    fix-up grant (set7-alloyin.ts "inherent-armor" precedent). TODO: drop the
 *    fix-up if the parser ever tolerates punctuation between templates.
 *  - Avarice, the Insatiable: the random discards do NOT level up (Necroplasm
 *    / Plunder Imp convention); "you may play an additional spell this turn"
 *    is an unrestricted playsLeft += 1 (Static Shock / Ashurian Flamesculptor
 *    convention — legalActions cannot gate the bonus play to spells).
 *  - Quakeasaurus Wrecks: BOTH damage packets equal mult × the number of
 *    friendly Dinosaurs (itself included — it is a Dinosaur); the enemy-player
 *    packet still lands when there is no enemy creature to hit.
 *  - Ritual of the Elements tokens: Lava Golem's and Lightning Titan's
 *    "Friendly creatures have ..." auras include the token itself (the text
 *    lacks "other" — contrast Nug's "each OTHER friendly creature"). Frost
 *    Hulk is vanilla and needs no script. The Ritual has no prompt, so the
 *    spawn's enterPlay triggers would be dropped (the Phoenix Call engine
 *    gap); none of the three tokens has an enterPlay ability, so nothing is
 *    lost.
 *  - Magmify (Slumbering Shrine's Solbind token): the one-shot "set attack
 *    equal to its health" is a permanent buff by the delta; "health" is the
 *    current health (effective health minus damage — Shardplate Behemoth
 *    convention, set5-uterra.ts).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, getStats, grantKeyword, moveCreature,
  negateKeyword, spawnCreature,
} from "../effects.js";
import {
  findCreature, hasKeyword, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Game } from "../game.js";
import type {
  ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload,
} from "../triggers.js";

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

function friendlyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of game.state.players[p].lanes) if (c && (!filter || filter(c))) out.push(c.uid);
  return out;
}

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

/** Word-match against combined subtype strings ("Fire Asir" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

/** Raid: own turn ending and 3+ friendly creatures initiated battle this turn. */
function raidReady(game: Game, self: CreatureState): boolean {
  return game.state.active === self.owner
    && game.state.players[self.owner].lanes.filter((c) => !!c && c.hasBattled).length >= 3;
}

/** Formation check on creature c's own side (both adjacent spaces occupied by allies). */
function inFormation(game: Game, c: CreatureState): boolean {
  const pl = game.state.players[c.owner];
  return c.lane > 0 && c.lane < pl.lanes.length - 1 && !!pl.lanes[c.lane - 1] && !!pl.lanes[c.lane + 1];
}

// ============================================================
// Creatures
// ============================================================

// --- Blitzmane, the Destroyer (Mobility 1 + Aggressive inherent; Raid: damage
//     equal to its attack to the opposing creature, else the enemy player) ---
registerCard({
  defId: "blitzmane-the-destroyer",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "raid-strafe",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const atk = getStats(ctx.game, self).attack;
          const foe = opposingCreature(ctx.game, self);
          if (foe) dealCreatureDamage(ctx.game, ctx.events, foe, atk, self);
          else dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), atk, self);
        },
      }],
    }]),
  ),
});

// --- Cauldron Mystic (a friendly creature enters play — itself included, see
//     header: N damage to a random enemy creature or the enemy player) ---
function cauldronBurn(ctx: Ctx, self: CreatureState, n: number): void {
  const foe = opposing(self.owner);
  const enemies = ctx.game.state.players[foe].lanes.filter((c): c is CreatureState => !!c);
  const pick = ctx.rng.pick([...enemies, null] as (CreatureState | null)[]);
  if (pick) dealCreatureDamage(ctx.game, ctx.events, pick, n, self);
  else dealPlayerDamage(ctx.game, ctx.events, foe, n, self);
}
registerCard({
  defId: "cauldron-mystic",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "cauldron-self",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => cauldronBurn(ctx, self, n),
        },
        {
          id: "cauldron-other",
          trigger: "anyCreatureEnterPlay" as const,
          condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner,
          resolve: (ctx: Ctx, self: CreatureState) => cauldronBurn(ctx, self, n),
        },
      ],
    }]),
  ),
});

// --- Dragonkeeper Shaman (Raid: N damage to each enemy creature) ---
registerCard({
  defId: "dragonkeeper-shaman",
  levels: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "raid-sweep",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foes = ctx.game.state.players[opposing(self.owner)].lanes
            .filter((c): c is CreatureState => !!c);
          for (const c of foes) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Iceshard Berserker (static: +N attack while opposed — Cloudcleaver Titan
//     precedent, inverted) ---
registerCard({
  defId: "iceshard-berserker",
  levels: Object.fromEntries(
    ([[1, 6], [2, 10], [3, 16]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "opposed-might",
        apply: (game: Game, self: CreatureState, target: CreatureState, out) => {
          if (target.uid === self.uid && opposingCreature(game, self)) out.attack += n;
        },
      }],
    }]),
  ),
});

// --- Slumbering Shrine (L1 Defender inherent; Solbind Magmify; when you play a
//     spell, you may Negate Defender from a friendly creature) ---
registerCard({
  defId: "slumbering-shrine",
  solbind: ["magmify"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "spellweave-negate",
        trigger: "spellPlayed" as const,
        targeted: true,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner,
        prompt: (game: Game, self: CreatureState) => req(
          "You may Negate Defender from a friendly creature",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => hasKeyword(c, "Defender")),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.owner === self.owner) negateKeyword(ctx.events, c, "Defender");
        },
      }],
    }]),
  ),
});

// --- Stampeding Mongosaur (Raid: N damage to the enemy player) ---
registerCard({
  defId: "stampeding-mongosaur",
  levels: Object.fromEntries(
    ([[1, 6], [2, 8], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "raid-trample",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
        },
      }],
    }]),
  ),
});

// --- Unstable Asir (Defender inherent; Vengeance: damage equal to its attack
//     to the enemy player — last-known attack, see header) ---
registerCard({
  defId: "unstable-asir",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "vengeance-burst",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(
            ctx.game, ctx.events, opposing(self.owner), getStats(ctx.game, self).attack, self,
          );
        },
      }],
    }]),
  ),
});

// --- Uranti Stormshaper (Defender inherent; at the start of your turn Spawn a
//     level N Lightning Wyrm; L3 fills every open space — see header) ---
registerCard({
  defId: "uranti-stormshaper",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "wyrm-call",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          if (lvl === 3) {
            for (let lane = 0; lane < pl.lanes.length; lane++) {
              if (!pl.lanes[lane]) {
                spawnCreature(ctx.game, ctx.events, self.owner, "lightning-wyrm", 3, { lane });
              }
            }
          } else {
            spawnCreature(ctx.game, ctx.events, self.owner, "lightning-wyrm", lvl, { lane: "random" });
          }
        },
      }],
    }]),
  ),
});

// --- Warhound Raider (Solbind Warhound Courser; static: Aggressive while a
//     friendly Warhound Courser is in play) ---
registerCard({
  defId: "warhound-raider",
  solbind: ["warhound-courser"],
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      statics: [{
        id: "pack-tactics",
        apply: (game: Game, self: CreatureState, target: CreatureState, out) => {
          if (target.uid !== self.uid) return;
          const hasCourser = game.state.players[self.owner].lanes
            .some((c) => !!c && c.defId === "warhound-courser");
          if (hasCourser) out.keywords.push({ keyword: "Aggressive", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Cyclone Rider (Set 7.1): when an enemy creature enters play unopposed,
//     move to the space opposing it (anyCreatureEnterPlay — fires for Forged
//     and un-Forged entries alike; enemyCreatureEntered is from-hand only) ---
registerCard({
  defId: "cyclone-rider",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "intercept-entry",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === opposing(self.owner)
          && evt.lane !== undefined
          && !game.state.players[self.owner].lanes[evt.lane], // unopposed
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.lane === undefined) return;
          // re-validate: the creature is still there and the space is still open
          const foe = ctx.game.state.players[opposing(self.owner)].lanes[evt.lane];
          if (foe) moveCreature(ctx.game, ctx.events, self, evt.lane); // no-ops if occupied
        },
      }],
    }]),
  ),
});

// --- Nug, Fury Fists (Set 7.1): at the start of your turn, each OTHER friendly
//     creature deals damage equal to its attack to the creature opposing it ---
registerCard({
  defId: "nug-fury-fists",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "fury-fists",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // simultaneous: capture attackers, attacks, and targets up front
          const hits: { source: CreatureState; atk: number; foe: CreatureState }[] = [];
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c || c.uid === self.uid) continue;
            const foe = opposingCreature(ctx.game, c);
            if (foe) hits.push({ source: c, atk: getStats(ctx.game, c).attack, foe });
          }
          for (const hit of hits) {
            dealCreatureDamage(ctx.game, ctx.events, hit.foe, hit.atk, hit.source);
          }
        },
      }],
    }]),
  ),
});

// --- Avarice, the Insatiable (Set 7.2; Mobility 1 inherent; Forge: L1/L2
//     discard down to one card at random — no level-ups, see header — and you
//     may play an additional spell this turn; L3 grants the spell only) ---
registerCard({
  defId: "avarice-the-insatiable",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-avarice",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          if (lvl < 3) {
            const pl = ctx.game.state.players[self.owner];
            while (pl.hand.length > 1) {
              const idx = ctx.rng.int(pl.hand.length);
              const [inst] = pl.hand.splice(idx, 1);
              if (!inst) break;
              pl.discard.push(inst); // random discard: no level-up (Necroplasm convention)
              ctx.events.push({
                type: "discard", player: self.owner, defId: inst.defId, level: inst.level,
              });
            }
          }
          ctx.game.state.playsLeft += 1; // "an additional spell" — unrestricted (see header)
        },
      }],
    }]),
  ),
});

// --- Quakeasaurus Wrecks (Set 7.3; Raid: mult × friendly Dinosaurs — itself
//     included — to a random enemy creature AND to the enemy player) ---
registerCard({
  defId: "quakeasaurus-wrecks",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, mult]) => [lvl, {
      abilities: [{
        id: "raid-quake",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => raidReady(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = opposing(self.owner);
          const enemies = ctx.game.state.players[foe].lanes.filter((c): c is CreatureState => !!c);
          const n = mult * friendlyUids(ctx.game, self.owner, (c) => hasSubtype(ctx.game, c.defId, "Dinosaur")).length;
          if (enemies.length) dealCreatureDamage(ctx.game, ctx.events, ctx.rng.pick(enemies), n, self);
          dealPlayerDamage(ctx.game, ctx.events, foe, n, self);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Chaos Twister (N damage to an enemy creature; if IT is in Formation, the
//     adjacent enemy creatures take N as well) ---
registerCard({
  defId: "chaos-twister",
  spell: Object.fromEntries(
    ([[1, 6], [2, 8], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Deal ${n} damage to an enemy creature (its adjacent allies too if it is in Formation)`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (inFormation(ctx.game, c)) {
          for (const lane of [c.lane - 1, c.lane + 1]) {
            const adj = ctx.game.state.players[c.owner].lanes[lane];
            if (adj) dealCreatureDamage(ctx.game, ctx.events, adj, n);
          }
        }
      },
    }]),
  ),
});

// --- Fit of Rage (Overload inherent; a friendly opposed creature gets +attack
//     equal to the creature opposing it this turn) ---
registerCard({
  defId: "fit-of-rage",
  spell: {
    1: {
      prompt: (game: Game, player: PlayerId) => req(
        "Give a friendly opposed creature +attack equal to the creature opposing it this turn",
        "friendlyCreature",
        friendlyUids(game, player, (c) => !!opposingCreature(game, c)),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        const foe = opposingCreature(ctx.game, c);
        if (!foe) return; // became unopposed since the prompt
        buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, foe).attack, 0, true);
      },
    },
  },
});

// --- Blazing Hostility (Set 7.2): N damage to an enemy creature; if it is
//     Nekrium, N damage to the enemy player as well ---
registerCard({
  defId: "blazing-hostility",
  spell: Object.fromEntries(
    ([[1, 6], [2, 9], [3, 20]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Deal ${n} damage to an enemy creature (the enemy player too if it is Nekrium)`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (ctx.game.state.cards[c.defId]?.faction === "Nekrium") {
          dealPlayerDamage(ctx.game, ctx.events, opposing(player), n);
        }
      },
    }]),
  ),
});

// --- Ritual of the Elements (Set 7.3): Spawn a Lava Golem, Frost Hulk, or
//     Lightning Titan at random (all level-1 tokens) ---
registerCard({
  defId: "ritual-of-the-elements",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pick = ctx.rng.pick(["lava-golem", "frost-hulk", "lightning-titan"]);
        spawnCreature(ctx.game, ctx.events, player, pick, 1, { lane: "random" });
      },
    },
  },
});

// ============================================================
// Support cards
// ============================================================

// --- Magmify (Slumbering Shrine's Solbind token; L2 Free inherent): set a
//     friendly creature's attack equal to its current health (see header) ---
registerCard({
  defId: "magmify",
  spell: Object.fromEntries(
    [1, 2].map((lvl) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        "Set a friendly creature's attack equal to its health",
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        const hp = Math.max(0, getStats(ctx.game, c).health - c.damage);
        buffCreature(ctx.game, ctx.events, c, hp - getStats(ctx.game, c).attack, 0);
      },
    }]),
  ),
});

// --- Lava Golem (Ritual of the Elements token): friendly creatures have
//     +4 attack — itself included (see header) ---
registerCard({
  defId: "lava-golem",
  levels: {
    1: {
      statics: [{
        id: "molten-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, out) => {
          if (target.owner === self.owner) out.attack += 4;
        },
      }],
    },
  },
});

// --- Lightning Titan (Ritual of the Elements token): friendly creatures have
//     Aggressive — itself included (see header) ---
registerCard({
  defId: "lightning-titan",
  levels: {
    1: {
      statics: [{
        id: "storm-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, out) => {
          if (target.owner === self.owner) out.keywords.push({ keyword: "Aggressive", value: 0 });
        },
      }],
    },
  },
});

// frost-hulk: vanilla token, no script required.
// lightning-wyrm: Set 1 card with inherent Aggressive only, no script required.
