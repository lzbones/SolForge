/**
 * Set 7 (Raiders Unchained) + 7.1 + 7.2 + 7.3 — Alloyin card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set6-alloyin.ts):
 *  - Formation (new Set 7 keyword): both adjacent spaces on the creature's own
 *    side hold friendly creatures; implemented as enterFromHand + condition
 *    per CARD_SCRIPTING.md. Armory Outpost applies the same check to its
 *    target ("if it is in Formation").
 *  - Ironbeard, Ascendant and Frontline Combatant: their inherent Armor is
 *    written "{{armor|N}}" (lowercase) in the scraped text, which
 *    extractKeywords() does NOT match (KW_SET is case-sensitive), so the card
 *    data carries no Armor keyword. The scripts grant the printed Armor via an
 *    enterPlay fix-up ability ("inherent-armor"). TODO: make extractKeywords
 *    case-insensitive (or normalize in the scraper) and drop the fix-up.
 *  - Ironbeard: Solbind adds one Anvilbreaker (scripted below); the growth
 *    trigger listens to spellPlayed with sourceDefId "anvilbreaker".
 *  - Guardians Assemble: "Forge Guardian" is matched by card-name prefix — the
 *    scraped subtypes are "Robot Guardian" (there is no "Forge Guardian"
 *    subtype in the data). "Search your deck for a Forge Guardian" (L2/L3) is
 *    a random pick from the matching deck cards (Dragonwake/Marty McGear
 *    convention — there is no deck-search choice kind); the original stays in
 *    the deck and the copy is Spawned at the deck card's level. TODO: add a
 *    cardInDeck choice kind so L2/L3 can be a real search. Center space =
 *    lane 2; the Spawn fizzles if it is occupied.
 *  - Stasis Indexer: "Defender until the end of the enemy player's next turn"
 *    — engine temp keywords are wiped at the end of the CURRENT turn, so the
 *    grant is permanent plus a granted turnEnd ability keyed by the Indexer's
 *    controller (alloyin:stasis-expire-0/1) that removes it at the end of the
 *    opponent's turn (H.E.R.M.E.S convention, set6-alloyin.ts). Corner: the
 *    removal uses negateKeyword, so a target with inherent Defender loses it
 *    too.
 *  - Metadata Redactor / Repress: "remove all abilities" = silence + strip all
 *    keywords (inherent/granted/temp) and granted ability refs (Wipe Clean
 *    convention). Static auras stop too: computeStatics skips silenced
 *    providers.
 *  - Specimen 001: reads non-battle off the damaged payload's battle flag
 *    (added after set6 was written — Alyssa's header note in set6-alloyin.ts
 *    predates it). Armor-absorbed hits don't count: `damaged` only fires when
 *    damage gets through (Forgewatch Sentry convention).
 *  - Voltaic Prophet L3: "Level up each card in your hand" — the originals
 *    stay in hand, the leveled copies go to the discard pile (Delpha
 *    levelUpHandCopy convention, set2-alloyin.ts).
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, dealCreatureDamage, getStats, grantKeyword, moveCreature, negateKeyword, spawnCreature,
} from "../effects.js";
import {
  allCreatures, findCreature, hasKeyword, keywordValue, opposing,
  type CardInstance, type CreatureState, type PlayerId,
} from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { ChoiceAnswer, Ctx, TriggerPayload } from "../triggers.js";

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
  return friendlyUids(game, opposing(p));
}

/** Word-match against combined subtype strings ("Robot Guardian" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

/** Formation: both spaces adjacent to `lane` on p's own side are occupied. */
function inFormation(game: Game, p: PlayerId, lane: number): boolean {
  const pl = game.state.players[p];
  return lane > 0 && lane < pl.lanes.length - 1 && !!pl.lanes[lane - 1] && !!pl.lanes[lane + 1];
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

/** "Discard and level up a card" — same shape as discardAndLevel in set6-alloyin.ts. */
function discardAndLevel(ctx: Ctx, player: PlayerId, handIndex: number): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  pl.hand.splice(handIndex, 1);
  pl.discard.push(inst);
  ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  levelUpCopy(ctx, player, inst);
}

