/**
 * Set 5 (Reign of Varna) + 5.1 + 5.2 — Alloyin card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set4-alloyin.ts):
 *  - Barrier Soldier: the scraped text has no "{{Forge}}:" prefix ("You get
 *    Armor 5."); like every one-shot on-play creature effect it is mapped to
 *    enterFromHand. Player Armor is a non-refreshing pool in the engine
 *    (pl.armor is consumed by damage and never reset); the wiki rules say
 *    player Armor should prevent the first X damage EACH turn — engine gap.
 *  - Batterbot: "+attack equal to its Armor" is a static that reads
 *    keywordValue(self, "Armor"). Armor granted directly (permanent/temp) is
 *    counted live; Armor from other creatures' static auras is read through
 *    the staticKeywords cache and lags one refreshStatics behind (the engine
 *    refreshes before every batch item / battle / legalActions, so reads in
 *    practice converge). Same corner as Spiritsteel Infiltrator in set4.
 *  - Metamind Archivist: the one-shot "draw at the end of your turn" is
 *    emulated with an invisible marker — the Forge pushes a temp keyword
 *    (Consistent 0, never granted to creatures by anything else) and a
 *    turnEnd trigger fires only while the marker is present. tempKeywords are
 *    cleared at the end of the turn after the turnEnd batch, so it draws
 *    exactly once, at the end of the turn it was Forged.
 *  - Steeleye Seer: "Level up a card in your hand" levels the card IN PLACE
 *    (inst.level += 1), which is why the text can then say "discard it if its
 *    level is higher than your Rank". L3's "You may use this ability twice
 *    per turn" is NOT supported — the engine gates activates on the
 *    activatedThisTurn boolean (legalActions/applyAction), so L3 also works
 *    once per turn. TODO (needs per-ability use counts in the engine).
 *  - Lucid Echoes: UNIMPLEMENTED. "At the end of this turn and your next
 *    turn" (L1/L2) and "at the end of each of your turns" (L3) need deferred
 *    / ongoing spell effects; the engine has no player-level turn hooks and
 *    no persistent effect state. Registered so the defId resolves; playing it
 *    is currently a no-op. TODO.
 *  - Ambriel Archangel: "while your only creature, you get Armor N" is a
 *    continuous player aura the engine cannot express. Approximated as a
 *    top-up (pl.armor = max(pl.armor, N)) on enterPlay and at every turn
 *    start while she is alone, which mimics the each-turn refresh of real
 *    Armor. Corners: armor already granted is not revoked when she stops
 *    being alone, and becoming alone mid-turn (e.g. another creature dies)
 *    does not grant it until the next turn start.
 *  - War Machine: Overload on a CREATURE is not engine-enforced (only spells
 *    are removed from the game on resolution); War Machine still goes to the
 *    discard pile when destroyed. Engine gap, shared with all Set 5+ Overload
 *    creatures.
 *  - Doppelbot: the choice reuses kind "cardInHand", but the options are
 *    indexes into the ENEMY player's hand ("look at the creatures in the
 *    enemy player's hand"). The copy enters at the enemy card's current
 *    level, replaces Doppelbot (so the copy's own Upgrade fires), and L2/L3
 *    then give it +5/+10 attack.
 *  - Countermeasure: the mode is chosen implicitly by the target — choosing
 *    a friendly creature gives +N attack, choosing an enemy gives -N attack.
 *  - Ambriel's Edict: on a tie for highest attack, the leftmost (lowest
 *    lane) creature is kept.
 *  - Torrent Acolyte: puts a Power Torrent (a Set 2.3 card — load
 *    cards_Set_2.3.json) into hand. Power Torrent itself is unscripted in the
 *    set2 files, so it is scripted below as a support card (same convention
 *    as relic-scout in set4-alloyin.ts).
 */
import { registerCard } from "./registry.js";
import {
  buffCreature, destroyCreature, drawCardsEffect, getStats, grantKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, hasKeyword, keywordValue, opposing } from "../state.js";
