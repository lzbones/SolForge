/**
 * Set 4 (Imprisoned Heralds) + 4.1 + 4.2 — Tempys card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set3-tempys.ts):
 *  - "Battles an additional time" (Saberfang, Lug, Staff of Vaerus at every
 *    level): CreatureState.extraBattles is unused by the engine; emulated via
 *    state.battlesLeft += 1 (Zyx, Storm Herald / Call the Lightning
 *    convention). Staff of Vaerus L3's "each friendly creature" still grants
 *    one extra battle action per turn, and Lug grants one per friendly move —
 *    on your turn only, per the card text.
 *  - Stormspear: "you may play an additional Stormspear this turn" grants an
 *    unrestricted extra play (playsLeft += 1); legalActions cannot gate the
 *    bonus play by card (Necroflay / Anatomize convention).
 *  - Ator, Thunder Titan: the engine cannot grant triggered abilities through
 *    a static aura, so "gets Assault: Aggressive" is emulated by Ator watching
 *    friendly Forges (anyCreatureEnterPlay with fromHand) and granting
 *    Aggressive when the entering creature is unopposed and within the level
 *    cap — the same moments the granted Assault would have fired.
 *  - Rumblestone Elemental's recursive "then repeat this for each copy"
 *    resolves to filling every open space with a copy: each copy spawns the
 *    next until the field is full. The copies are Spawned (not Forged), so
 *    their own Assault does not fire — matching the text's net effect.
 *  - Lug triggers on its own move too ("a friendly creature" includes Lug —
 *    Frostfang Maiden precedent): a moved trigger covers self-moves,
 *    friendlyCreatureMoved covers other friendly creatures.
 *  - Staff of Vaerus is a spell at L1/L2 and a creature at L3 (per-level types
 *    via typeAt); the L3 body is 15/12 per the scraped data.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, grantKeyword, moveCreature, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, opposing } from "../state.js";
import type { Game } from "../game.js";
import type { CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

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

function enemyUids(game: Game, p: PlayerId, filter?: (c: CreatureState) => boolean): number[] {
  return friendlyUids(game, opposing(p), filter);
}

/** Assault: the opposing space of this creature's lane is empty. */
function unopposed(game: Game, self: CreatureState): boolean {
  return !game.state.players[opposing(self.owner)].lanes[self.lane];
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

// ---------- granted abilities ----------

// Violent Outburst: "When this creature deals battle damage to a player, it
// also deals that much damage to itself."
registerGranted("tempys:set4-outburst", {
  id: "tempys:set4-outburst",
  trigger: "battleDamageToPlayer",
  resolve(ctx, self, evt) {
    dealCreatureDamage(ctx.game, ctx.events, self, evt.amount ?? 0, self);
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Ator, Thunder Titan (Set 4.1; friendly Forges up to a level cap get
//     "Assault: Aggressive" — aura emulation, see header note) ---
registerCard({
  defId: "ator-thunder-titan",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "assault-grant",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) => {
          if (!evt.fromHand || evt.sourceOwner !== self.owner || evt.sourceUid === self.uid) {
            return false;
          }
          const c = evt.sourceUid !== undefined ? findCreature(game.state, evt.sourceUid) : null;
          if (!c || c.level > cap) return false;
          return !game.state.players[opposing(c.owner)].lanes[c.lane]; // Assault gate
        },
        resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) grantKeyword(ctx.events, c, { keyword: "Aggressive", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Borean Windweaver (each other friendly creature gets Mobility N) ---
registerCard({
  defId: "borean-windweaver",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      statics: [{
        id: "mobility-aura",
        apply: (_game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.owner === self.owner && target.uid !== self.uid) {
            out.keywords.push({ keyword: "Mobility", value: lvl });
          }
        },
      }],
    }]),
  ),
});

// --- Brimstone Tyrant (Upgrade: N damage to each other creature) ---
registerCard({
  defId: "brimstone-tyrant",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "upgrade-blast",
        trigger: "enterReplace" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of allCreatures(ctx.game.state)) {
            if (c.uid !== self.uid) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
          }
        },
      }],
    }]),
  ),
});

// --- Firelight Hunter (Assault: N damage to an enemy creature) ---
registerCard({
  defId: "firelight-hunter",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "assault-bolt",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => unopposed(game, self),
        prompt: (game: Game, self: CreatureState) => req(
          `Deal ${n} damage to an enemy creature`,
          "enemyCreature",
          enemyUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Lavafused Asir (while a friendly creature is unopposed, it gets +N attack) ---
registerCard({
  defId: "lavafused-asir",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "unopposed-might",
        apply: (game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.owner !== self.owner) return;
          if (!game.state.players[opposing(target.owner)].lanes[target.lane]) out.attack += n;
        },
      }],
    }]),
  ),
});

// --- Lug, Uranti Charger (Set 4.2; friendly move on your turn: extra battle) ---
registerCard({
  defId: "lug-uranti-charger",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "extra-battle-self",
          trigger: "moved" as const,
          condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
          resolve: (ctx: Ctx) => {
            ctx.game.state.battlesLeft += 1; // see header note
          },
        },
        {
          id: "extra-battle",
          trigger: "friendlyCreatureMoved" as const,
          condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
          resolve: (ctx: Ctx) => {
            ctx.game.state.battlesLeft += 1; // see header note
          },
        },
      ],
    }]),
  ),
});

