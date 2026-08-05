/**
 * Set 2 (Rise of the Forgeborn) Uterra card scripts — see docs/CARD_SCRIPTING.md.
 *
 * Runebark Guardian's "when you gain health" trigger is implemented via the
 * engine's playerHealed broadcast (healPlayer collects it with
 * targetPlayer/amount in the payload).
 *
 * Approximation notes (same conventions as set1-uterra.ts):
 *  - Oros, Deepwood's Chosen L4: scraped base stats are 0/0 and its "gets
 *    +attack/+health equal to your health" is modeled as a static — but
 *    computeStatics skips raw-dead providers, so a 0/0 Oros dies at the end
 *    of its entry batch before the static can ever apply (engine gap: death
 *    should consider static-provided health). The static is written anyway
 *    and activates automatically if the engine relaxes that check. The
 *    battle-damage lifegain works at all four levels.
 *  - Umbruk Lasher / Dryad's Boon: Allied-granted and spell-granted triggered
 *    abilities use registerGranted refs (same convention as set1 Heart Tree).
 *  - "Double the Poison" (Dissolve / Venomous Netherscale): keywordValue sums
 *    Poison entries, so granting another Poison equal to the current total
 *    doubles it. Player Poison (players[p].poison) is doubled in place — no
 *    GameEvent covers player-poison changes, so it stays silent (same as
 *    Runescarred Zombie's discard-to-hand).
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, grantKeyword, healCreature, healPlayer, spawnCreature,
} from "../effects.js";
import { findCreature, keywordValue, opposing } from "../state.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, Ctx, StaticOut, TriggerPayload } from "../triggers.js";
import type { CreatureState, PlayerId } from "../state.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function hasSubtype(game: Game, c: CreatureState, sub: string): boolean {
  return game.state.cards[c.defId]?.subtypes.includes(sub) ?? false;
}

function adjacentOpen(game: Game, p: PlayerId, lane: number): number[] {
  const pl = game.state.players[p];
  return [lane - 1, lane + 1].filter((i) => i >= 0 && i < 5 && !pl.lanes[i]);
}

function openLanes(game: Game, p: PlayerId): number[] {
  return game.state.players[p].lanes.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
}

function allCreatureUids(game: Game): number[] {
  const out: number[] = [];
  for (const side of game.state.players) for (const c of side.lanes) if (c) out.push(c.uid);
  return out;
}

function hasFactionInHand(game: Game, p: PlayerId, faction: string): boolean {
  return game.state.players[p].hand
    .some((inst) => game.state.cards[inst.defId]?.faction === faction);
}

/** "Double the Poison": keywordValue sums entries, so grant the current total. */
function doublePoison(ctx: Ctx, c: CreatureState): void {
  const v = keywordValue(c, "Poison");
  if (v > 0) grantKeyword(ctx.events, c, { keyword: "Poison", value: v });
}

// ---------- granted abilities ----------

// Dryad's Boon: "When another friendly creature enters play, this gets +N/+N."
const boonRef = (n: number) => `uterra:dryads-boon-${n}`;
for (const n of [1, 2, 3] as const) {
  registerGranted(boonRef(n), {
    id: boonRef(n),
    trigger: "anyCreatureEnterPlay",
    condition: (_game, self, evt) => evt.sourceOwner === self.owner && evt.sourceUid !== self.uid,
    resolve: (ctx, self) => {
      buffCreature(ctx.game, ctx.events, self, n, n);
    },
  });
}

// Umbruk Lasher (Allied Tempys): "When Umbruk Lasher deals battle damage to a
// player on your turn, you may deal that much damage to an enemy creature."
registerGranted("uterra:umbruk-lasher-strike", {
  id: "uterra:umbruk-lasher-strike",
  trigger: "battleDamageToPlayer",
  targeted: true,
  condition: (game, self) => game.state.active === self.owner,
  prompt: (game, self, evt) => {
    const options = game.state.players[opposing(self.owner)].lanes.filter(Boolean).map((c) => c!.uid);
    return options.length
      ? {
        kind: "enemyCreature" as const,
        prompt: `Deal ${evt.amount ?? 0} damage to an enemy creature?`,
        options,
        optional: true,
      }
      : null;
  },
  resolve: (ctx, self, evt, choice) => {
    const c = targetOf(ctx, choice);
    if (c && evt.amount) dealCreatureDamage(ctx.game, ctx.events, c, evt.amount, self);
  },
});