import { maxLevel, typeAt } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
import type { ChoiceAnswer, Ctx, StaticOut, TriggerPayload } from "../triggers.js";

// ---------- helpers ----------

function targetOf(ctx: Ctx, choice: ChoiceAnswer | null): CreatureState | null {
  return choice?.targetUid !== undefined ? findCreature(ctx.game.state, choice.targetUid) : null;
}

function boardCreatureUids(game: Game, filter?: (c: CreatureState) => boolean): number[] {
  const out: number[] = [];
  for (const c of allCreatures(game.state)) if (!filter || filter(c)) out.push(c.uid);
  return out;
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

/** "Discard and level up a card" — same shape as discardAndLevel in set4-alloyin.ts. */
function discardAndLevel(ctx: Ctx, player: PlayerId, handIndex: number): void {
  const pl = ctx.game.state.players[player];
  const inst = pl.hand[handIndex];
  if (!inst) return;
  pl.hand.splice(handIndex, 1);
  pl.discard.push(inst);
  ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
  levelUpCopy(ctx, player, inst);
}

/** Is this hand instance a creature at its current level? */
function isCreatureAt(game: Game, inst: CardInstance): boolean {
  const def = game.state.cards[inst.defId];
  return def ? typeAt(def, inst.level) === "Creature" : false;
}

// ============================================================
// Creatures
// ============================================================

// --- Aeromind Squadron (Forge: put a random Metamind from your deck into your hand) ---
registerCard({
  defId: "aeromind-squadron",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-tutor-metamind",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pl = ctx.game.state.players[self.owner];
          const pool = pl.deck
            .map((inst, i) => ({ inst, i }))
            .filter(({ inst }) => ctx.game.state.cards[inst.defId]?.subtypes.includes("Metamind"));
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool);
          const [inst] = pl.deck.splice(pick.i, 1);
          pl.hand.push(inst!);
        },
      }],
    }]),
  ),
});

// --- Ambriel Archangel (while your only creature: you get Armor N, this gets Armor M and Mobility 1) ---
function ambrielAlone(game: Game, self: CreatureState): boolean {
  return game.state.players[self.owner].lanes.every((c) => !c || c.uid === self.uid);
}
registerCard({
  defId: "ambriel-archangel",
  levels: Object.fromEntries(
    ([[1, 10, 2], [2, 15, 3], [3, 20, 4]] as const).map(([lvl, pArmor, sArmor]) => [lvl, {
      abilities: [
        // continuous player Armor approximated as a refresh-to-N (see header)
        {
          id: "player-armor-enter",
          trigger: "enterPlay" as const,
          condition: ambrielAlone,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const pl = ctx.game.state.players[self.owner];
            pl.armor = Math.max(pl.armor, pArmor);
          },
        },
        {
          id: "player-armor-refresh",
          trigger: "turnStart" as const,
          condition: ambrielAlone,
          resolve: (ctx: Ctx, self: CreatureState) => {
            const pl = ctx.game.state.players[self.owner];
            pl.armor = Math.max(pl.armor, pArmor);
          },
        },
      ],
      statics: [{
        id: "solo-gear",
        apply: (game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.uid !== self.uid || !ambrielAlone(game, self)) return;
          out.keywords.push({ keyword: "Armor", value: sArmor }, { keyword: "Mobility", value: 1 });
        },
      }],
    }]),
  ),
});

// --- Barrier Soldier (Forge: you get Armor N) ---
registerCard({
  defId: "barrier-soldier",
  levels: Object.fromEntries(
    ([[1, 5], [2, 10], [3, 15]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "forge-player-armor",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].armor += armor;
        },
      }],
    }]),
  ),
});

// --- Batterbot (static: +attack equal to its Armor) ---
registerCard({
  defId: "batterbot",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      statics: [{
        id: "armor-to-attack",
        apply: (_game: Game, self: CreatureState, target: CreatureState, out: StaticOut) => {
          if (target.uid !== self.uid) return;
          out.attack += keywordValue(self, "Armor"); // see header for the aura-lag corner
        },
      }],
    }]),
  ),
});