// --- Rumblestone Elemental (Set 4.1; battle damage to a player also hits
//     itself; Assault: fill every open space with a copy — see header note) ---
registerCard({
  defId: "rumblestone-elemental",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "self-sting",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            dealCreatureDamage(ctx.game, ctx.events, self, evt.amount ?? 0, self);
          },
        },
        {
          id: "assault-multiply",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) => unopposed(game, self),
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (let i = 0; i < 4; i++) { // self's lane is taken: at most 4 copies
              const copy = spawnCreature(
                ctx.game, ctx.events, self.owner, "rumblestone-elemental", self.level, { lane: "random" },
              );
              if (!copy) break;
            }
          },
        },
      ],
    }]),
  ),
});

// --- Saberfang (Aggressive; battles an additional time on your turn) ---
registerCard({
  defId: "saberfang",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "extra-battle",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.battlesLeft += 1; // see header note (Zyx convention)
        },
      }],
    }]),
  ),
});

// --- Sparksoul (Upgrade: Sparksoul gets Aggressive) ---
registerCard({
  defId: "sparksoul",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "upgrade-aggressive",
        trigger: "enterReplace" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Aggressive", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Thranik Ambusher (Assault: +N/+N) ---
registerCard({
  defId: "thranik-ambusher",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "assault-buff",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => unopposed(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Totembound Berserker (Assault: you may drag an enemy creature, up to a
//     level cap, into the space opposing it) ---
registerCard({
  defId: "totembound-berserker",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "assault-drag",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => unopposed(game, self),
        prompt: (game: Game, self: CreatureState) => req(
          cap === 99
            ? "You may move an enemy creature to the space opposing Totembound Berserker"
            : `You may move an enemy level ${cap} or lower creature to the space opposing Totembound Berserker`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => c.level <= cap),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner === self.owner) return;
          moveCreature(ctx.game, ctx.events, c, self.lane);
        },
      }],
    }]),
  ),
});

// --- Uranti Elementalist (Forge: you may move another friendly creature to an
//     available adjacent space — Windcaller Shaman precedent, no level cap) ---
registerCard({
  defId: "uranti-elementalist",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-shuffle",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "Move another friendly creature to an available space adjacent to Uranti Elementalist",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.uid === self.uid || c.owner !== self.owner) return;
          const lanes = ctx.game.state.players[self.owner].lanes;
          const open = [self.lane - 1, self.lane + 1].filter((i) => i >= 0 && i < lanes.length && !lanes[i]);
          if (open.length) moveCreature(ctx.game, ctx.events, c, ctx.rng.pick(open));
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells (+ Staff of Vaerus: spell at L1/L2, creature at L3)
// ============================================================

// --- Chant of Dragonwatch (X = your Rank damage to each enemy creature) ---
registerCard({
  defId: "chant-of-dragonwatch",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const x = ctx.game.state.players[player].rank;
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, x);
        }
      },
    },
  },
});

// --- Staff of Vaerus (L1/L2: give a friendly creature Mobility N and an extra
//     battle this turn; L3: the 15/12 Dragon whose aura grants an extra battle
//     on each of your turns — see header notes) ---
registerCard({
  defId: "staff-of-vaerus",
  spell: Object.fromEntries(
    ([[1, 1, 2], [2, 2, 99]] as const).map(([lvl, mob, cap]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        cap === 99
          ? `Give a friendly creature Mobility ${mob}`
          : `Give a friendly level ${cap} or lower creature Mobility ${mob}`,
        "friendlyCreature",
        friendlyUids(game, player, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        grantKeyword(ctx.events, c, { keyword: "Mobility", value: mob });
        ctx.game.state.battlesLeft += 1; // "battles an additional time this turn" (see header)
      },
    }]),
  ),
  levels: {
    3: {
      abilities: [{
        id: "extra-battle",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.battlesLeft += 1; // see header note
        },
      }],
    },
  },
});

// --- Stormspear (N damage to a creature; unrestricted extra play — see header) ---
registerCard({
  defId: "stormspear",
  spell: Object.fromEntries(
    ([[1, 3], [2, 7], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) dealCreatureDamage(ctx.game, ctx.events, c, n);
        // "additional Stormspear" gate cannot be enforced (see header)
        ctx.game.state.playsLeft += 1;
      },
    }]),
  ),
});

// --- Thunderstomp (Set 4.2; N to an enemy creature, then another N if you
//     control a Dinosaur — chained second choice) ---
registerCard({
  defId: "thunderstomp",
  spell: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Deal ${n} damage to an enemy creature`,
        "enemyCreature",
        enemyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        // priorAnswers includes the current answer: >=2 means this is the
        // chained second hit (Oratek Battlebrand convention).
        const c = targetOf(ctx, choice);
        if (c) dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (ctx.priorAnswers.length >= 2) return;
        const hasDino = ctx.game.state.players[player].lanes
          .some((d) => d && hasSubtype(ctx.game, d.defId, "Dinosaur"));
        if (!hasDino) return;
        const foes = enemyUids(ctx.game, player);
        if (!foes.length) return;
        return {
          kind: "enemyCreature" as const,
          prompt: `Deal another ${n} damage to an enemy creature`,
          options: foes,
        };
      },
    }]),
  ),
});

// --- Violent Outburst (give a creature Aggressive and a battle-damage
//     self-sting; L1 targets level 2 or lower; L3 Free is an inherent keyword) ---
registerCard({
  defId: "violent-outburst",
  spell: Object.fromEntries(
    ([[1, 2], [2, 99], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        cap === 99
          ? "Give a creature Aggressive and \"When this creature deals battle damage to a player, it also deals that much damage to itself\""
          : "Give a level 2 or lower creature Aggressive and \"When this creature deals battle damage to a player, it also deals that much damage to itself\"",
        "anyCreature",
        boardUids(game, (c) => c.level <= cap),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        grantKeyword(ctx.events, c, { keyword: "Aggressive", value: 0 });
        c.grantedAbilities.push("tempys:set4-outburst");
      },
    }]),
  ),
});
