/**
 * Set 6 (Darkforge Uprising) + 6.1 + 6.2 — Tempys card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set5-tempys.ts / set6-nekrium.ts):
 *  - Darkstone Asir: the scraped text "Deal N damage to target an enemy
 *    creature for each friendly Darkforged" is read as one target taking
 *    N × (friendly Darkforged count) damage — the "for each" multiplies the
 *    single packet (Darkshard Witch's "gain N health for each friendly
 *    Darkforged" convention). The count includes the Asir itself.
 *  - Arc Wurm: "When a friendly creature moves" includes the Wurm itself
 *    (Frostfang Maiden precedent, set3-tempys.ts): friendlyCreatureMoved skips
 *    the mover, so a "moved" trigger covers self-moves.
 *  - Kadrasian Stoneback: "Flank: Negate Defender from Kadrasian Stoneback
 *    this turn" reuses the Uranti Icemage model (set2-tempys.ts): a permanent
 *    negateKeyword plus the granted tempys:set2-defender-restore ability that
 *    hands Defender back at turn end.
 *  - Pyre Mystic: healPlayer broadcasts playerHealed board-wide with
 *    evt.targetPlayer/amount; the Mystic only reacts to the enemy player's
 *    heals and deals 1x/2x/3x the healed amount back as damage.
 *  - Ignir, Khan of Ashur is a 4-level Forgeborn. L1/L2 pick at random among
 *    the enemy creatures and the enemy player (Primordial Invoker convention);
 *    L3 hits a random enemy creature (if any) AND the enemy player; L4 hits
 *    every enemy creature and the enemy player.
 *  - Valifrax, Iztek's Champion: the Flank puts a same-level Iztek's Frost
 *    (opposing creature present) or Iztek's Flame (none) into hand. Both are
 *    Set 3 cards already scripted in set3-tempys.ts (izteks-frost /
 *    izteks-flame); their data must be loaded to play them.
 *  - Trial by Combat: two-step choice chain (friendly creature, then enemy
 *    creature). The mutual damage uses current attacks (getStats) at fight
 *    time — including the +N temp buff and static auras — and is non-battle
 *    spell damage dealt simultaneously (both attacks captured first).
 *  - Ice Grasp: UNIMPLEMENTED. "You get, 'When you play a Tempys spell, deal
 *    2 damage to the enemy player.'" grants the PLAYER an ongoing aura; the
 *    engine has no player-level ability/static hook (same gap as Infernal
 *    Ritual in set6-nekrium.ts / Nexus Bubble in set6-alloyin.ts). Registered
 *    so the defId resolves; playing it is a no-op (Overload still sends it to
 *    removed). TODO.
 *  - Cryophoenix (Set 6.2) is scripted below as a support card for Phoenix
 *    Call (ice-torrent / spirit-torrent convention; it can also be played from
 *    hand normally). Its enterPlay/moved damage uses its current attack.
 *    Phoenix Call has no prompt, so it resolves outside a batch and the
 *    spawn's enterPlay trigger would be dropped (the Xerxes/Marty McGear
 *    engine gap). The on-entry burn is the card's primary effect, so Phoenix
 *    Call applies it directly via the shared cryophoenixDive() helper;
 *    secondary triggers off that damage are still dropped, and any other
 *    creature's "when a creature enters play" watchers do not see the spawn
 *    (same gap as Remembrance/Dragonwake spawns).
 *  - Subtype matching: the scraper stores combined subtype strings
 *    ("Darkforged Asir"), so Darkforged membership is a word match
 *    (set6-alloyin.ts convention).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, dealPlayerDamage, getStats, grantKeyword, negateKeyword,
  spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, opposing,
  type CreatureState, type PlayerId,
} from "../state.js";
import type { Game } from "../game.js";
import type {
  ChoiceAnswer, ChoiceRequest, Ctx, LevelScript, TriggerPayload,
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

/** Word-match against combined subtype strings ("Darkforged Asir" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

function isDarkforged(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Darkforged");
}

/** Enemy creature in the same lane. */
function opposingCreature(game: Game, self: CreatureState): CreatureState | null {
  return game.state.players[opposing(self.owner)].lanes[self.lane] ?? null;
}

// ============================================================
// Creatures
// ============================================================

// --- Aethertap Shaman (when you play a spell, it gets Mobility 1 this turn) ---
registerCard({
  defId: "aethertap-shaman",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "spellweave-mobility",
        trigger: "spellPlayed" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Mobility", value: 1 }, true);
        },
      }],
    }]),
  ),
});

// --- Arc Wurm (when a friendly creature moves — itself included, see header —
//     deal N damage to the enemy player; Mobility 1 is inherent) ---
registerCard({
  defId: "arc-wurm",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "arc-self",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
          },
        },
        {
          id: "arc-other",
          trigger: "friendlyCreatureMoved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), n, self);
          },
        },
      ],
    }]),
  ),
});

