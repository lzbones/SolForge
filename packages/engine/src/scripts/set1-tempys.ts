/**
 * Set 1 (Alpha) Tempys card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Engine workarounds used here (no engine changes):
 *  - Movement (Storm Bringer, Seismic Adept, Windcaller Shaman): effects.ts has
 *    no move primitive, so moveCreature() below mutates lanes directly and
 *    re-fires the "moved" trigger, mirroring the Mobility move in game.ts.
 *  - "Battle an additional time" (Call the Lightning, Zyx): CreatureState.
 *    extraBattles is unused by the engine; emulated via state.battlesLeft += 1.
 *  - "Play an additional level-N spell" (Static Shock, Master of Elements):
 *    the level gate cannot be enforced; emulated via state.playsLeft += 1.
 *  - "Defender until the start of your next turn" (Uranti Bolt): temp keywords
 *    clear at end of the CURRENT turn, so a permanent grant + one-shot removal
 *    trigger is used instead.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, collectFor, dealCreatureDamage, dealPlayerDamage, destroyCreature,
  getStats, grantKeyword, negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, isDead, opposing } from "../state.js";
import type { Game } from "../game.js";
import type { CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function creatureUids(game: Game, side?: PlayerId): number[] {
  const out: number[] = [];
  const sides: PlayerId[] = side === undefined ? [0, 1] : [side];
  for (const p of sides) {
    for (const c of game.state.players[p].lanes) if (c) out.push(c.uid);
  }
  return out;
}

function adjacentAllies(game: Game, self: CreatureState): CreatureState[] {
  const lanes = game.state.players[self.owner].lanes;
  return [self.lane - 1, self.lane + 1]
    .map((i) => lanes[i] ?? null)
    .filter((c): c is CreatureState => c !== null);
}

function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

/** Damage a chosen creature or player (sentinels -1/-2 = players 0/1). */
function damageChoice(ctx: Ctx, choice: ChoiceAnswer | null, amount: number, source: CreatureState | null = null): void {
  const t = choice?.targetUid;
  if (t === undefined || t === null) return;
  if (t === -1) dealPlayerDamage(ctx.game, ctx.events, 0, amount, source);
  else if (t === -2) dealPlayerDamage(ctx.game, ctx.events, 1, amount, source);
  else {
    const c = findCreature(ctx.game.state, t);
    if (c) dealCreatureDamage(ctx.game, ctx.events, c, amount, source);
  }
}

/**
 * Move a creature to another of its controller's spaces (the engine only moves
 * via the Mobility action; this mirrors that code path, including the trigger).
 */
function moveCreature(ctx: Ctx, c: CreatureState, to: number): void {
  const pl = ctx.game.state.players[c.owner];
  const from = c.lane;
  pl.lanes[from] = null;
  pl.lanes[to] = c;
  c.lane = to;
  ctx.events.push({ type: "moved", player: c.owner, uid: c.uid, from, to });
  collectFor(ctx.game, c, "moved", { sourceUid: c.uid, lane: to });
}

function req(prompt: string, kind: ChoiceRequest["kind"], options: number[], optional = false): Omit<ChoiceRequest, "id"> | null {
  if (!options.length) return null;
  return optional ? { kind, prompt, options, optional: true } : { kind, prompt, options };
}

// ---------- granted abilities (spells giving rules text to creatures) ----------

// Asir's Blessing: "When this creature deals battle damage to a player, it gets +N/+N."
for (const n of [1, 2, 3] as const) {
  registerGranted(`tempys:asir-${n}`, {
    id: `tempys:asir-${n}`,
    trigger: "battleDamageToPlayer",
    resolve(ctx, self) {
      buffCreature(ctx.game, ctx.events, self, n, n);
    },
  });
}

// Fervent Assault: "Flank: Deal N damage to opposing creature."
for (const n of [3, 6, 12] as const) {
  registerGranted(`tempys:flank-${n}`, {
    id: `tempys:flank-${n}`,
    trigger: "moved",
    resolve(ctx, self) {
      const opp = opposingCreature(ctx.game, self);
      if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, n, self);
    },
  });
}

// Frozen Solid: "When this is dealt damage, destroy it."
registerGranted("tempys:frozen-solid", {
  id: "tempys:frozen-solid",
  trigger: "damaged",
  resolve(ctx, self) {
    destroyCreature(ctx.game, ctx.events, self);
  },
});

