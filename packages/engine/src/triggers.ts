/**
 * Trigger/ability model.
 *
 * Resolution model (from the Advanced Rules):
 *  - Everything that happens as a consequence of one game event forms a BATCH.
 *  - Death is only checked at the END of a batch.
 *  - Within a batch: active player's untargeted abilities, then inactive
 *    player's untargeted, then active player's targeted, then inactive
 *    player's targeted; random order within a group.
 *  - Abilities triggered by deaths form a follow-up batch.
 *
 * Abilities that need player input declare `prompt`; the engine pauses the
 * batch, surfaces a ChoiceRequest, and resumes when answered. State stays
 * serializable: the pending choice stores ids, not closures.
 */
import type { Game } from "./game.js";
import type { CreatureState, PlayerId } from "./state.js";

/** Outward-facing event stream (drives UI animations and logs). */
export type GameEvent =
  | { type: "draw"; player: PlayerId; count: number }
  | { type: "play"; player: PlayerId; uid: number; defId: string; level: number; lane?: number }
  | { type: "levelUp"; player: PlayerId; defId: string; fromLevel: number; toLevel: number }
  | { type: "discard"; player: PlayerId; defId: string; level: number }
  | { type: "damage"; target: { player: PlayerId; lane?: number }; amount: number }
  | { type: "playerDamage"; player: PlayerId; amount: number }
  | { type: "heal"; player: PlayerId; amount: number }
  | { type: "healCreature"; player: PlayerId; lane: number; amount: number }
  | { type: "buff"; player: PlayerId; lane: number; attack: number; health: number; temp: boolean }
  | { type: "grantKeyword"; player: PlayerId; lane: number; keyword: string; value: number; temp: boolean }
  | { type: "negateKeyword"; player: PlayerId; lane: number; keyword: string }
  | { type: "marked"; player: PlayerId; lane: number; defId: string }
  | { type: "banished"; player: PlayerId; defId: string; level: number }
  | { type: "spawn"; player: PlayerId; uid: number; defId: string; level: number; lane: number }
  | { type: "moved"; player: PlayerId; uid: number; from: number; to: number }
  | { type: "activated"; player: PlayerId; uid: number; abilityId: string }
  | { type: "destroyed"; player: PlayerId; lane: number; defId: string }
  | { type: "rankUp"; player: PlayerId; rank: number }
  | { type: "reshuffle"; player: PlayerId }
  | { type: "battle" }
  | { type: "choiceRequest"; request: ChoiceRequest }
  | { type: "gameOver"; winner: PlayerId };

export type TriggerEvent =
  | "enterFromHand"     // played from hand (Forge, Assault, Formation, Allied conditions)
  | "enterPlay"         // any way of entering the field
  | "enterReplace"      // entered by replacing a creature (Upgrade)
  | "wasReplaced"       // this creature was replaced by another (snapshot self)
  | "creatureReplaced"  // any creature was replaced (board-wide)
  | "playerHealed"      // a player gained health (evt.targetPlayer/amount)
  | "creatureHealed"    // this creature was healed (evt.amount = actual heal)
  | "anyCreatureDamaged" // any creature took damage (evt: target lane/owner, amount, fromBattle)
  | "destroyed"         // this creature was destroyed (Vengeance)
  | "anyCreatureDestroyed"
  | "friendlyCreatureDestroyed"
  | "opposingCreatureDestroyed" // the creature opposing this one died
  | "battleDamageToPlayer"      // this creature dealt battle damage to a player
  | "friendlyBattleDamageToPlayer" // any friendly creature dealt battle damage to a player
  | "battleDamageToCreature"    // this creature dealt battle damage to a creature
  | "dealtDamageToCreature"     // this creature dealt any damage to a creature
  | "damaged"                   // this creature was dealt damage
  | "creatureDied"              // a creature died (Grimgaunt Devourer style)
  | "moved"                     // this creature moved lanes (Flank)
  | "friendlyCreatureMoved"     // any friendly creature moved lanes
  | "enemyCreatureMoved"        // any enemy creature moved lanes
  | "anyCreatureEnterPlay"      // any creature entered the field (evt.fromHand = was Forged)
  | "turnStart" | "turnEnd" | "rankGained"
  | "cardPlayed" | "spellPlayed" | "creaturePlayed"
  | "enemyCreatureEntered";

