/**
 * Set 6 (Darkforge Uprising) + 6.1 + 6.2 — Alloyin card scripts.
 * See docs/CARD_SCRIPTING.md.
 *
 * Approximation notes (same conventions as set5-alloyin.ts):
 *  - H.E.R.M.E.S slugifies to "hermes" (slugify() strips the periods).
 *  - Alyssa, Strifeborn: "non-battle damage" cannot be read off the `damaged`
 *    payload — it carries source/amount/lane but no battle flag (the
 *    anyCreatureDamaged broadcast has one via evt.fromHand, but it never fires
 *    for the damage target itself, and sourced non-battle damage is common, so
 *    sourceUid is not a proxy either). Alyssa therefore triggers on ANY damage
 *    she survives, battle included. TODO: add evt.battle to the damaged
 *    payload (same gap as Windspark Elemental in set5-tempys.ts).
 *  - H.E.R.M.E.S: "Defender and Armor N until the end of the next turn" —
 *    engine temp keywords are wiped at the end of the CURRENT turn, so a temp
 *    grant at end-of-turn would vanish instantly. Instead the grant is
 *    permanent plus a granted turnEnd ability (alloyin:hermes-expire-N) that
 *    removes it at the end of the opponent's turn (the next turn). Corners:
 *    the Defender removal uses negateKeyword, so a creature with inherent
 *    Defender loses it too (same corner as Uranti Bolt in set1-tempys.ts);
 *    the Armor removal splices one matching {Armor, N} entry and can hit an
 *    identical inherent entry instead of the granted one.
 *  - Vault Intruder: "Look at the enemy player's hand" is information-only;
 *    there is no UI/AI disclosure channel to implement. Registered as a
 *    no-op so the defId resolves.
 *  - Nexus Bubble: UNIMPLEMENTED. "You get, 'Friendly Alloyin creatures in
 *    the center space get Armor 3'" grants the PLAYER an ongoing aura; the
 *    engine has no player-level ability/static hook (statics only come from
 *    creatures in play). Registered so the defId resolves; playing it is a
 *    no-op (Overload still sends it to the removed pile). TODO.
 *  - Wipe Clean: "remove all abilities" = silence + strip all keywords
 *    (inherent/granted/temp) and granted ability refs. Static auras are NOT
 *    stripped (computeStatics does not check silenced and staticKeywords are
 *    recomputed by the engine), and "from each player" is a no-op — players
 *    have no abilities in the engine (only Nexus Bubble would grant one, and
 *    it is itself unimplemented).
 *  - Sparky, Forge Guard Dog L3: spawns Forge Guardian Omega (a Set 1 token)
 *    at level 1 with overrideStats 20/20 — the printed Omega L1 token is
 *    25/25, but Sparky's text explicitly says "a 20/20 Forge Guardian Omega".
 *    The Omega's L1 keywords (Armor 10, Breakthrough, ...) are kept. The
 *    defId must be loaded (tests load cards_Set_1.json).
 *  - Sparky (all levels): the two destroyed Sparkies stay in their lanes
 *    until the batch ends, so the Spawn lands in a random OTHER open space;
 *    on a completely full board the Spawn fizzles (the lanes only free up at
 *    the end-of-batch death check).
 *  - Marty McGear: "a copy of a ... Robot from your deck" leaves the original
 *    in the deck and enters at the deck card's current level (War Tinker
 *    convention from set4-alloyin.ts).
 *  - Subtype matching: the scraper stores combined subtype strings
 *    ("Darkforged Robot", "Robot Guardian"), so Darkforged/Robot membership
 *    is a substring/word match, which also counts e.g. Darkforged Robots as
 *    Robots (correct) and Robot Guardians as Robots.
 */
import { registerCard, registerGranted } from "./registry.js";
import {
  buffCreature, destroyCreature, drawCardsEffect, getStats, grantKeyword, isDeadEffective,
  negateKeyword, spawnCreature,
} from "../effects.js";
import { allCreatures, findCreature, opposing } from "../state.js";
import { maxLevel } from "../types.js";
import type { Game } from "../game.js";
import type { CardInstance, CreatureState, PlayerId } from "../state.js";
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

/** Word-match against combined subtype strings ("Darkforged Robot" etc.). */
function hasSubtype(game: Game, defId: string, subtype: string): boolean {
  return game.state.cards[defId]?.subtypes.some((s) => s.split(" ").includes(subtype)) ?? false;
}

function isDarkforged(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Darkforged");
}

