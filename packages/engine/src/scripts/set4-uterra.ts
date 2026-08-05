/**
 * Set 4 (Imprisoned Heralds) + 4.1 + 4.2 — Uterra card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set3-uterra.ts / set4-tempys.ts):
 *  - Venomstrike: "you may play an additional Venomstrike this turn" grants an
 *    unrestricted extra play (playsLeft += 1); legalActions cannot gate the
 *    bonus play by card (Stormspear / Anatomize / Necroflay convention).
 *  - Nova, Grove Queen's Forge spawns 1/1 Seedlings; the Seedling token's
 *    scraped base stats are "*", so overrideStats (Scatter the Seeds
 *    convention). L1's "an adjacent available space" is a random adjacent open
 *    space (no lane-choice kind exists).
 *  - Bron, Wild Tamer: dino-knight's own script (its battle-damage heal and
 *    "Vengeance: put a Bron into this space") is out of this file's scope
 *    (relic-scout / epoch-soldier convention); the Knight enters play with its
 *    printed Breakthrough/Aggressive only.
 *  - Lysian Rain: "give a creature or player +N health" — a creature gets a
 *    permanent +N health buff; a player gains N health via healPlayer.
 *  - Wegu, the Ancient's threshold rider ("While Wegu has N or more attack,
 *    Negate Defender" — L3: it also gets Breakthrough) is a one-way
 *    approximation: the check runs after each heal-triggered buff and
 *    negateKeyword strips Defender permanently, so if Wegu's attack later
 *    drops below the threshold Defender is not re-applied (the engine has no
 *    un-negate primitive).
 *  - Spiritstone Druid's Spirits use the "spirit-uterra" token, whose scraped
 *    per-level stats (4/3, 6/4, 10/6) already match the text — no
 *    overrideStats needed.
 *  - Tuskin Grovekeeper's "Spawn a 3/3" goes to a random available space
 *    (Spawn convention); the scraped Seedling/Sapling/Treefolk tokens have
 *    "*" stats, so overrideStats.
 *
 * The former engine gaps are closed: "when this is replaced" scripts trigger
 * on wasReplaced (snapshot self; evt carries the NEW creature), "when a
 * friendly creature is replaced" on creatureReplaced, and "when you gain
 * health" on playerHealed (evt.targetPlayer/amount).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, getStats, grantKeyword, healCreature, healPlayer, negateKeyword, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, keywordValue, opposing,
  type CardInstance, type CreatureState, type PlayerId,
} from "../state.js";
import { typeAt, type Faction } from "../types.js";
import type { Game } from "../game.js";
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

function adjacentOpen(game: Game, p: PlayerId, lane: number): number[] {
  const pl = game.state.players[p];
  return [lane - 1, lane + 1].filter((i) => i >= 0 && i < pl.lanes.length && !pl.lanes[i]);
}

function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return (game.state.cards[defId]?.subtypes ?? []).includes(subtype);
}

function hasFactionInHand(game: Game, p: PlayerId, faction: Faction): boolean {
  return game.state.players[p].hand.some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

function isCreatureAt(game: Game, inst: CardInstance): boolean {
  const def = game.state.cards[inst.defId];
  return !!def && typeAt(def, inst.level) === "Creature";
}

// ============================================================
// Creatures
// ============================================================

// --- Kitaru Sprite: "When this is replaced, Spawn a Kitaru Sprite." ---
registerCard({
  defId: "kitaru-sprite",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "replaced-spawn",
        trigger: "wasReplaced" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, "kitaru-sprite", self.level, {});
        },
      }],
    }]),
  ),
});

// --- Shardclaw Crusher: "When Shardclaw Crusher is replaced, the creature
//     that replaced it gets +N/+N." (wasReplaced's evt names the NEW creature) ---
registerCard({
  defId: "shardclaw-crusher",
  levels: Object.fromEntries(
    ([[1, 5], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "replaced-buff",
        trigger: "wasReplaced" as const,
        resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Spiritstone Druid: "When Spiritstone Druid is replaced, put a Spirit
//     into each adjacent available space." (spirit-uterra token — see header) ---
registerCard({
  defId: "spiritstone-druid",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "replaced-spirits",
        trigger: "wasReplaced" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const lane of adjacentOpen(ctx.game, self.owner, self.lane)) {
            spawnCreature(ctx.game, ctx.events, self.owner, "spirit-uterra", self.level, { lane });
          }
        },
      }],
    }]),
  ),
});

// --- Tuskin Grovekeeper: "When you gain health, Spawn a 3/3 Seedling/
//     Sapling/Treefolk." ---
registerCard({
  defId: "tuskin-grovekeeper",
  levels: Object.fromEntries(
    ([[1, "seedling"], [2, "sapling"], [3, "treefolk"]] as const).map(([lvl, token]) => [lvl, {
      abilities: [{
        id: "heal-sprout",
        trigger: "playerHealed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.targetPlayer === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          spawnCreature(ctx.game, ctx.events, self.owner, token, 1,
            { overrideStats: { attack: 3, health: 3 } });
        },
      }],
    }]),
  ),
});

// --- Wegu, the Ancient: "When you gain health, Wegu gets +N/+N for each
//     health you gained"; at the attack threshold, Negate Defender (L3: it
//     also gets Breakthrough) — one-way approximation, see header. ---
registerCard({
  defId: "wegu-the-ancient",
  levels: Object.fromEntries(
    ([[1, 1, 10], [2, 2, 25], [3, 4, 100]] as const).map(([lvl, per, gate]) => [lvl, {
      abilities: [{
        id: "heal-grow",
        trigger: "playerHealed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.targetPlayer === self.owner,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const gained = evt.amount ?? 0;
          if (gained > 0) buffCreature(ctx.game, ctx.events, self, per * gained, per * gained);
          if (getStats(ctx.game, self).attack >= gate) {
            if (lvl === 3 && !hasKeyword(self, "Breakthrough")) {
              grantKeyword(ctx.events, self, { keyword: "Breakthrough", value: 0 });
            }
            if (hasKeyword(self, "Defender")) negateKeyword(ctx.events, self, "Defender");
          }
        },
      }],
    }]),
  ),
});

// --- Bron, Wild Tamer (Set 4.2; Upgrade a Dinosaur: replace Bron with a
//     same-level Dino Knight; battle damage to a player heals each other
//     friendly creature — the Knight's own script is out of scope, see header) ---
registerCard({
  defId: "bron-wild-tamer",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 7]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "upgrade-knight",
          trigger: "enterReplace" as const,
          condition: (game: Game, _s: CreatureState, evt: TriggerPayload) =>
            evt.sourceDefId !== undefined && hasSubtype(game, evt.sourceDefId, "Dinosaur"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            spawnCreature(ctx.game, ctx.events, self.owner, "dino-knight", self.level,
              { lane: self.lane, replace: true });
          },
        },
        {
          id: "heal-pack",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            for (const c of ctx.game.state.players[self.owner].lanes) {
              if (c && c.uid !== self.uid) healCreature(ctx.game, ctx.events, c, n);
            }
          },
        },
      ],
    }]),
  ),
});

// --- Gemhide Ravager (Set 4.2; battle damage to a player gains you that much
//     health; Allied Tempys: Mobility N) ---
registerCard({
  defId: "gemhide-ravager",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "lifetap",
          trigger: "battleDamageToPlayer" as const,
          resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
            healPlayer(ctx.game, ctx.events, self.owner, evt.amount ?? 0);
          },
        },
        {
          id: "allied-mobility",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Tempys"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            grantKeyword(ctx.events, self, { keyword: "Mobility", value: lvl });
          },
        },
      ],
    }]),
  ),
});

// --- Nova, Grove Queen (Set 4.1, four levels; Forge: 1/1 Seedlings into one
//     adjacent / each adjacent / each available space; "when a friendly
//     creature is replaced" Nova gets +N/+N — L4: each friendly creature) ---
registerCard({
  defId: "nova-grove-queen",
  levels: Object.fromEntries(
    ([[1, "one", 1], [2, "adjacent", 3], [3, "all", 5], [4, "all", 10]] as const).map(([lvl, mode, n]) => [lvl, {
      abilities: [
        {
          id: "forge-seedlings",
          trigger: "enterFromHand" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const adjacent = adjacentOpen(ctx.game, self.owner, self.lane);
            const lanes = mode === "all"
              ? openLanes(ctx.game, self.owner)
              : mode === "adjacent"
                ? adjacent
                : adjacent.length ? [ctx.rng.pick(adjacent)] : [];
            for (const lane of lanes) {
              spawnCreature(ctx.game, ctx.events, self.owner, "seedling", 1,
                { lane, overrideStats: { attack: 1, health: 1 } });
            }
          },
        },
        {
          id: "replaced-rally",
          trigger: "creatureReplaced" as const,
          condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner,
          resolve: (ctx: Ctx, self: CreatureState) => {
            if (lvl === 4) {
              for (const c of ctx.game.state.players[self.owner].lanes) {
                if (c) buffCreature(ctx.game, ctx.events, c, n, n);
              }
            } else {
              buffCreature(ctx.game, ctx.events, self, n, n);
            }
          },
        },
      ],
    }]),
  ),
});

// --- Roaming Warclaw (Forge: you may put a 1/1 Raptor into another space) ---
registerCard({
  defId: "roaming-warclaw",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-raptor",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          openLanes(game, self.owner).length
            ? { kind: "yesNo" as const, prompt: "Put a 1/1 Raptor into another space?", optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // its own lane is occupied, so any open space is "another space"
          if (openLanes(ctx.game, self.owner).length) {
            spawnCreature(ctx.game, ctx.events, self.owner, "raptor", 1, { lane: "random" });
          }
        },
      }],
    }]),
  ),
});

// --- Soothsayer Hermit (Forge: you may put a level-<=cap creature from your
//     discard pile into your hand) ---
registerCard({
  defId: "soothsayer-hermit",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-recover",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].discard
            .map((inst, i) => (inst.level <= cap && isCreatureAt(game, inst)) ? i : -1)
            .filter((i) => i >= 0);
          return req(
            cap === 1
              ? "You may put a level 1 creature from your discard pile into your hand"
              : `You may put a level ${cap} or lower creature from your discard pile into your hand`,
            "cardInDiscard",
            options,
            true,
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const pl = ctx.game.state.players[self.owner];
          const inst = pl.discard[choice.handIndex];
          if (!inst || inst.level > cap || !isCreatureAt(ctx.game, inst)) return;
          pl.discard.splice(choice.handIndex, 1);
          pl.hand.push(inst);
        },
      }],
    }]),
  ),
});

// --- Stag of Lys (at the end of your turn, you gain N health) ---
registerCard({
  defId: "stag-of-lys",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "end-heal",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, n);
        },
      }],
    }]),
  ),
});

// --- Venomdrinker (Forge: +X/+X, X = total Poison on enemy creatures) ---
registerCard({
  defId: "venomdrinker",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-drink",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          let x = 0;
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) x += keywordValue(c, "Poison");
          }
          if (x > 0) buffCreature(ctx.game, ctx.events, self, x, x);
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells (+ Lash of Demara: spell at L1/L2, creature at L3 via typeAt)
// ============================================================

// --- Lash of Demara (L1/L2: each enemy creature gets Poison N; L3: 14/20
//     with Forge Poison 6 and Activate: give a Poisoned enemy Defender) ---
registerCard({
  defId: "lash-of-demara",
  spell: Object.fromEntries(
    ([[1, 3], [2, 4]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[opposing(player)].lanes) {
          if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        }
      },
    }]),
  ),
  levels: {
    3: {
      abilities: [{
        id: "forge-poison",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[opposing(self.owner)].lanes) {
            if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: 6 });
          }
        },
      }],
      activates: [{
        id: "poison-shackle",
        condition: (game: Game, self: CreatureState) =>
          enemyUids(game, self.owner, (c) => keywordValue(c, "Poison") > 0).length > 0,
        prompt: (game: Game, self: CreatureState) => req(
          "Give an enemy creature with Poison Defender",
          "enemyCreature",
          enemyUids(game, self.owner, (c) => keywordValue(c, "Poison") > 0),
        ),
        resolve: (ctx: Ctx, _s: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && keywordValue(c, "Poison") > 0) {
            grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
          }
        },
      }],
    },
  },
});

// --- Lysian Rain (give a creature or player +N health — see header note) ---
registerCard({
  defId: "lysian-rain",
  spell: Object.fromEntries(
    ([[1, 7], [2, 9], [3, 11]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => ({
        kind: "anyCreatureOrPlayer" as const,
        prompt: `Give a creature or player +${n} health`,
        options: [-1, -2, ...boardUids(game)],
      }),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const t = choice?.targetUid;
        if (t === undefined) return;
        if (t === -1) { healPlayer(ctx.game, ctx.events, 0, n); return; }
        if (t === -2) { healPlayer(ctx.game, ctx.events, 1, n); return; }
        const c = findCreature(ctx.game.state, t);
        if (c) buffCreature(ctx.game, ctx.events, c, 0, n);
      },
    }]),
  ),
});

// --- Venomstrike (a creature gets Poison N; unrestricted extra play — see header) ---
registerCard({
  defId: "venomstrike",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Give a creature Poison ${n}`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        // "additional Venomstrike" gate cannot be enforced (see header)
        ctx.game.state.playsLeft += 1;
      },
    }]),
  ),
});

// --- Verdant Charge (Set 4.1; each friendly creature gets +N/+N and Regenerate N) ---
registerCard({
  defId: "verdant-charge",
  spell: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (!c) continue;
          buffCreature(ctx.game, ctx.events, c, n, n);
          grantKeyword(ctx.events, c, { keyword: "Regenerate", value: n });
        }
      },
    }]),
  ),
});

// --- Whispers of Dendris (X = your Rank; each friendly creature gets +X/+X) ---
registerCard({
  defId: "whispers-of-dendris",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const x = ctx.game.state.players[player].rank;
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) buffCreature(ctx.game, ctx.events, c, x, x);
        }
      },
    },
  },
});