// ============================================================
// Creatures
// ============================================================

// --- Brambleaxe Warrior: Forge — give a creature Breakthrough this turn. ---
registerCard({
  defId: "brambleaxe-warrior",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-breakthrough",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game) => ({
          kind: "anyCreature" as const,
          prompt: "Give a creature Breakthrough this turn",
          options: allCreatureUids(game),
        }),
        resolve: (ctx: Ctx, _self: CreatureState, _evt: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c) grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 }, true);
        },
      }],
    }]),
  ),
});

// --- Branchweaver Druid: Forge — you may put an N/N Treefolk into another space. ---
registerCard({
  defId: "branchweaver-druid",
  levels: Object.fromEntries(
    ([[1, 5], [2, 7], [3, 14]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-treefolk",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) =>
          openLanes(game, self.owner).length
            ? { kind: "yesNo" as const, prompt: `Put a ${n}/${n} Treefolk into another space?`, optional: true }
            : null,
        resolve: (ctx: Ctx, self: CreatureState) => {
          // its own lane is occupied, so any open lane is "another space"
          const spots = openLanes(ctx.game, self.owner);
          if (spots.length) {
            spawnCreature(ctx.game, ctx.events, self.owner, "treefolk", 1,
              { lane: ctx.rng.pick(spots), overrideStats: { attack: n, health: n } });
          }
        },
      }],
    }]),
  ),
});

// --- Chistlehearth Hunter: Forge — +1 attack for each other friendly creature. ---
registerCard({
  defId: "chistlehearth-hunter",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-hunt",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].lanes
            .filter((c) => !!c && c.uid !== self.uid).length;
          if (count) buffCreature(ctx.game, ctx.events, self, count, 0);
        },
      }],
    }]),
  ),
});

// --- Esperian Wartusk: Allied (Alloyin) — Armor N. ---
registerCard({
  defId: "esperian-wartusk",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "allied-armor",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Alloyin"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Glowhive Siren: Vengeance — you gain X..Y health. ---
registerCard({
  defId: "glowhive-siren",
  levels: Object.fromEntries(
    ([[1, 1, 4], [2, 2, 8], [3, 4, 12]] as const).map(([lvl, lo, hi]) => [lvl, {
      abilities: [{
        id: "vengeance-heal",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healPlayer(ctx.game, ctx.events, self.owner, lo + ctx.rng.int(hi - lo + 1));
        },
      }],
    }]),
  ),
});

// --- Mimicleaf: Activate — put a same-level Mimicleaf into an adjacent space. ---
registerCard({
  defId: "mimicleaf",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      activates: [{
        id: "split",
        // NOTE: no condition (Leafkin Progenitor convention) — with no adjacent
        // open space the activation simply fizzles in resolve.
        resolve: (ctx: Ctx, self: CreatureState) => {
          const spots = adjacentOpen(ctx.game, self.owner, self.lane);
          if (spots.length) {
            spawnCreature(ctx.game, ctx.events, self.owner, "mimicleaf", self.level,
              { lane: ctx.rng.pick(spots) });
          }
        },
      }],
    }]),
  ),
});

// --- Nuada, Faith's Flourish: Activate — replace a friendly Plant with an N/N Treefolk. ---
registerCard({
  defId: "nuada-faiths-flourish",
  levels: Object.fromEntries(
    ([[1, 9], [2, 14], [3, 21]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "bloom",
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && hasSubtype(game, c, "Plant"))
            .map((c) => c.uid);
          return options.length
            ? { kind: "friendlyCreature" as const, prompt: `Replace a friendly Plant with a ${n}/${n} Treefolk`, options }
            : null;
        },
        resolve: (ctx: Ctx, _self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && hasSubtype(ctx.game, c, "Plant")) {
            spawnCreature(ctx.game, ctx.events, c.owner, "treefolk", 1,
              { lane: c.lane, replace: true, overrideStats: { attack: n, health: n } });
          }
        },
      }],
    }]),
  ),
});