function isRobot(game: Game, defId: string): boolean {
  return hasSubtype(game, defId, "Robot");
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

/** "Discard and level up a card" — same shape as discardAndLevel in set5-alloyin.ts. */
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

// H.E.R.M.E.S: the granted Defender + Armor N expire at the end of the
// opponent's turn ("until the end of the next turn" — see header).
for (const n of [1, 2, 4] as const) {
  registerGranted(`alloyin:hermes-expire-${n}`, {
    id: `alloyin:hermes-expire-${n}`,
    trigger: "turnEnd",
    condition: (game, self) => game.state.active !== self.owner,
    resolve(ctx, self) {
      negateKeyword(ctx.events, self, "Defender"); // inherent-Defender corner: see header
      const i = self.keywords.findIndex((k) => k.keyword === "Armor" && k.value === n);
      if (i >= 0) self.keywords.splice(i, 1);
      self.grantedAbilities = self.grantedAbilities.filter((r) => r !== `alloyin:hermes-expire-${n}`);
    },
  });
}

// ============================================================
// Creatures
// ============================================================

// --- Alyssa, Strifeborn (when dealt damage and survives: +X/+1 per damage) ---
registerCard({
  defId: "alyssa-strifeborn",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, perDmg]) => [lvl, {
      abilities: [{
        id: "pain-growth",
        trigger: "damaged" as const, // battle damage also triggers — see header TODO
        condition: (game: Game, self: CreatureState) => !isDeadEffective(game, self), // "and survives"
        resolve: (ctx: Ctx, self: CreatureState, evt: TriggerPayload) => {
          const amount = evt.amount ?? 0;
          if (amount > 0) buffCreature(ctx.game, ctx.events, self, perDmg * amount, amount);
        },
      }],
    }]),
  ),
});

// --- Darksteel Enforcer (Forge: friendly creature +N attack per friendly Darkforged) ---
registerCard({
  defId: "darksteel-enforcer",
  levels: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      abilities: [{
        id: "forge-darkforged-rally",
        trigger: "enterFromHand" as const,
        targeted: true,
        prompt: (game: Game, self: CreatureState) => {
          const options = friendlyUids(game, self.owner);
          if (!options.length) return null;
          return {
            kind: "friendlyCreature" as const,
            prompt: `Give a friendly creature +${n} attack for each friendly Darkforged`,
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          if (!c) return;
          const count = ctx.game.state.players[self.owner].lanes
            .filter((x): x is CreatureState => !!x && isDarkforged(ctx.game, x.defId))
            .length;
          if (count > 0) buffCreature(ctx.game, ctx.events, c, n * count, 0);
        },
      }],
    }]),
  ),
});

// --- Flowsteel Carrier (Vengeance: a random friendly Robot gets Armor N) ---
registerCard({
  defId: "flowsteel-carrier",
  levels: Object.fromEntries(
    ([[1, 3], [2, 5], [3, 8]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "vengeance-armor-robot",
        trigger: "destroyed" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const robots = ctx.game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && isRobot(ctx.game, c.defId));
          if (!robots.length) return;
          grantKeyword(ctx.events, ctx.rng.pick(robots), { keyword: "Armor", value: armor });
        },
      }],
    }]),
  ),
});

// --- Forgewatch Sentry (when dealt damage, destroy it) ---
registerCard({
  defId: "forgewatch-sentry",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "fragile",
        trigger: "damaged" as const, // only fires when damage gets past Armor (dealt > 0)
        resolve: (ctx: Ctx, self: CreatureState) => {
          destroyCreature(ctx.game, ctx.events, self);
        },
      }],
    }]),
  ),
});

// --- H.E.R.M.E.S (end of your turn: other friendly creatures get Defender + Armor N
//     until the end of the next turn — granted-ability emulation, see header) ---
registerCard({
  defId: "hermes",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 4]] as const).map(([lvl, armor]) => [lvl, {
      abilities: [{
        id: "guard-protocol",
        trigger: "turnEnd" as const,
        condition: (game: Game, self: CreatureState) => game.state.active === self.owner,
        resolve: (ctx: Ctx, self: CreatureState) => {
          for (const c of ctx.game.state.players[self.owner].lanes) {
            if (!c || c.uid === self.uid) continue;
            grantKeyword(ctx.events, c, { keyword: "Defender", value: 0 });
            grantKeyword(ctx.events, c, { keyword: "Armor", value: armor });
            c.grantedAbilities.push(`alloyin:hermes-expire-${armor}`);
          }
        },
      }],
    }]),
  ),
});