// --- Doppelbot (Activate: replace with a copy of a creature from the enemy hand) ---
registerCard({
  defId: "doppelbot",
  levels: Object.fromEntries(
    ([[1, 0], [2, 5], [3, 10]] as const).map(([lvl, bonus]) => [lvl, {
      activates: [{
        id: "copy-enemy-creature",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[opposing(self.owner)].hand.some((inst) => isCreatureAt(game, inst)),
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[opposing(self.owner)].hand;
          const options = hand
            .map((inst, i) => ({ inst, i }))
            .filter(({ inst }) => isCreatureAt(game, inst))
            .map(({ i }) => i);
          if (!options.length) return null;
          return {
            kind: "cardInHand" as const, // indexes into the ENEMY hand (see header)
            prompt: "Choose a creature in the enemy player's hand to copy",
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const inst = ctx.game.state.players[opposing(self.owner)].hand[choice.handIndex];
          if (!inst || !isCreatureAt(ctx.game, inst)) return;
          const copy = spawnCreature(ctx.game, ctx.events, self.owner, inst.defId, inst.level,
            { lane: self.lane, replace: true });
          if (copy && bonus) buffCreature(ctx.game, ctx.events, copy, bonus, 0);
        },
      }],
    }]),
  ),
});

// --- Leyline Sentry (Ambush: enemy un-Forged entry; engine handles spawn + discard/level) ---
registerCard({
  defId: "leyline-sentry",
  ambush: { watch: "enemyUnForgedEntry" },
});

// --- Metamind Archivist (Forge: if another friendly Metamind, draw N at end of your turn) ---
registerCard({
  defId: "metamind-archivist",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      abilities: [
        {
          id: "forge-mark",
          trigger: "enterFromHand" as const,
          condition: (game: Game, self: CreatureState) =>
            game.state.players[self.owner].lanes.some((c) =>
              !!c && c.uid !== self.uid && game.state.cards[c.defId]?.subtypes.includes("Metamind")),
          resolve: (_ctx: Ctx, self: CreatureState) => {
            // invisible one-shot marker consumed by the turnEnd trigger (see header)
            self.tempKeywords.push({ keyword: "Consistent", value: 0 });
          },
        },
        {
          id: "eot-draw",
          trigger: "turnEnd" as const,
          condition: (game: Game, self: CreatureState) =>
            game.state.active === self.owner && hasKeyword(self, "Consistent"),
          resolve: (ctx: Ctx, self: CreatureState) => {
            drawCardsEffect(ctx.game, ctx.events, self.owner, n);
          },
        },
      ],
    }]),
  ),
});

// --- Nexus Overwatch (Forge: if in the center space, you may discard and level up a card) ---
registerCard({
  defId: "nexus-overwatch",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-recycle-center",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (_game: Game, self: CreatureState) => self.lane === 2,
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

// --- Steeleye Seer (Activate: level up a card in hand; L1/L2 discard it if above your Rank) ---
registerCard({
  defId: "steeleye-seer",
  levels: Object.fromEntries(
    ([[1, true], [2, true], [3, false]] as const).map(([lvl, discardClause]) => [lvl, {
      activates: [{
        // L3's "twice per turn" is unsupported — once per turn like any Activate (see header)
        id: "level-up-in-hand",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand.length > 0,
        prompt: (game: Game, self: CreatureState) => {
          const hand = game.state.players[self.owner].hand;
          if (!hand.length) return null;
          return {
            kind: "cardInHand" as const,
            prompt: "Level up a card in your hand",
            options: hand.map((_, i) => i),
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          if (choice?.handIndex === undefined) return;
          const pl = ctx.game.state.players[self.owner];
          const inst = pl.hand[choice.handIndex];
          if (!inst) return;
          const def = ctx.game.state.cards[inst.defId];
          if (def && inst.level < maxLevel(def)) {
            inst.level += 1; // leveled IN PLACE (see header)
            ctx.events.push({
              type: "levelUp", player: self.owner, defId: inst.defId,
              fromLevel: inst.level - 1, toLevel: inst.level,
            });
          }
          if (discardClause && inst.level > pl.rank) {
            pl.hand.splice(choice.handIndex, 1);
            pl.discard.push(inst);
            ctx.events.push({ type: "discard", player: self.owner, defId: inst.defId, level: inst.level });
          }
        },
      }],
    }]),
  ),
});

// --- Torrent Acolyte (L2/L3 Forge: put a level 2/3 Power Torrent into your hand) ---
registerCard({
  defId: "torrent-acolyte",
  levels: {
    1: {}, // vanilla — explicit so the registry fallback never hands L1 the L3 script
    2: {
      abilities: [{
        id: "forge-power-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "power-torrent", level: 2, owner: self.owner,
          });
        },
      }],
    },
    3: {
      abilities: [{
        id: "forge-power-torrent",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          ctx.game.state.players[self.owner].hand.push({
            uid: ctx.game.state.nextUid++, defId: "power-torrent", level: 3, owner: self.owner,
          });
        },
      }],
    },
  },
});