export interface TriggerPayload {
  /** What caused the trigger (e.g. the played card's defId, the dead creature). */
  sourceDefId?: string | undefined;
  sourceUid?: number | undefined;
  sourceLevel?: number | undefined;
  sourceOwner?: PlayerId | undefined;
  lane?: number | undefined;
  amount?: number | undefined;
  targetPlayer?: PlayerId | undefined;
  /** For enter-play events: whether the creature was played from hand (Forged). */
  fromHand?: boolean | undefined;
  /** For damage events: whether the damage was battle damage. */
  battle?: boolean | undefined;
}

export interface ChoiceRequest {
  /** Unique id the caller echoes back with the answer. */
  id: string;
  kind: "yesNo" | "friendlyCreature" | "enemyCreature" | "anyCreature" | "anyCreatureOrPlayer" | "cardInHand" | "cardInDiscard";
  prompt: string;
  /** For creature choices: filter by lane occupancy; uids of legal options. */
  options?: number[]; // creature uids or hand/discard indexes
  optional?: boolean; // "you may"
}

export interface ChoiceAnswer {
  id: string;
  accepted?: boolean;   // yesNo / optional
  targetUid?: number;   // creature choices
  handIndex?: number;
}

export interface Ctx {
  game: Game;
  events: GameEvent[];
  rng: import("./rng.js").Rng;
  /** Answers to earlier prompts in a multi-step chain (empty on first call). */
  priorAnswers: ChoiceAnswer[];
  /** Request player input; pauses resolution. Throws ChoicePause. */
  choose(req: Omit<ChoiceRequest, "id">): ChoiceAnswer;
}

/** resolve may return a further ChoiceRequest to build multi-step choices. */
export type ResolveResult = void | Omit<ChoiceRequest, "id">;

export interface Ability {
  id: string; // unique within the card script level
  trigger: TriggerEvent;
  /** Targeted abilities resolve after untargeted ones within the batch. */
  targeted?: boolean;
  condition?(game: Game, self: CreatureState, evt: TriggerPayload): boolean;
  /** Return a ChoiceRequest if input is needed, else null. */
  prompt?(game: Game, self: CreatureState, evt: TriggerPayload): Omit<ChoiceRequest, "id"> | null;
  resolve(ctx: Ctx, self: CreatureState, evt: TriggerPayload, choice: ChoiceAnswer | null): ResolveResult;
}

export interface ActivateAbility {
  id: string;
  condition?(game: Game, self: CreatureState): boolean;
  prompt?(game: Game, self: CreatureState): Omit<ChoiceRequest, "id"> | null;
  resolve(ctx: Ctx, self: CreatureState, choice: ChoiceAnswer | null): ResolveResult;
}

/** Static abilities recompute stats/keywords on every read (lane order). */
export interface StaticAbility {
  id: string;
  /** Mutate out.attack/out.health and/or push into out.keywords. */
  apply(game: Game, self: CreatureState, target: CreatureState, out: StaticOut): void;
}

export interface StaticOut {
  attack: number;
  health: number;
  keywords: import("./state.js").KeywordValue[];
}

export interface GrantedAbilitySpec {
  /** Registry key, e.g. "shared:vengeance-spawn-self". Registered in scripts/shared.ts. */
  ref: string;
}

export interface LevelScript {
  abilities?: Ability[];
  activates?: ActivateAbility[];
  statics?: StaticAbility[];
}

export interface SpellScript {
  prompt?(game: Game, player: PlayerId): Omit<ChoiceRequest, "id"> | null;
  resolve(ctx: Ctx, player: PlayerId, choice: ChoiceAnswer | null): ResolveResult;
}

export interface CardScript {
  defId: string;
  levels?: Partial<Record<number, LevelScript>>;
  /** For spells: per level. */
  spell?: Partial<Record<number, SpellScript>>;
  /** Solbind: these defIds are added to the deck at game start (duplicates allowed). */
  solbind?: string[];
  /**
   * Ambush: while this card is in hand, watch the enemy's turn. When the
   * condition matches, a copy is Spawned and this card is discarded+leveled.
   */
  ambush?: {
    watch: "thirdEnemyCard" | "enemyMove" | "enemyUnForgedEntry" | "enemyHeal";
  };
}

/** Control-flow signal: a choice is needed; batch pauses. */
export class ChoicePause extends Error {
  constructor(public request: ChoiceRequest) { super("choice needed"); }
}