// --- Marty McGear (Activate: Spawn a copy of a random Robot from deck, it gets +N/Armor N) ---
registerCard({
  defId: "marty-mcgear",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, 3]] as const).map(([lvl, n]) => [lvl, {
      activates: [{
        id: "build-a-bot",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].deck.some((inst) =>
            isRobot(game, inst.defId) && inst.level <= lvl), // L1: level 1; L2: <=2; L3: any
        resolve: (ctx: Ctx, self: CreatureState) => {
          const pool = ctx.game.state.players[self.owner].deck
            .filter((inst) => isRobot(ctx.game, inst.defId) && inst.level <= lvl);
          if (!pool.length) return;
          const pick = ctx.rng.pick(pool); // a copy: the original stays in the deck (see header)
          const copy = spawnCreature(ctx.game, ctx.events, self.owner, pick.defId, pick.level, {});
          if (copy) {
            buffCreature(ctx.game, ctx.events, copy, n, 0);
            grantKeyword(ctx.events, copy, { keyword: "Armor", value: n });
          }
        },
      }],
    }]),
  ),
});

// --- Mind Breaker (Forge: draw a card for each friendly Metamind) ---
registerCard({
  defId: "mind-breaker",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [{
        id: "forge-metamind-draw",
        trigger: "enterFromHand" as const,
        resolve: (ctx: Ctx, self: CreatureState) => {
          const count = ctx.game.state.players[self.owner].lanes
            .filter((c): c is CreatureState => !!c && hasSubtype(ctx.game, c.defId, "Metamind"))
            .length; // includes itself — it is a friendly Metamind in play
          if (count > 0) drawCardsEffect(ctx.game, ctx.events, self.owner, count);
        },
      }],
    }]),
  ),
});

// --- Shadowmist Angel (another friendly Darkforged enters: +N/+N) ---
registerCard({
  defId: "shadowmist-angel",
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

// --- Shadowsmith (a friendly Darkforged enters play: you may discard and level up) ---
registerCard({
  defId: "shadowsmith",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      abilities: [
        {
          // itself entering counts ("a friendly Darkforged", not "another") —
          // the anyCreatureEnterPlay broadcast excludes the entering creature
          id: "recycle-self-entry",
          trigger: "enterPlay" as const,
          targeted: true,
          prompt: recyclePrompt,
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) =>
            recycleResolve(ctx, self, choice),
        },
        {
          id: "recycle-darkforged-entry",
          trigger: "anyCreatureEnterPlay" as const,
          targeted: true,
          condition: (game: Game, self: CreatureState, evt: TriggerPayload) =>
            evt.sourceOwner === self.owner && !!evt.sourceDefId && isDarkforged(game, evt.sourceDefId),
          prompt: recyclePrompt,
          resolve: (ctx: Ctx, self: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) =>
            recycleResolve(ctx, self, choice),
        },
      ],
    }]),
  ),
});

// --- Vault Intruder (Forge: look at the enemy player's hand — no engine effect, see header) ---
registerCard({ defId: "vault-intruder" });

// --- Patron of Anvillon (Forge: with 3+ Alloyin cards in hand, give a creature 2x attack) ---
registerCard({
  defId: "patron-of-anvillon",
  levels: Object.fromEntries(
    ([[1, 1], [2, 2], [3, Infinity]] as const).map(([lvl, cap]) => [lvl, {
      abilities: [{
        id: "forge-double-attack",
        trigger: "enterFromHand" as const,
        targeted: true,
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].hand
            .filter((inst) => game.state.cards[inst.defId]?.faction === "Alloyin")
            .length >= 3,
        prompt: (game: Game) => {
          // L1: exactly level 1; L2: level 2 or lower; L3: any creature
          const options = boardCreatureUids(game, (c) => lvl === 1 ? c.level === 1 : c.level <= cap);
          if (!options.length) return null;
          return { kind: "anyCreature" as const, prompt: "Give a creature 2x attack", options };
        },
        resolve: (ctx: Ctx, _s: CreatureState, _e: TriggerPayload, choice: ChoiceAnswer | null) => {
          const c = targetOf(ctx, choice);
          // "2x attack" doubles current attack (Abraxas convention, set1-tempys.ts)
          if (c) buffCreature(ctx.game, ctx.events, c, getStats(ctx.game, c).attack, 0);
        },
      }],
    }]),
  ),
});