// Uranti Bolt's Defender expires at the start of the CASTER's next turn.
// "-own" is for targets the caster controls, "-foe" for enemy targets.
for (const side of ["own", "foe"] as const) {
  registerGranted(`tempys:defender-expire-${side}`, {
    id: `tempys:defender-expire-${side}`,
    trigger: "turnStart",
    condition: (game, self) =>
      side === "own" ? game.state.active === self.owner : game.state.active !== self.owner,
    resolve(ctx, self) {
      negateKeyword(ctx.events, self, "Defender");
      self.grantedAbilities = self.grantedAbilities.filter((r) => r !== `tempys:defender-expire-${side}`);
    },
  });
}

// ---------- creatures ----------

// --- Abraxas, Avatar of Kadras (Activate: creature(s) get +X attack, X = own attack) ---
// "2X attack" doubles current attack (Advanced Rules: Abraxas takes a 4-attack
// creature to 8, and the temp buff inverts to -4 at end of turn).
registerCard({
  defId: "abraxas-avatar-of-kadras",
  levels: {
    1: {
      activates: [{
        id: "empower-one",
        condition: (game, self) => adjacentAllies(game, self).length > 0,
        prompt: (game, self) => req(
          "Give an adjacent creature +X attack this turn (X = its attack)",
          "friendlyCreature",
          adjacentAllies(game, self).map((c) => c.uid),
        ),
        resolve: (ctx, _self, choice) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, c).attack, 0, true);
        },
      }],
    },
    2: {
      activates: [{
        id: "empower-adjacent",
        condition: (game, self) => adjacentAllies(game, self).length > 0,
        resolve: (ctx, self) => {
          for (const c of adjacentAllies(ctx.game, self)) {
            buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, c).attack, 0, true);
          }
        },
      }],
    },
    3: {
      activates: [{
        id: "empower-all",
        resolve: (ctx, self) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, c).attack, 0, true);
          }
        },
      }],
    },
  },
});

// --- Avalanche Invoker (when you gain a Rank, deal N to each non-Tempys creature) ---
const avalanche: Record<number, number> = { 1: 3, 2: 6, 3: 12 };
registerCard({
  defId: "avalanche-invoker",
  levels: Object.fromEntries(
    Object.entries(avalanche).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "avalanche",
        trigger: "rankGained" as const,
        // rankGained fires during the ranking player's endTurn, while they are still active
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          for (const c of [...allCreatures(ctx.game.state)]) {
            if (ctx.game.state.cards[c.defId]?.faction !== "Tempys") {
              dealCreatureDamage(ctx.game, ctx.events, c, n);
            }
          }
        },
      }],
    }]),
  ),
});

// --- Cinderfist Brawler (battle damage to a player is dealt again) ---
registerCard({
  defId: "cinderfist-brawler",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "double-tap",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          // ability damage, NOT battle damage (battle=true would retrigger itself)
          dealPlayerDamage(ctx.game, ctx.events, evt.targetPlayer ?? opposing(self.owner), evt.amount ?? 0, self);
        },
      }],
    }]),
  ),
});

// --- Everflame Phoenix (L2: rank up -> become L3; L3: Vengeance -> L2 in this space) ---
registerCard({
  defId: "everflame-phoenix",
  levels: {
    1: {}, // Mobility 1 is inherent from card data
    2: {
      abilities: [{
        id: "rebirth-up",
        trigger: "rankGained" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "everflame-phoenix", 3, { lane: self.lane, replace: true });
        },
      }],
    },
    3: {
      abilities: [{
        id: "rebirth-down",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "everflame-phoenix", 2, { lane: evt.lane ?? "random" });
        },
      }],
    },
  },
});

// --- Flame Speaker (when you play a spell, deal N to the enemy player) ---
const flameSpeaker: Record<number, number> = { 1: 2, 2: 3, 3: 5 };
registerCard({
  defId: "flame-speaker",
  levels: Object.fromEntries(
    Object.entries(flameSpeaker).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "spell-burn",
        trigger: "spellPlayed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
        },
      }],
    }]),
  ),
});

// --- Flameblade Champion (battle damage to a player hits each creature that player controls) ---
registerCard({
  defId: "flameblade-champion",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "sweep",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const p = evt.targetPlayer ?? opposing(self.owner);
          for (const c of [...ctx.game.state.players[p].lanes]) {
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, evt.amount ?? 0, self);
          }
        },
      }],
    }]),
  ),
});