// --- Oros, Deepwood's Chosen: battle damage to a player -> gain that much
//     health. L4 also has the (currently inert) health-bound static — see header. ---
registerCard({
  defId: "oros-deepwoods-chosen",
  levels: Object.fromEntries(
    ([1, 2, 3, 4] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "lifelink",
        trigger: "battleDamageToPlayer" as const,
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          if (evt.amount) healPlayer(ctx.game, ctx.events, self.owner, evt.amount);
        },
      }],
      statics: lvl === 4
        ? [{
          id: "health-bound",
          apply: (game: Game, self: CreatureState, target: CreatureState, stats: StaticOut) => {
            if (target.uid !== self.uid) return;
            stats.attack += game.state.players[self.owner].health;
            stats.health += game.state.players[self.owner].health;
          },
        }]
        : [],
    }]),
  ),
});

// --- Poisoncoil: Activate — give another creature Poison N. ---
registerCard({
  defId: "poisoncoil",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "venom",
        prompt: (game: Game, self: CreatureState) => {
          const options = allCreatureUids(game).filter((u) => u !== self.uid);
          return options.length
            ? { kind: "anyCreature" as const, prompt: `Give another creature Poison ${n}`, options }
            : null;
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (c && c.uid !== self.uid) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
        },
      }],
    }]),
  ),
});

// --- Runebark Guardian: "When you gain health, Runebark Guardian gets +N/+N"
//     (flat per heal event, not per point of health). ---
registerCard({
  defId: "runebark-guardian",
  levels: Object.fromEntries(
    ([[1, 1], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "heal-grow",
        trigger: "playerHealed" as const,
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.targetPlayer === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Solstice Reveler: when you gain a Rank, each friendly creature gets
//     +N/+N (L3: and Breakthrough). ---
registerCard({
  defId: "solstice-reveler",
  levels: Object.fromEntries(
    ([[1, 2, false], [2, 4, false], [3, 8, true]] as const).map(([lvl, n, bt]) => [lvl, {
      abilities: [{
        id: "rank-rally",
        trigger: "rankGained" as const,
        // rankGained fires during endTurn, before `active` flips.
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c) continue;
            buffCreature(ctx.game, ctx.events, c, n, n);
            if (bt) grantKeyword(ctx.events, c, { keyword: "Breakthrough", value: 0 });
          }
        },
      }],
    }]),
  ),
});

// --- Stouthide Stegadon: when you gain a Rank, heal N damage from itself. ---
registerCard({
  defId: "stouthide-stegadon",
  levels: Object.fromEntries(
    ([[1, 10], [2, 20], [3, 30]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rank-heal",
        trigger: "rankGained" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          healCreature(ctx.game, ctx.events, self, n);
        },
      }],
    }]),
  ),
});

// --- Umbruk Lasher: Allied (Tempys) — gains the battle-damage strike ability. ---
registerCard({
  defId: "umbruk-lasher",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "allied-strike",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => hasFactionInHand(game, self.owner, "Tempys"),
        resolve: (ctx: Ctx, self: CreatureState) => {
          self.grantedAbilities.push("uterra:umbruk-lasher-strike");
        },
      }],
    }]),
  ),
});

// --- Uterradon Mauler: Forge — if opposed, gets +N/+N. ---
registerCard({
  defId: "uterradon-mauler",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-opposed",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) =>
          !!game.state.players[opposing(self.owner)].lanes[self.lane],
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, n);
        },
      }],
    }]),
  ),
});

// --- Uterradon Rex: when another friendly Dinosaur enters play, it gets +N/+N. ---
registerCard({
  defId: "uterradon-rex",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "rally-dinosaur",
        trigger: "anyCreatureEnterPlay" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner && evt.sourceUid !== self.uid
          && !!evt.sourceDefId && (game.state.cards[evt.sourceDefId]?.subtypes ?? []).includes("Dinosaur"),
        resolve: (ctx: Ctx, _self: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) buffCreature(ctx.game, ctx.events, c, n, n);
        },
      }],
    }]),
  ),
});