// --- Sparky, Forge Guard Dog (Activate, destroy self + another friendly Sparky:
//     Spawn a level+1 Sparky; L3 spawns a 20/20 Forge Guardian Omega) ---
registerCard({
  defId: "sparky-forge-guard-dog",
  levels: Object.fromEntries(
    [1, 2, 3].map((lvl) => [lvl, {
      activates: [{
        id: "forge-guardian-protocol",
        condition: (game: Game, self: CreatureState) =>
          game.state.players[self.owner].lanes.some((c) =>
            !!c && c.uid !== self.uid && c.defId === "sparky-forge-guard-dog"
            && (lvl < 3 || c.level === 3)), // L3 needs another LEVEL 3 Sparky
        prompt: (game: Game, self: CreatureState) => {
          const options = game.state.players[self.owner].lanes
            .filter((c): c is CreatureState =>
              !!c && c.uid !== self.uid && c.defId === "sparky-forge-guard-dog"
              && (lvl < 3 || c.level === 3))
            .map((c) => c.uid);
          if (!options.length) return null;
          return {
            kind: "friendlyCreature" as const,
            prompt: lvl < 3
              ? "Destroy Sparky and another friendly Sparky"
              : "Destroy Sparky and another friendly level 3 Sparky",
            options,
          };
        },
        resolve: (ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null) => {
          const other = targetOf(ctx, choice);
          if (!other || other.defId !== "sparky-forge-guard-dog" || other.owner !== self.owner) return;
          destroyCreature(ctx.game, ctx.events, self);
          destroyCreature(ctx.game, ctx.events, other);
          // the doomed Sparkies still occupy their lanes until the batch ends (see header)
          if (lvl < 3) {
            spawnCreature(ctx.game, ctx.events, self.owner, "sparky-forge-guard-dog", lvl + 1, {});
          } else if (ctx.game.state.cards["forge-guardian-omega"]) {
            spawnCreature(ctx.game, ctx.events, self.owner, "forge-guardian-omega", 1,
              { overrideStats: { attack: 20, health: 20 } }); // "a 20/20 Forge Guardian Omega"
          }
        },
      }],
    }]),
  ),
});

// ============================================================
// Spells
// ============================================================

// --- Blood Barrier (creature gets Armor N; +N more if a creature was destroyed this turn) ---
registerCard({
  defId: "blood-barrier",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 4]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game) => {
        const options = boardCreatureUids(game);
        if (!options.length) return null;
        return { kind: "anyCreature" as const, prompt: `Give a creature Armor ${n}`, options };
      },
      resolve: (ctx: Ctx, _p: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c) return;
        grantKeyword(ctx.events, c, { keyword: "Armor", value: n });
        if (ctx.game.state.deathLog.length > 0) { // any creature, either side, this turn
          grantKeyword(ctx.events, c, { keyword: "Armor", value: n });
        }
      },
    }]),
  ),
});

// --- Pummel Pack (friendly creature +N attack and Armor N; doubled if it is the only one) ---
registerCard({
  defId: "pummel-pack",
  spell: Object.fromEntries(
    ([[1, 2], [2, 3], [3, 6]] as const).map(([lvl, n]) => [lvl, {
      prompt: (game: Game, player: PlayerId) => {
        const options = friendlyUids(game, player);
        if (!options.length) return null;
        return {
          kind: "friendlyCreature" as const,
          prompt: `Give a friendly creature +${n} attack and Armor ${n}`,
          options,
        };
      },
      resolve: (ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null) => {
        const c = targetOf(ctx, choice);
        if (!c || c.owner !== player) return;
        const only = friendlyUids(ctx.game, player).length === 1;
        const times = only ? 2 : 1;
        for (let i = 0; i < times; i++) {
          buffCreature(ctx.game, ctx.events, c, n, 0);
          grantKeyword(ctx.events, c, { keyword: "Armor", value: n });
        }
      },
    }]),
  ),
});

// --- Wipe Clean (Overload; remove all abilities from each creature — see header corners) ---
registerCard({
  defId: "wipe-clean",
  spell: {
    1: {
      resolve: (ctx: Ctx) => {
        for (const c of allCreatures(ctx.game.state)) {
          c.keywords = [];
          c.tempKeywords = [];
          c.grantedAbilities = [];
          c.silenced = true; // triggered/activated abilities stop firing
        }
      },
    },
  },
});

// --- Nexus Bubble (UNIMPLEMENTED — player-granted ongoing aura; see header TODO) ---
registerCard({ defId: "nexus-bubble" });