// --- Darkstone Asir (Forge: target enemy creature takes N per friendly
//     Darkforged, itself included — see header) ---
registerCard({
  defId: "darkstone-asir",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-darkstone",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const count = friendlyUids(game, self.owner, (c) => isDarkforged(game, c.defId)).length;
          return req(
            `Deal ${n} damage to an enemy creature for each friendly Darkforged (${count})`,
            "enemyCreature",
            enemyUids(game, self.owner),
          );
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner === self.owner) return;
          const count = friendlyUids(ctx.game, self.owner, (x) => isDarkforged(ctx.game, x.defId)).length;
          dealCreatureDamage(ctx.game, ctx.events, c, n * count, self);
        },
      }],
    }]),
  ),
});

// --- Frostspeaker Shaman (Defender inherent; Activate: N damage to a creature
//     or player) ---
registerCard({
  defId: "frostspeaker-shaman",
  levels: Object.fromEntries(
    ([[1, 2], [2, 4], [3, 8]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "frostbolt",
        prompt: (game: Game) => ({
          kind: "anyCreatureOrPlayer" as const,
          prompt: `Deal ${n} damage to a creature or player`,
          options: [-1, -2, ...boardUids(game)],
        }),
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const t = choice?.targetUid;
          if (t === undefined) return;
          if (t === -1 || t === -2) {
            dealPlayerDamage(ctx.game, ctx.events, (t === -1 ? 0 : 1) as PlayerId, n, self);
          } else {
            const c = findCreature(ctx.game.state, t);
            if (c) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
          }
        },
      }],
    }]),
  ),
});

// --- Ignir, Khan of Ashur (4-level Forgeborn; end of your turn burn —
//     per-level patterns, see header) ---
function ignirBurn(n: number, mode: "randomOrPlayer" | "randomAndPlayer" | "all"): LevelScript {
  return {
    abilities: [{
      id: "end-burn",
      trigger: "turnEnd" as const,
      condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
      resolve: (ctx: Ctx, self: CreatureState) => {
        const foe = opposing(self.owner);
        const enemies = ctx.game.state.players[foe].lanes.filter((c): c is CreatureState => !!c);
        if (mode === "all") {
          for (const c of enemies) dealCreatureDamage(ctx.game, ctx.events, c, n, self);
          dealPlayerDamage(ctx.game, ctx.events, foe, n, self);
        } else if (mode === "randomAndPlayer") {
          if (enemies.length) dealCreatureDamage(ctx.game, ctx.events, ctx.rng.pick(enemies), n, self);
          dealPlayerDamage(ctx.game, ctx.events, foe, n, self);
        } else {
          const t = ctx.rng.pick([...enemies, null] as (CreatureState | null)[]);
          if (t) dealCreatureDamage(ctx.game, ctx.events, t, n, self);
          else dealPlayerDamage(ctx.game, ctx.events, foe, n, self);
        }
      },
    }],
  };
}
registerCard({
  defId: "ignir-khan-of-ashur",
  levels: {
    1: ignirBurn(4, "randomOrPlayer"),
    2: ignirBurn(8, "randomOrPlayer"),
    3: ignirBurn(14, "randomAndPlayer"),
    4: ignirBurn(24, "all"),
  },
});

// --- Kadrasian Stoneback (Defender + Mobility 1 inherent; Flank: Negate
//     Defender from it this turn — Uranti Icemage model, see header) ---
registerCard({
  defId: "kadrasian-stoneback",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "flank-negate-defender",
        trigger: "moved" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          negateKeyword(ctx.events, self, "Defender");
          if (!self.grantedAbilities.includes("tempys:set2-defender-restore")) {
            self.grantedAbilities.push("tempys:set2-defender-restore");
          }
        },
      }],
    }]),
  ),
});

// --- Pyre Mystic (when the enemy player gains health, deal 1x/2x/3x that much
//     damage to the enemy player) ---
registerCard({
  defId: "pyre-mystic",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, mult]) => [lvl, {
      abilities: [{
        id: "pyre-backlash",
        trigger: "playerHealed" as const,
        condition: (_g: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.targetPlayer === opposing(self.owner),
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), (evt.amount ?? 0) * mult, self);
        },
      }],
    }]),
  ),
});

// --- Shadowflame Elemental (Aggressive inherent; static aura: each friendly
//     Darkforged gets Aggressive) ---
registerCard({
  defId: "shadowflame-elemental",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      statics: [{
        id: "darkforged-aggressive",
        apply: (game: Game, self: CreatureState, target: CreatureState, out) => {
          if (target.owner === self.owner && isDarkforged(game, target.defId)) {
            out.keywords.push({ keyword: "Aggressive", value: 0 });
          }
        },
      }],
    }]),
  ),
});

// --- Sparkweaver Acolyte (Mobility 1 inherent; when you play a Tempys spell,
//     it gets +N attack this turn) ---
registerCard({
  defId: "sparkweaver-acolyte",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "spellweave-surge",
        trigger: "spellPlayed" as const,
        condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
          evt.sourceOwner === self.owner
          && !!evt.sourceDefId && game.state.cards[evt.sourceDefId]?.faction === "Tempys",
        resolve: (ctx: Ctx, self: CreatureState) => {
          buffCreature(ctx.game, ctx.events, self, n, 0, true);
        },
      }],
    }]),
  ),
});