// --- Flameshaper Savant (when you play a level-<=gate Tempys card, you may
//     have it deal N damage to a creature or player; L2+) ---
registerCard({
  defId: "flameshaper-savant",
  levels: {
    1: {}, // vanilla 4/6
    ...Object.fromEntries(
      ([[2, 1, 4], [3, 2, 7]] as const).map(([lvl, gate, n]) => [lvl, {
        abilities: [{
          id: "shape-flame",
          trigger: "cardPlayed" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner
            && evt.sourceLevel !== undefined && evt.sourceLevel <= gate
            && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Tempys",
          prompt: (game: Game) => req(
            `Flameshaper Savant deals ${n} damage to a creature or player`,
            "anyCreatureOrPlayer",
            [-1, -2, ...creatureUids(game)],
            true,
          ),
          resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
            damageChoice(ctx, choice, n, self);
          },
        }],
      }]),
    ),
  },
});

// --- Flamestoke Shaman (Activate: give an adjacent level-<=N creature Aggressive) ---
const flamestoke: Record<number, number> = { 1: 1, 2: 2, 3: 99 };
registerCard({
  defId: "flamestoke-shaman",
  levels: Object.fromEntries(
    Object.entries(flamestoke).map(([lvl, cap]) => [lvl, {
      activates: [{
        id: "haste",
        condition: (game: Game, self: CreatureState) =>
          adjacentAllies(game, self).some((c) => c.level <= cap),
        prompt: (game: Game, self: CreatureState) => req(
          "Give an adjacent creature Aggressive",
          "friendlyCreature",
          adjacentAllies(game, self).filter((c) => c.level <= cap).map((c) => c.uid),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) grantKeyword(ctx.events, c, { keyword: "Aggressive", value: 0 });
        },
      }],
    }]),
  ),
});

// --- Magma Hound (Forge: you may deal N to an enemy creature) ---
const magmaHound: Record<number, number> = { 1: 2, 2: 4, 3: 6 };
registerCard({
  defId: "magma-hound",
  levels: Object.fromEntries(
    Object.entries(magmaHound).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-burn",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Deal ${n} damage to an enemy creature`,
          "enemyCreature",
          creatureUids(game, opposing(self.owner)),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Master of Elements (Forge: you may play an additional level-N spell this turn) ---
// NOTE: the engine cannot gate the bonus play to level-N spells; this grants a
// full extra play (playsLeft + 1). Level gate is not enforced.
registerCard({
  defId: "master-of-elements",
  levels: {
    1: {}, // no rules text at level 1
    2: {
      abilities: [{
        id: "extra-spell",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += 1;
        },
      }],
    },
    3: {
      abilities: [{
        id: "extra-spell",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += 1;
        },
      }],
    },
  },
});

// --- Nargath Bruiser (Forge: give a friendly creature +N health) ---
const nargath: Record<number, number> = { 1: 2, 2: 4, 3: 8 };
registerCard({
  defId: "nargath-bruiser",
  levels: Object.fromEntries(
    Object.entries(nargath).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-bulk",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Give a friendly creature +${n} health`,
          "friendlyCreature",
          creatureUids(game, self.owner),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
        },
      }],
    }]),
  ),
});

// --- Pyre Giant (Aggressive; +N attack while unopposed) ---
const pyre: Record<number, number> = { 1: 4, 2: 6, 3: 8 };
registerCard({
  defId: "pyre-giant",
  levels: Object.fromEntries(
    Object.entries(pyre).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "unopposed",
        apply: (game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.uid === self.uid && !game.state.players[opposing(self.owner)].lanes[self.lane]) {
            stats.attack += n;
          }
        },
      }],
    }]),
  ),
});

// --- Rageborn Hellion (when a friendly creature deals battle damage to a player, +N/+N) ---
// The engine fires battleDamageToPlayer only on the damage source itself and
// friendlyBattleDamageToPlayer on the OTHER friendly creatures — listen to both
// so "a friendly creature" includes the Hellion's own hits.
const rageborn: Record<number, number> = { 1: 1, 2: 2, 3: 3 };
registerCard({
  defId: "rageborn-hellion",
  levels: Object.fromEntries(
    Object.entries(rageborn).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "rage-self",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
        {
          id: "rage-ally",
          trigger: "friendlyBattleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            buffCreature(ctx.game, ctx.events, self, n, n);
          },
        },
      ],
    }]),
  ),
});