/** Shared "you may discard and level up a card" prompt/resolve (Shadowsmith). */
function recyclePrompt(game: Game, self: CreatureState) {
  const hand = game.state.players[self.owner].hand;
  if (!hand.length) return null;
  return {
    kind: "cardInHand" as const,
    prompt: "You may discard and level up a card",
    options: hand.map((_, i) => i),
    optional: true,
  };
}

function recycleResolve(ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null): void {
  if (choice?.handIndex === undefined) return;
  discardAndLevel(ctx, self.owner, choice.handIndex);
}

// ---------- granted abilities ----------

// Stasis Indexer: the granted Defender expires at the end of the controller's
// opponent's turn ("until the end of the enemy player's next turn" — see
// header). The controller is encoded in the ref because the target is usually
// an ENEMY creature (its owner's turn end is the wrong clock for corner cases
// where a friendly creature is targeted).
for (const p of [0, 1] as const) {
  registerGranted(`alloyin:stasis-expire-${p}`, {
    id: `alloyin:stasis-expire-${p}`,
    trigger: "turnEnd",
    condition: (game) => game.state.active !== p,
    resolve(ctx, self) {
      negateKeyword(ctx.events, self, "Defender"); // inherent-Defender corner: see header
      self.grantedAbilities = self.grantedAbilities.filter((r) => r !== `alloyin:stasis-expire-${p}`);
    },
  });
}

// ============================================================
// Creatures
// ============================================================

// --- Automaton Prime (Formation: gets Armor N) ---
registerCard({
  defId: "automaton-prime",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "formation-armor",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Bulwark Battalion (another friendly creature enters: it gets Armor N this turn) ---
registerCard({
  defId: "bulwark-battalion",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 8]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "welcome-armor",
        trigger: "anyCreatureEnterPlay" as const,
        // the broadcast already excludes Bulwark Battalion's own entry ("another")
        condition: (_game: Game, self: CreatureState, evt: TriggerPayload) => evt.sourceOwner === self.owner,
        resolve: (ctx: Ctx, _s: CreatureState, evt: TriggerPayload) => {
          const c = evt.sourceUid !== undefined ? findCreature(ctx.game.state, evt.sourceUid) : null;
          if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: armor }, true); // until end of turn
        },
      }],
    }]),
  ),
});

// --- Crux, Metamind Rogue (Forge: Armor N when alone; Upgrade: enemy creature -N attack) ---
registerCard({
  defId: "crux-metamind-rogue",
  levels: Object.fromEntries(
    ([[1, 3, 4], [2, 4, 8], [3, 5, 12]] as const).map(([lvl, armor, debuff]) => [lvl, {
      abilities: [
        {
          id: "lone-guard",
          trigger: "enterFromHand" as const,
          // Forge resolves while Crux is on the board: one friendly creature = itself
          condition: (game: Game, self: CreatureState) => friendlyUids(game, self.owner).length === 1,
          resolve: (ctx: Ctx, self: CreatureState) => {
            grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
          },
        },
        {
          id: "upgrade-debuff",
          trigger: "enterReplace" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => {
            const options = enemyUids(game, self.owner);
            if (!options.length) return null;
            return {
              kind: "enemyCreature" as const,
              prompt: `Give an enemy creature -${debuff} attack`,
              options,
            };
          },
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (c && c.owner !== self.owner) buffCreature(ctx.game, ctx.events, c, -debuff, 0);
          },
        },
      ],
    }]),
  ),
});

