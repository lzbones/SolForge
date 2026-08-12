/**
 * Set 2.1 patch-set card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set2-nekrium.ts / set2-alloyin.ts):
 *  - Spirit Torrent is a Set 2.1 card but is already scripted in
 *    set5-nekrium.ts (Set 5 support card) — not re-registered here.
 *  - Avalanche Guardian (Defender + Mobility 1) and Flowstone Primordial
 *    (vanilla) are keyword-only/empty text: no script required.
 *  - Borean Mystic: when both spaces adjacent to it are open, the destination
 *    is picked at random (no lane-choice request kind exists).
 *  - Everflame Mystic: "you may play N additional spells this turn" cannot be
 *    gated to spells by legalActions; emulated via playsLeft += N (the Static
 *    Shock / Master of Elements convention from set1-tempys.ts).
 *  - The faction buff spells (Cypien Battlesuit, Savage Oath, Tarsian Pact,
 *    Tremorcharge) read "Give an X creature ..." with no "friendly" qualifier:
 *    targets are any creature of that faction on either side (an anyCreature
 *    choice filtered by faction).
 *  - Chistlehearth Archer's Negate strips inherent/temp keywords only;
 *    Mobility granted by a static aura (staticKeywords) is recomputed by the
 *    engine and survives (same gap as Shardthief Druid in set22.ts).
 *  - Vyric Ebonskull L3's copy is Spawned with the destroyed creature's base
 *    def/level (buffs do not carry over), into one of your open spaces.
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, destroyCreature, grantKeyword, healPlayer, moveCreature,
  negateKeyword, spawnCreature,
} from "../effects.js";
import {
  findCreature, hasKeyword, keywordValue, opposing,
  type CardInstance, type CreatureState, type PlayerId,
} from "../state.js";
import { maxLevel, typeAt } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, ChoiceRequest, Ctx, TriggerPayload } from "../triggers.js";

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

/** Open lanes adjacent to `self` on its own side. */
function openAdjacentLanes(game: Game, self: CreatureState): number[] {
  const lanes = game.state.players[self.owner].lanes;
  return [self.lane - 1, self.lane + 1].filter((i) => i >= 0 && i < lanes.length && !lanes[i]);
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

/** Hand indexes of cards that are spells at their current level. */
function spellHandIndexes(game: Game, p: PlayerId): number[] {
  const out: number[] = [];
  game.state.players[p].hand.forEach((inst: CardInstance, i: number) => {
    const def = game.state.cards[inst.defId];
    if (def && typeAt(def, inst.level) === "Spell") out.push(i);
  });
  return out;
}

/** Board uids of creatures belonging to `faction` (either side). */
function factionCreatureUids(game: Game, faction: string): number[] {
  return boardUids(game, (c) => game.state.cards[c.defId]?.faction === faction);
}

// ============================================================
// Creatures
// ============================================================

// --- Aegis Knight: Forge — each friendly creature deals damage equal to its
//     Armor to the opposing creature (Armor N is inherent). ---
registerCard({
  defId: "aegis-knight",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-armor-barrage",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c) continue;
            const armor = keywordValue(c, "Armor");
            if (armor <= 0) continue;
            const foe = opposingCreature(ctx.game, c);
            if (foe) dealCreatureDamage(ctx.game, ctx.events, foe, armor, c);
          }
        },
      }],
    }]),
  ),
});

// --- Aether Root: when you play an Uterra spell, it gets +N/+N. ---
registerCard({
  defId: "aether-root",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "uterra-spell-grow",
        trigger: "spellPlayed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Uterra",
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Aetherforge Oracle: Forge — you may discard and level up a spell. ---
registerCard({
  defId: "aetherforge-oracle",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-recycle",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          "You may discard and level up a spell",
          "cardInHand",
          spellHandIndexes(game, self.owner),
          true,
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const inst = ctx.game.state.players[self.owner].hand[choice.handIndex];
          const def = inst && ctx.game.state.cards[inst.defId];
          if (!def || typeAt(def, inst.level) !== "Spell") return;
          discardAndLevel(ctx, self.owner, choice.handIndex);
        },
      }],
    }]),
  ),
});

// --- Borean Mystic: Activate — move another friendly creature to an open
//     space adjacent to Borean Mystic (random when both are open — header). ---
registerCard({
  defId: "borean-mystic",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "draw-adjacent",
        condition: (game: Game, self: CreatureState) =>
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid).length > 0
          && openAdjacentLanes(game, self).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Move another friendly creature to an available space adjacent to Borean Mystic",
          "friendlyCreature",
          friendlyUids(game, self.owner, (c) => c.uid !== self.uid),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner !== self.owner || c.uid === self.uid) return;
          const spots = openAdjacentLanes(ctx.game, self);
          if (!spots.length) return;
          moveCreature(ctx.game, ctx.events, c, ctx.rng.pick(spots));
        },
      }],
    }]),
  ),
});

// --- Chistlehearth Archer: Forge — deal N damage to an enemy creature with
//     Mobility, then Negate Mobility from it. ---
registerCard({
  defId: "chistlehearth-archer",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 16]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-pin",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => req(
          `Deal ${n} damage to an enemy creature with Mobility. Negate Mobility from it`,
          "enemyCreature",
          enemyUids(game, self.owner, (c) => hasKeyword(c, "Mobility")),
        ),
        resolve: (ctx: Ctx, self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner === self.owner) return;
          dealCreatureDamage(ctx.game, ctx.events, c, n, self);
          negateKeyword(ctx.events, c, "Mobility");
        },
      }],
    }]),
  ),
});