// --- Riftlasher (battle damage to a player on your turn: deal that much to an enemy creature) ---
registerCard({
  defId: "riftlasher",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "lash",
        trigger: "battleDamageToPlayer" as const,
        targeted: true,
        // enemy creatures can deal battle damage to a player during the enemy's battle; "on your turn" excludes that
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        prompt: (game: Game, self: CreatureState) => req(
          "Deal that much damage to an enemy creature",
          "enemyCreature",
          creatureUids(game, opposing(self.owner)),
        ),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, evt.amount ?? 0, self);
        },
      }],
    }]),
  ),
});

// --- Scorchmane Dragon (L2 Forge: 5 to opposing; L3 Forge: 5 to each enemy creature and player) ---
registerCard({
  defId: "scorchmane-dragon",
  levels: {
    1: {}, // Defender is inherent from card data
    2: {
      abilities: [{
        id: "forge-blast",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const opp = opposingCreature(ctx.game, self);
          if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, 5, self);
        },
      }],
    },
    3: {
      abilities: [{
        id: "forge-sweep",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = opposing(self.owner);
          for (const c of [...ctx.game.state.players[foe].lanes]) {
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, 5, self);
          }
          dealPlayerDamage(ctx.game, ctx.events, foe, 5, self);
        },
      }],
    },
  },
});

// --- Seismic Adept (Activate: move an enemy creature to another available enemy space) ---
// NOTE: the engine supports a single choice per ability, so the creature is
// chosen by the player but the destination space is picked at random.
registerCard({
  defId: "seismic-adept",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "quake",
        condition: (game: Game, self: CreatureState) => {
          const foe = opposing(self.owner);
          return creatureUids(game, foe).length > 0 && game.state.players[foe].lanes.some((l) => !l);
        },
        prompt: (game: Game, self: CreatureState) => req(
          "Move an enemy creature to another available enemy space",
          "enemyCreature",
          creatureUids(game, opposing(self.owner)),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (!c) return;
          const open = ctx.game.state.players[c.owner].lanes.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
          if (open.length) moveCreature(ctx, c, ctx.rng.pick(open));
        },
      }],
    }]),
  ),
});

// --- Spiritflame Mystic (Vengeance: deal N to each creature) ---
// NOTE: scraped data lacks L2/L3 health ("?" on the wiki); only the Vengeance
// numbers are scripted here.
const spiritflame: Record<number, number> = { 1: 2, 2: 4, 3: 6 };
registerCard({
  defId: "spiritflame-mystic",
  levels: Object.fromEntries(
    Object.entries(spiritflame).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "vengeance-burn",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx) => {
          for (const c of [...allCreatures(ctx.game.state)]) {
            dealCreatureDamage(ctx.game, ctx.events, c, n);
          }
        },
      }],
    }]),
  ),
});

// --- Storm Bringer (start of each turn: move to a random open space; Flank: N damage) ---
const stormBringer: Record<number, number> = { 1: 2, 2: 4, 3: 6 };
registerCard({
  defId: "storm-bringer",
  levels: Object.fromEntries(
    Object.entries(stormBringer).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "drift",
          trigger: "turnStart" as const, // every turn, both players'
          resolve: (ctx: Ctx, self: CreatureState) => {
            const lanes = ctx.game.state.players[self.owner].lanes;
            const open = lanes.map((c, i) => (c || i === self.lane ? -1 : i)).filter((i) => i >= 0);
            if (open.length) moveCreature(ctx, self, ctx.rng.pick(open));
          },
        },
        {
          id: "flank",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const opp = opposingCreature(ctx.game, self);
            if (opp) dealCreatureDamage(ctx.game, ctx.events, opp, n, self);
          },
        },
      ],
    }]),
  ),
});

// --- Stormforged Avatar (Forge: +N/+N for each Tempys card in your hand) ---
const stormforged: Record<number, number> = { 1: 1, 2: 2, 3: 3 };
registerCard({
  defId: "stormforged-avatar",
  levels: Object.fromEntries(
    Object.entries(stormforged).map(([lvl, per]) => [lvl, {
      abilities: [{
        id: "forge-charge",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].hand
            .filter((inst) => ctx.game.state.cards[inst.defId]?.faction === "Tempys").length;
          if (count > 0) buffCreature(ctx.game, ctx.events, self, per * count, per * count);
        },
      }],
    }]),
  ),
});