// --- Umbraskin Yeti (Mobility 1 inherent; when another friendly Darkforged
//     enters play, it gets +N/+N — Shadeclaw Zombie convention) ---
registerCard({
  defId: "umbraskin-yeti",
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

// --- Valifrax, Iztek's Champion (Mobility 1 inherent; Flank: put a same-level
//     Iztek's Frost into your hand if opposed, else Iztek's Flame — see header) ---
registerCard({
  defId: "valifrax-izteks-champion",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [{
        id: "flank-iztek-gift",
        trigger: "moved" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const defId = opposingCreature(ctx.game, self) ? "izteks-frost" : "izteks-flame";
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId, level: self.level, owner: self.owner,
          });
        },
      }],
    }]),
  ),
});

// --- Patron of Kadras (Forge: with 3+ Tempys cards in hand, each friendly
//     creature gets +N attack this turn) ---
registerCard({
  defId: "patron-of-kadras",
  levels: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-kadras-rally",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand
            .filter((inst) => game.state.cards[inst.defId]?.faction === "Tempys")
            .length >= 3,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, n, 0, true);
          }
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells (+ Cryophoenix support card for Phoenix Call — see header)
// ============================================================

// --- Blood Boil (N damage to a creature, plus another N if a creature was
//     destroyed this turn — two separate packets, see header) ---
registerCard({
  defId: "blood-boil",
  spell: Object.fromEntries(
    ([[1, 5], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => req(`Deal ${n} damage to a creature`, "anyCreature", boardUids(game)),
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        dealCreatureDamage(ctx.game, ctx.events, c, n);
        if (ctx.game.state.deathLog.length > 0) { // any creature, either side, this turn
          dealCreatureDamage(ctx.game, ctx.events, c, n);
        }
      },
    }]),
  ),
});

// --- Ice Grasp: UNIMPLEMENTED — player-granted ongoing aura; see header note.
//     Overload is an engine keyword (the card is still removed). ---
registerCard({ defId: "ice-grasp" });

// --- Phoenix Call (Spawn a Cryophoenix at the spell's level; the on-entry
//     burn is applied directly — no-prompt spells drop effect triggers, see
//     header) ---
registerCard({
  defId: "phoenix-call",
  spell: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const c = spawnCreature(ctx.game, ctx.events, player, "cryophoenix", lvl, {});
        if (c) cryophoenixDive(ctx, c); // enterPlay emulation (see header)
      },
    }]),
  ),
});

// --- Trial by Combat (friendly creature gets +N attack this turn, then it and
//     an enemy creature deal damage equal to their attacks to each other —
//     two-step chain, see header) ---
registerCard({
  defId: "trial-by-combat",
  spell: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => req(
        `Give a friendly creature +${n} attack this turn`,
        "friendlyCreature",
        friendlyUids(game, player),
      ),
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        // priorAnswers includes the current answer: 1 = buff step, 2 = fight step.
        if (ctx.priorAnswers.length >= 2) {
          const firstUid = ctx.priorAnswers[0]?.targetUid;
          const friendly = firstUid !== undefined ? findCreature(ctx.game.state, firstUid) : null;
          const enemy = targetOf(ctx, choice);
          if (!friendly || friendly.owner !== player || !enemy || enemy.owner === player) return;
          const fAtk = getStats(ctx.game, friendly).attack;
          const eAtk = getStats(ctx.game, enemy).attack;
          dealCreatureDamage(ctx.game, ctx.events, enemy, fAtk, friendly);
          dealCreatureDamage(ctx.game, ctx.events, friendly, eAtk, enemy);
          return;
        }
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        buffCreature(ctx.game, ctx.events, c, n, 0, true);
        return req(
          "Choose an enemy creature: the two deal damage equal to their attacks to each other",
          "enemyCreature",
          enemyUids(ctx.game, player),
        ) ?? undefined;
      },
    }]),
  ),
});

// ============================================================
// Support cards
// ============================================================

// --- Cryophoenix (Phoenix Call's spawn target — see header): when it enters
//     play or moves, deal damage equal to its attack to the opposing creature,
//     else to the enemy player. L3 Mobility 1 is inherent from the data. ---
function cryophoenixDive(ctx: Ctx, self: CreatureState): void {
  const atk = getStats(ctx.game, self).attack;
  const foe = opposingCreature(ctx.game, self);
  if (foe) dealCreatureDamage(ctx.game, ctx.events, foe, atk, self);
  else dealPlayerDamage(ctx.game, ctx.events, opposing(self.owner), atk, self);
}
registerCard({
  defId: "cryophoenix",
  levels: Object.fromEntries(
    ([1, 2, 3] as const).map((lvl) => [lvl, {
      abilities: [
        {
          id: "frost-dive-enter",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => cryophoenixDive(ctx, self),
        },
        {
          id: "frost-dive-move",
          trigger: "moved" as const,
          resolve: (ctx: Ctx, self: CreatureState) => cryophoenixDive(ctx, self),
        },
      ],
    }]),
  ),
});