// --- Frontline Combatant (Armor N — lowercase in the data, see header; Forge: you may
//     deal damage equal to its Armor to an enemy creature; it deals its attack back) ---
registerCard({
  defId: "frontline-combatant",
  levels: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 12]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [
        {
          // data parse gap: lowercase {{armor|N}} is not extracted (see header)
          id: "inherent-armor",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            grantKeyword(ctx.events, self, { keyword: "Armor", value: armor });
          },
        },
        {
          id: "armor-strike",
          trigger: "enterFromHand" as const,
          targeted: true,
          prompt: (game: Game, self: CreatureState) => {
            const options = enemyUids(game, self.owner);
            if (!options.length) return null;
            return {
              kind: "enemyCreature" as const,
              prompt: "You may have Frontline Combatant deal damage equal to its Armor to an enemy creature (it deals damage equal to its attack back)",
              options,
              optional: true,
            };
          },
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
            const c = targetOf(ctx, choice);
            if (!c || c.owner === self.owner) return;
            dealCreatureDamage(ctx.game, ctx.events, c, keywordValue(self, "Armor"), self);
            // "If you do, that creature deals damage equal to its attack back" — death
            // is only checked at batch end, so a mortally wounded target still hits back
            dealCreatureDamage(ctx.game, ctx.events, self, getStats(ctx.game, c).attack, c);
          },
        },
      ],
    }]),
  ),
});

// --- G.S.F. Commando (Armor N inherent; Forge: +1 Armor per other friendly Metamind;
//     Activate: deal Nx its Armor to an enemy creature) ---
registerCard({
  defId: "gsf-commando",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "metamind-armor",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].lanes
            .filter((c): c is CreatureState =>
              !!c && c.uid !== self.uid && hasSubtype(ctx.game, c.defId, "Metamind"))
            .length;
          if (count > 0) grantKeyword(ctx.events, self, { keyword: "Armor", value: count });
        },
      }],
      activates: [{
        id: "armor-blast",
        prompt: (game: Game, self: CreatureState) => {
          const options = enemyUids(game, self.owner);
          if (!options.length) return null;
          return {
            kind: "enemyCreature" as const,
            prompt: `Deal damage equal to ${lvl}x G.S.F. Commando's Armor to an enemy creature`,
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c || c.owner === self.owner) return;
          dealCreatureDamage(ctx.game, ctx.events, c, keywordValue(self, "Armor") * lvl, self);
        },
      }],
    }]),
  ),
});

// --- Ironbeard, Ascendant (4 levels; Armor N — lowercase in the data, see header;
//     Solbind Anvilbreaker; when you play Anvilbreaker: growth, widening with level) ---
registerCard({
  defId: "ironbeard-ascendant",
  solbind: ["anvilbreaker"],
  levels: Object.fromEntries(
    ([
      [1, 1, 2, 0, "self"],      // Ironbeard gets +2 attack
      [2, 2, 3, 1, "self"],      // Ironbeard gets +3 attack and Armor 1
      [3, 3, 4, 2, "adjacent"],  // Ironbeard and adjacent friendly creatures get +4 attack and Armor 2
      [4, 4, 5, 3, "all"],       // friendly creatures get +5 attack and Armor 3
    ] as const).map(([lvl, baseArmor, atk, arm, scope]) => [lvl, {
      abilities: [
        {
          // data parse gap: lowercase {{armor|N}} is not extracted (see header)
          id: "inherent-armor",
          trigger: "enterPlay" as const,
          resolve: (ctx: Ctx, self: CreatureState) => {
            grantKeyword(ctx.events, self, { keyword: "Armor", value: baseArmor });
          },
        },
        {
          id: "anvilbreaker-rally",
          trigger: "spellPlayed" as const,
          condition: (_game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner && evt.sourceDefId === "anvilbreaker",
          resolve: (ctx: Ctx, self: CreatureState) => {
            const lanes = scope === "all"
              ? [0, 1, 2, 3, 4]
              : scope === "adjacent" ? [self.lane - 1, self.lane, self.lane + 1] : [self.lane];
            for (const lane of lanes) {
              const c = lane >= 0 && lane < 5 ? ctx.game.state.players[self.owner].lanes[lane] : null;
              if (!c) continue;
              buffCreature(ctx.game, ctx.events, c, atk, 0);
              if (arm > 0) grantKeyword(ctx.events, c, { keyword: "Armor", value: arm });
            }
          },
        },
      ],
    }]),
  ),
});

// --- Metadata Redactor (Formation: remove all abilities from each friendly adjacent creature) ---
registerCard({
  defId: "metadata-redactor",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "redact-adjacent",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const lane of [self.lane - 1, self.lane + 1]) {
            const c = ctx.game.state.players[self.owner].lanes[lane];
            if (!c) continue;
            // "remove all abilities" — Wipe Clean convention (see header)
            c.keywords = [];
            c.tempKeywords = [];
            c.grantedAbilities = [];
            c.silenced = true;
          }
        },
      }],
    }]),
  ),
});