// --- Uranti Cryomancer (Activate: deal N to a creature) ---
const cryomancer: Record<number, number> = { 1: 1, 2: 3, 3: 5 };
registerCard({
  defId: "uranti-cryomancer",
  levels: Object.fromEntries(
    Object.entries(cryomancer).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "frostbolt",
        prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", creatureUids(game)),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
        },
      }],
    }]),
  ),
});

// --- Volcanic Giant (start of your turn: deal min..max to the enemy player) ---
const volcanic: Record<number, [number, number]> = { 1: [1, 4], 2: [3, 8], 3: [7, 13] };
registerCard({
  defId: "volcanic-giant",
  levels: Object.fromEntries(
    Object.entries(volcanic).map(([lvl, [min, max]]) => [lvl, {
      abilities: [{
        id: "erupt",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), ctx.rng.int(max - min + 1) + min);
        },
      }],
    }]),
  ),
});

// --- Windcaller Shaman (Forge: you may move a friendly level-<=N creature adjacent) ---
// NOTE: single-choice engine — if both adjacent spaces are open, the destination
// is picked at random.
const windcaller: Record<number, number> = { 1: 1, 2: 2, 3: 99 };
registerCard({
  defId: "windcaller-shaman",
  levels: Object.fromEntries(
    Object.entries(windcaller).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-call",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "Move another friendly creature to an available space adjacent to Windcaller Shaman",
          "friendlyCreature",
          game.state.players[self.owner].lanes
            .filter((c) => c && c.uid !== self.uid && c.level <= cap)
            .map((c) => c!.uid),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
          if (!c || c.uid === self.uid) return;
          const lanes = ctx.game.state.players[self.owner].lanes;
          const open = [self.lane - 1, self.lane + 1].filter((i) => i >= 0 && i < lanes.length && !lanes[i]);
          if (open.length) moveCreature(ctx, c, ctx.rng.pick(open));
        },
      }],
    }]),
  ),
});

// --- Zyx, Storm Herald (Mobility 1; battles an additional time on your turn) ---
// NOTE: CreatureState.extraBattles is unused by the engine; emulated by granting
// an extra battle action (battlesLeft + 1) at the start of each of your turns.
registerCard({
  defId: "zyx-storm-herald",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "extra-battle",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.battlesLeft += 1;
        },
      }],
    }]),
  ),
});

// ---------- spells ----------

// --- Aquatic Embrace (give a creature +N health) ---
const embrace: Record<number, number> = { 1: 5, 2: 10, 3: 20 };
registerCard({
  defId: "aquatic-embrace",
  spell: Object.fromEntries(
    Object.entries(embrace).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Give a creature +${n} health`, "anyCreature", creatureUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
      },
    }]),
  ),
});

// --- Asir's Blessing (give a creature "battle damage to a player: +N/+N") ---
registerCard({
  defId: "asirs-blessing",
  spell: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature "deals battle damage to a player: +${lvl}/+${lvl}"`,
        "anyCreature",
        creatureUids(game),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (c) c.grantedAbilities.push(`tempys:asir-${lvl}`);
      },
    }]),
  ),
});

// --- Call the Lightning (friendly creatures battle an additional time; L2+: +N attack) ---
const callLightning: Record<number, number> = { 1: 0, 2: 2, 3: 4 };
registerCard({
  defId: "call-the-lightning",
  spell: Object.fromEntries(
    Object.entries(callLightning).map(([lvl, atk]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        // extra battle action emulates "battle an additional time" (see header)
        ctx.game.state.battlesLeft += 1;
        if (atk > 0) {
          for (const c of ctx.game.state.players[player].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, atk, 0, true);
          }
        }
      },
    }]),
  ),
});

// --- Disintegrate (deal 1..max to the enemy player) ---
const disintegrate: Record<number, number> = { 1: 8, 2: 15, 3: 25 };
registerCard({
  defId: "disintegrate",
  spell: Object.fromEntries(
    Object.entries(disintegrate).map(([lvl, max]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        dealPlayerDamage(ctx.game, ctx.events, opposing(player), ctx.rng.int(max) + 1);
      },
    }]),
  ),
});