// --- Everflame Mystic: when it deals battle damage to a player on your turn,
//     you may play N additional spells this turn (playsLeft — see header). ---
registerCard({
  defId: "everflame-mystic",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "battle-spell-refund",
        trigger: "battleDamageToPlayer" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx) => {
          ctx.game.state.playsLeft += lvl;
        },
      }],
    }]),
  ),
});

// --- Nyrali Symbiote: Forge — if opposed, it gets Regenerate N. ---
registerCard({
  defId: "nyrali-symbiote",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-opposed-regen",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => !!opposingCreature(game, self),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Regenerate", value: n });
        },
      }],
    }]),
  ),
});

// --- Oreian Fieldmarshal: Forge — each other friendly creature gets +N attack. ---
registerCard({
  defId: "oreian-fieldmarshal",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-rally",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid) buffCreature(ctx.game, ctx.events, c, n, 0);
          }
        },
      }],
    }]),
  ),
});

// --- Scatterspore Eidolon: at the start of your turn, Spawn an N/N token. ---
registerCard({
  defId: "scatterspore-eidolon",
  levels: Object.fromEntries(
    ([[1, "seedling", 3], [2, "sapling", 5], [3, "treefolk", 7]] as const).map(([lvl, token, n]) => [lvl, {
      abilities: [{
        id: "scatterspore",
        trigger: "turnStart" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
            { lane: "random", overrideStats: { attack: n, health: n } });
        },
      }],
    }]),
  ),
});

// --- Spiritbloom Dryad: Forge — each player gains N health. ---
registerCard({
  defId: "spiritbloom-dryad",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-bloom",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
          healPlayer(ctx.game, ctx.events, opposing(self.owner), n);
        },
      }],
    }]),
  ),
});

// --- Spitesower Acolyte: Activate, deal N damage to itself — give a creature
//     -N/-N. The self-damage is the cost: the debuff applies even if it dies. ---
registerCard({
  defId: "spitesower-acolyte",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "spite",
        prompt: (game: Game) => req(
          `Give a creature −${n} attack and −${n} health`,
          "anyCreature",
          boardUids(game),
        ),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          dealCreatureDamage(ctx.game, ctx.events, self, n);
          buffCreature(ctx.game, ctx.events, c, -n, -n);
        },
      }],
    }]),
  ),
});

// --- Vyric Ebonskull: when it deals battle damage to a player, destroy an
//     enemy level-<=cap creature at random; L3: then Spawn a copy of it. ---
registerCard({
  defId: "vyric-ebonskull",
  levels: Object.fromEntries(
    ([[1, 1, false], [2, 2, false], [3, 99, true]] as const).map(([lvl, cap, copy]) => [lvl, {
      abilities: [{
        id: "battle-reap",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pool = ctx.game.state.players[opposing(self.owner)].lanes
            .filter((c): c is CreatureState => !!c && c.level <= cap);
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          const { defId, level } = pick;
          destroyCreature(ctx.game, ctx.events, pick);
          if (copy) spawnCreature(ctx.game, ctx.events, self.owner, defId, level, { lane: "random" });
        },
      }],
    }]),
  ),
});

// --- War Merchant: Activate — a creature in the center space gets +N attack
//     (Defender is inherent; it only blocks attacking, not activating). ---
registerCard({
  defId: "war-merchant",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "center-buff",
        condition: (game: Game) => boardUids(game, (c) => c.lane === 2).length > 0,
        prompt: (game: Game) => req(
          `Give a creature in the center space +${n} attack`,
          "anyCreature",
          boardUids(game, (c) => c.lane === 2),
        ),
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.lane === 2) buffCreature(ctx.game, ctx.events, c, n, 0);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Cypien Battlesuit: give an Alloyin creature +N attack and Armor M. ---
registerCard({
  defId: "cypien-battlesuit",
  spell: Object.fromEntries(
    ([[1, 5, 1], [2, 10, 2], [3, 15, 4]] as const).map(([lvl, atk, armor]) => [lvl, {
      prompt: (game: Game) => req(
        `Give an Alloyin creature +${atk} attack and Armor ${armor}`,
        "anyCreature",
        factionCreatureUids(game, "Alloyin"),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, atk, 0);
        grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
      },
    }]),
  ),
});

// --- Savage Oath: give an Uterra creature +N/+N and Breakthrough. ---
registerCard({
  defId: "savage-oath",
  spell: Object.fromEntries(
    ([[1, 2], [2, 6], [3, 15]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(
        `Give an Uterra creature +${n} attack and +${n} health and Breakthrough`,
        "anyCreature",
        factionCreatureUids(game, "Uterra"),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 });
      },
    }]),
  ),
});

// --- Tarsian Pact: give a Nekrium creature +A/+H and Regenerate R. ---
registerCard({
  defId: "tarsian-pact",
  spell: Object.fromEntries(
    ([[1, 2, 2, 2], [2, 3, 3, 3], [3, 5, 2, 5]] as const).map(([lvl, atk, hp, regen]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a Nekrium creature +${atk} attack and +${hp} health and Regenerate ${regen}`,
        "anyCreature",
        factionCreatureUids(game, "Nekrium"),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, atk, hp);
        grantKeyword(ctx.events, c, { keyword: "Regenerate", value: regen });
      },
    }]),
  ),
});

// --- Tremorcharge: give a Tempys creature +N health and Mobility M. ---
registerCard({
  defId: "tremorcharge",
  spell: Object.fromEntries(
    ([[1, 4, 1], [2, 8, 2], [3, 12, 3]] as const).map(([lvl, hp, mobility]) => [lvl, {
      prompt: (game: Game) => req(
        `Give a Tempys creature +${hp} health and Mobility ${mobility}`,
        "anyCreature",
        factionCreatureUids(game, "Tempys"),
      ),
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, 0, hp);
        grantKeyword(ctx.events, c, { keyword: "Mobility", value: mobility });
      },
    }]),
  ),
});