// --- War Machine (Overload; Forge: each other friendly creature gets +3 attack) ---
registerCard({
  defId: "war-machine",
  levels: {
    1: {
      abilities: [{
        id: "forge-rally",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (c && c.uid !== self.uid) buffCreature(ctx.game, ctx.events, c, 3, 0);
          }
        },
      }],
    },
  },
});

// ============================================================
// Spells
// ============================================================

// --- Ambriel's Edict (Overload; keep only each player's highest-attack creature; discard your hand) ---
registerCard({
  defId: "ambriels-edict",
  spell: {
    1: {
      resolve: (ctx: Ctx, player: PlayerId) => {
        const sides = [player, opposing(player)] as PlayerId[];
        const boards = sides.map((p) =>
          ctx.game.state.players[p].lanes.filter((c): c is CreatureState => !!c));
        if (boards.every((b) => b.length)) {
          for (const board of boards) {
            let keep = board[0]!;
            for (const c of board) {
              if (getStats(ctx.game, c).attack > getStats(ctx.game, keep).attack) keep = c; // ties: leftmost
            }
            for (const c of board) {
              if (c.uid !== keep.uid) destroyCreature(ctx.game, ctx.events, c);
            }
          }
        }
        const pl = ctx.game.state.players[player];
        for (const inst of pl.hand.splice(0)) {
          pl.discard.push(inst);
          ctx.events.push({ type: "discard", player, defId: inst.defId, level: inst.level });
        }
      },
    },
  },
});

// --- Countermeasure (enemy creature -N attack, OR friendly creature +N attack) ---
registerCard({
  defId: "countermeasure",
  spell: Object.fromEntries(
    ([[1, 4], [2, 8], [3, 12]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return {
          kind: "anyCreature" as const,
          prompt: `Give an enemy creature -${n} attack, or a friendly creature +${n} attack`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        buffCreature(ctx.game, ctx.events, c, c.owner === player ? n : -n, 0); // mode by target (see header)
      },
    }]),
  ),
});

// --- Lucid Echoes (UNIMPLEMENTED — see header TODO) ---
registerCard({ defId: "lucid-echoes" });

// --- Oreian Steelskin (creature gets Armor N, +1 more at Rank 2+) ---
registerCard({
  defId: "oreian-steelskin",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature Armor ${n}`, options };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        const bonus = ctx.game.state.players[player].rank >= 2 ? 1 : 0;
        grantKeyword(ctx.events, c, { keyword: "Armor", value: n + bonus });
      },
    }]),
  ),
});

// --- Power Torrent (Set 2.3 support card for Torrent Acolyte — see header) ---
registerCard({
  defId: "power-torrent",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature +${n} attack`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (c) buffCreature(ctx.game, ctx.events, c, n, 0);
      },
    }]),
  ),
});