// --- Fervent Assault (give a friendly creature Mobility N and "Flank: deal M") ---
const fervent: Record<number, { mob: number; dmg: number }> = {
  1: { mob: 1, dmg: 3 }, 2: { mob: 2, dmg: 6 }, 3: { mob: 3, dmg: 12 },
};
registerCard({
  defId: "fervent-assault",
  spell: Object.fromEntries(
    Object.entries(fervent).map(([lvl, { mob, dmg }]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature Mobility ${mob} and "Flank: Deal ${dmg} damage"`,
        "friendlyCreature",
        creatureUids(game, player),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (!c) return;
        grantKeyword(ctx.events, c, { keyword: "Mobility", value: mob });
        c.grantedAbilities.push(`tempys:flank-${dmg}`);
      },
    }]),
  ),
});

// --- Firestorm (deal N to each creature) ---
const firestorm: Record<number, number> = { 1: 5, 2: 6, 3: 7 };
registerCard({
  defId: "firestorm",
  spell: Object.fromEntries(
    Object.entries(firestorm).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx) => {
        for (const c of [...allCreatures(ctx.game.state)]) {
          dealCreatureDamage(ctx.game, ctx.events, c, n);
        }
      },
    }]),
  ),
});

// --- Frozen Solid (give a level-<=N creature "when dealt damage, destroy it") ---
const frozenCap: Record<number, number> = { 1: 1, 2: 2, 3: 99 };
registerCard({
  defId: "frozen-solid",
  spell: Object.fromEntries(
    Object.entries(frozenCap).map(([lvl, cap]) => [lvl, {
      prompt: (game: Game) => req(
        "Give a creature \"When this is dealt damage, destroy it\"",
        "anyCreature",
        [...allCreatures(game.state)].filter((c) => c.level <= cap).map((c) => c.uid),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (c) c.grantedAbilities.push("tempys:frozen-solid");
      },
    }]),
  ),
});

// --- Iceborn Fortitude (each friendly creature gets +N health) ---
const fortitude: Record<number, number> = { 1: 3, 2: 5, 3: 10 };
registerCard({
  defId: "iceborn-fortitude",
  spell: Object.fromEntries(
    Object.entries(fortitude).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
        }
      },
    }]),
  ),
});

// --- Lightning Brand (give a (level-<=2) creature +N attack and Aggressive this turn) ---
const brand: Record<number, { atk: number; cap: number }> = {
  1: { atk: 1, cap: 2 }, 2: { atk: 2, cap: 99 }, 3: { atk: 4, cap: 99 },
};
registerCard({
  defId: "lightning-brand",
  spell: Object.fromEntries(
    Object.entries(brand).map(([lvl, { atk, cap }]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a creature +${atk} attack and Aggressive this turn`,
        "anyCreature",
        [...allCreatures(game.state)].filter((c) => c.level <= cap).map((c) => c.uid),
      ),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, atk, 0, true);
        grantKeyword(ctx.events, c, { keyword: "Aggressive", value: 0 }, true);
      },
    }]),
  ),
});

// --- Primordial Slam (give a creature +N attack this turn) ---
const slam: Record<number, number> = { 1: 7, 2: 11, 3: 15 };
registerCard({
  defId: "primordial-slam",
  spell: Object.fromEntries(
    Object.entries(slam).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Give a creature +${n} attack this turn`, "anyCreature", creatureUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (c) buffCreature(ctx.game, ctx.events, c, n, 0, true);
      },
    }]),
  ),
});

// --- Static Shock (deal N to a creature or player; play an additional spell) ---
// NOTE: L1/L2's "level N or lower spell" gate cannot be enforced by the engine;
// this grants a full extra play (playsLeft + 1).
const shock: Record<number, number> = { 1: 1, 2: 2, 3: 4 };
registerCard({
  defId: "static-shock",
  spell: Object.fromEntries(
    Object.entries(shock).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: `Deal ${n} damage to a creature or player`,
        options: [-1, -2, ...creatureUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        damageChoice(ctx, choice, n);
        ctx.game.state.playsLeft += 1;
      },
    }]),
  ),
});

// --- Uranti Bolt (deal N to a creature; it gets Defender until your next turn) ---
// NOTE: if the target had inherent Defender, the expiry trigger removes that too.
const bolt: Record<number, number> = { 1: 3, 2: 10, 3: 20 };
registerCard({
  defId: "uranti-bolt",
  spell: Object.fromEntries(
    Object.entries(bolt).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", creatureUids(game)),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
        if (!c) return;
        dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (isDead(c)) return;
        grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
        c.grantedAbilities.push(c.owner === player ? "tempys:defender-expire-own" : "tempys:defender-expire-foe");
      },
    }]),
  ),
});