// --- Ordnance Captain (Formation: each friendly creature gets +N attack) ---
registerCard({
  defId: "ordnance-captain",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 5]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "formation-rally",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c) buffCreature(ctx.game, ctx.events, c, n, 0); // includes itself ("each friendly")
          }
        },
      }],
    }]),
  ),
});

// --- Specimen 001 (dealt non-battle damage: each OTHER friendly creature gets +N attack
//     and Armor M — the damaged payload carries a battle flag, see header) ---
registerCard({
  defId: "specimen-001",
  levels: Object.fromEntries(
    ([[1, 2, 1], [2, 3, 2], [3, 4, 3]] as const).map(([lvl, atk, armor]) => [lvl, {
      abilities: [{
        id: "nonbattle-rally",
        trigger: "damaged" as const,
        condition: (_game: Game, _self: CreatureState, evt: TriggerPayload) => evt.battle === false,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c || c.uid === self.uid) continue;
            buffCreature(ctx.game, ctx.events, c, atk, 0);
            grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
          }
        },
      }],
    }]),
  ),
});

// --- Stasis Indexer (Forge: a level-gated creature gets Defender until the end of the
//     enemy player's next turn — granted-ability emulation, see header) ---
registerCard({
  defId: "stasis-indexer",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 99]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "stasis-lock",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game) => {
          // L1: exactly level 1; L2: level 2 or lower; L3: any creature
          const options = boardCreatureUids(game, (c) => c.level <= cap);
          if (!options.length) return null;
          return {
            kind: "anyCreature" as const,
            prompt: "Give a creature Defender until the end of the enemy player's next turn",
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
          c.grantedAbilities.push(`alloyin:stasis-expire-${self.owner}`);
        },
      }],
    }]),
  ),
});

// --- Steelspark Tinkerer (Defender inherent; Forge: you may discard and level up a card) ---
registerCard({
  defId: "steelspark-tinkerer",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-recycle",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: recyclePrompt,
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) =>
          recycleResolve(ctx, self, choice),
      }],
    }]),
  ),
});

// --- Tower Cannoneer (static: each friendly Defender gets +N attack) ---
registerCard({
  defId: "tower-cannoneer",
  levels: Object.fromEntries(
    ([[1, 3], [2, 6], [3, 9]] as const).map(([lvl, n]) => [lvl, {
      statics: [{
        id: "defender-rally",
        apply: (_game: Game, self: CreatureState, target: CreatureState, stats: { attack: number; health: number }) => {
          if (target.owner === self.owner && hasKeyword(target, "Defender")) stats.attack += n;
        },
      }],
    }]),
  ),
});

// --- Voltaic Prophet (Formation: L1 recycle one; L2 discard and level up EACH card in
//     hand; L3 level up each card in hand — originals stay, see header) ---
registerCard({
  defId: "voltaic-prophet",
  levels: {
    1: {
      abilities: [{
        id: "formation-recycle",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        prompt: recyclePrompt,
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) =>
          recycleResolve(ctx, self, choice),
      }],
    },
    2: {
      abilities: [{
        id: "formation-recycle-all",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const hand = pl.hand.splice(0);
          for (const inst of hand) {
            pl.discard.push(inst);
            ctx.events.push({ type: "discard", player: self.owner, defId: inst.defId, level: inst.level });
            levelUpCopy(ctx, self.owner, inst);
          }
        },
      }],
    },
    3: {
      abilities: [{
        id: "formation-level-all",
        trigger: "enterFromHand" as const,
        condition: (game: Game, self: CreatureState) => inFormation(game, self.owner, self.lane),
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const inst of [...ctx.game.state.players[self.owner].hand]) {
            levelUpCopy(ctx, self.owner, inst); // the originals stay in hand (see header)
          }
        },
      }],
    },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Anvilbreaker (Free; enemy creature -2 attack, then move it to a random open space) ---