// --- Venomous Netherscale: Forge — double the Poison on each enemy creature
//     (L3: and on the enemy player). ---
registerCard({
  defId: "venomous-netherscale",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "forge-venom",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const foe = ctx.game.state.players[opposing(self.owner)];
          for (const c of foe.lanes) if (c) doublePoison(ctx, c);
          if (lvl === 3) foe.poison *= 2; // silent: no GameEvent for player poison
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Dissolve: double the Poison on an enemy creature (L2/L3: all enemy
//     creatures; L3 is Free — engine keyword). ---
registerCard({
  defId: "dissolve",
  spell: {
    1: {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[opposing(player)].lanes.filter(Boolean).map((c) => c!.uid);
        return options.length
          ? { kind: "enemyCreature" as const, prompt: "Double the Poison on an enemy creature", options }
          : null;
      },
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) doublePoison(ctx, c);
      },
    },
    ...Object.fromEntries(
      ([2, 3] as const).map((lvl) => [lvl, {
        resolve: (ctx: Ctx, player: PlayerId) => {
          for (const c of ctx.game.state.players[opposing(player)].lanes) {
            if (c) doublePoison(ctx, c);
          }
        },
      }]),
    ),
  },
});

// --- Dryad's Boon: give a creature +N/+N and "when another friendly creature
//     enters play, this gets +N/+N" (granted ability). ---
registerCard({
  defId: "dryads-boon",
  spell: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = allCreatureUids(game);
        return options.length
          ? {
            kind: "anyCreature" as const,
            prompt: `Give a creature +${n} attack, +${n} health, and a friendly-entry growth ability`,
            options,
          }
          : null;
      },
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, n, n);
        c.grantedAbilities.push(boonRef(n));
      },
    }]),
  ),
});

// --- Mending Spring: you gain 1..N health. ---
registerCard({
  defId: "mending-spring",
  spell: Object.fromEntries(
    ([[1, 10], [2, 20], [3, 40]] as const).map(([lvl, cap]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        healPlayer(ctx.game, ctx.events, player, 1 + ctx.rng.int(cap));
      },
    }]),
  ),
});

// --- Spore Torrent: give a creature Poison N (L2/L3 are Free — engine keyword). ---
registerCard({
  defId: "spore-torrent",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = allCreatureUids(game);
        return options.length
          ? { kind: "anyCreature" as const, prompt: `Give a creature Poison ${n}`, options }
          : null;
      },
      resolve: (ctx: Ctx, _player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) grantKeyword(ctx.events, c, { keyword: "Poison", value: n });
      },
    }]),
  ),
});

// --- Twinstrength: two friendly creatures get +N/+N (two-step choice chain). ---
registerCard({
  defId: "twinstrength",
  spell: Object.fromEntries(
    ([[1, 3], [2, 4], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes.filter(Boolean).map((c) => c!.uid);
        return options.length
          ? { kind: "friendlyCreature" as const, prompt: `Give a friendly creature +${n} attack and +${n} health`, options }
          : null;
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c && c.owner === player) buffCreature(ctx.game, ctx.events, c, n, n);
        if (ctx.priorAnswers.length >= 2) return; // both picks done
        const rest = ctx.game.state.players[player].lanes
          .filter((x): x is CreatureState => !!x && x.uid !== c?.uid)
          .map((x) => x.uid);
        if (!rest.length) return; // only one friendly creature: buffed once
        return {
          kind: "friendlyCreature" as const,
          prompt: `Give a second friendly creature +${n} attack and +${n} health`,
          options: rest,
        };
      },
    }]),
  ),
});

// --- Verdant Grace: heal N damage from a friendly creature and M from each
//     other friendly creature. ---
registerCard({
  defId: "verdant-grace",
  spell: Object.fromEntries(
    ([[1, 10, 2], [2, 15, 4], [3, 20, 6]] as const).map(([lvl, main, other]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = game.state.players[player].lanes.filter(Boolean).map((c) => c!.uid);
        return options.length
          ? { kind: "friendlyCreature" as const, prompt: `Heal ${main} damage from a friendly creature`, options }
          : null;
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        healCreature(ctx.game, ctx.events, c, main);
        for (const x of ctx.game.state.players[player].lanes) {
          if (x && x.uid !== c.uid) healCreature(ctx.game, ctx.events, x, other);
        }
      },
    }]),
  ),
});