registerCard({
  defId: "anvilbreaker",
  spell: {
    1: {
      prompt: (game: Game, player: PlayerId) => {
        const options = enemyUids(game, player);
        if (!options.length) return null;
        return {
          kind: "enemyCreature" as const,
          prompt: "Give an enemy creature -2 attack, then move it to another available space at random",
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        buffCreature(ctx.game, ctx.events, c, -2, 0);
        const pl = ctx.game.state.players[c.owner];
        const open = pl.lanes.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0); // its own lane is occupied
        if (open.length) moveCreature(ctx.game, ctx.events, c, ctx.rng.pick(open));
      },
    },
  },
});

// --- Armory Outpost (friendly creature +N attack; if it is in Formation, the adjacent
//     creatures get +N attack as well) ---
registerCard({
  defId: "armory-outpost",
  spell: Object.fromEntries(
    ([[1, 4], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = friendlyUids(game, player);
        if (!options.length) return null;
        return {
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature +${n} attack`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        buffCreature(ctx.game, ctx.events, c, n, 0);
        if (inFormation(ctx.game, player, c.lane)) {
          for (const lane of [c.lane - 1, c.lane + 1]) {
            const adj = ctx.game.state.players[player].lanes[lane];
            if (adj) buffCreature(ctx.game, ctx.events, adj, n, 0);
          }
        }
      },
    }]),
  ),
});

// --- Cypien Experimentation (a random friendly creature +N attack; a random friendly
//     creature Armor N — two independent picks, they may be the same creature) ---
registerCard({
  defId: "cypien-experimentation",
  spell: Object.fromEntries(
    ([[1, 5], [2, 6], [3, 10]] as const).map(([lvl, n]) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const mine = ctx.game.state.players[player].lanes.filter((c): c is CreatureState => !!c);
        if (!mine.length) return;
        buffCreature(ctx.game, ctx.events, ctx.rng.pick(mine), n, 0);
        grantKeyword(ctx.events, ctx.rng.pick(mine), { keyword: "Armor", value: n });
      },
    }]),
  ),
});

// --- Defense Spire (Overload inherent; each friendly creature gets Armor 6 this turn) ---
registerCard({
  defId: "defense-spire",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        for (const c of ctx.game.state.players[player].lanes) {
          if (c) grantKeyword(ctx.events, c, { keyword: "Armor", value: 6 }, true); // this turn
        }
      },
    },
  },
});

// --- Guardians Assemble (Spawn a copy of a Forge Guardian from your deck into the center
//     space; L2/L3 "search" is a random pick — see header; L3 Free is inherent) ---
function isForgeGuardian(game: Game, defId: string): boolean {
  // name match: the scraped subtype is "Robot Guardian", there is no "Forge Guardian"
  // subtype in the data (see header)
  return game.state.cards[defId]?.name.startsWith("Forge Guardian") ?? false;
}

registerCard({
  defId: "guardians-assemble",
  spell: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const pool = ctx.game.state.players[player].deck
          .filter((inst) => isForgeGuardian(ctx.game, inst.defId));
        if (!pool.length) return;
        const pick = ctx.rng.pick(pool); // a copy: the original stays in the deck (see header)
        spawnCreature(ctx.game, ctx.events, player, pick.defId, pick.level, { lane: 2 }); // center space
      },
    }]),
  ),
});

// --- Repress (enemy creature -N attack; if it is Uterra, remove all abilities from it) ---
registerCard({
  defId: "repress",
  spell: Object.fromEntries(
    ([[1, 3], [2, 9], [3, 25]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = enemyUids(game, player);
        if (!options.length) return null;
        return {
          kind: "enemyCreature" as const,
          prompt: `Give an enemy creature -${n} attack`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner === player) return;
        buffCreature(ctx.game, ctx.events, c, -n, 0);
        if (ctx.game.state.cards[c.defId]?.faction === "Uterra") {
          // "remove all abilities" — Wipe Clean convention (see header)
          c.keywords = [];
          c.tempKeywords = [];
          c.grantedAbilities = [];
          c.silenced = true;
        }
      },
    }]),
  ),
});
