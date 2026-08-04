/** Mutable in-game state. */
import type { CardDef, Keyword } from "./types.js";

export type PlayerId = 0 | 1;
export const LANES = 5;
export const STARTING_HEALTH = 120;
export const DECK_SIZE = 30;
export const PLAYS_PER_TURN = 2;
export const HAND_DRAW = 5;
export const TURNS_PER_RANK = 4;

/** A physical card in the game (deck/hand/discard/removed). */
export interface CardInstance {
  uid: number;
  defId: string;
  level: number;
  owner: PlayerId;
}

export interface KeywordValue {
  keyword: Keyword;
  value: number; // 0 for flag keywords (Defender, Breakthrough, ...)
}

/** A creature on the board. */
export interface CreatureState {
  uid: number;
  defId: string;
  level: number;
  owner: PlayerId;
  lane: number; // 0..4
  /** Current stats including permanent modifications. */
  attack: number;
  health: number;
  /** Damage marked on the creature. Effective health = health - damage. */
  damage: number;
  /** Just played: cannot attack / activate / move until controller's next turn. */
  defensive: boolean;
  /** Inherent + granted keywords (granted ones may be temporary). */
  keywords: KeywordValue[];
  /** Keyword granted only until end of turn (recomputed each turn). */
  tempKeywords: KeywordValue[];
  /** Keywords granted by static abilities; refreshed by the engine. */
  staticKeywords: KeywordValue[];
  /** Silenced creatures' triggered/activated abilities do not fire. */
  silenced: boolean;
  /** Granted triggered-ability refs (scripts/shared registry), e.g. "shared:foo". */
  grantedAbilities: string[];
  /** Temporary stat modifiers; inverted at end of turn. */
  tempMods: { attack: number; health: number }[];
  /** Death ordering within a batch (0 = alive). */
  deathSeq: number;
  /** Extra battles this creature may fight in per turn. */
  extraBattles: number;
  hasBattled: boolean;
  /** Armor already used this turn (Armor prevents the first X damage each turn). */
  armorUsed: number;
  movedThisTurn: boolean;
  activatedThisTurn: boolean;
}

export interface PlayerState {
  health: number;
  armor: number;
  poison: number;
  rank: number; // 1..5
  turnInRank: number; // 1..4
  deck: CardInstance[];
  hand: CardInstance[];
  discard: CardInstance[];
  removed: CardInstance[];
  lanes: (CreatureState | null)[]; // length 5, this player's spaces
}

export type Phase = "main" | "gameOver";

export interface PendingChoice {
  /** Registry path of the paused ability, to resume resolution. */
  resume:
    | { kind: "trigger"; defId: string; abilityId: string; selfUid: number; selfLevel: number; evt: import("./triggers.js").TriggerPayload }
    | { kind: "activate"; defId: string; abilityId: string; selfUid: number }
    | { kind: "spell"; defId: string; level: number; player: PlayerId };
  /** Answers already given in a multi-step choice chain. */
  priorAnswers: import("./triggers.js").ChoiceAnswer[];
  request: import("./triggers.js").ChoiceRequest;
}

export interface GameState {
  cards: Record<string, CardDef>;
  players: [PlayerState, PlayerState];
  active: PlayerId;
  turnNumber: number;
  phase: Phase;
  playsLeft: number;
  battlesLeft: number;
  winner: PlayerId | null;
  nextUid: number;
  deathCounter: number;
  pending: PendingChoice | null;
  /** Remaining batch items when paused on a choice. */
  pendingQueue: import("./effects.js").BatchItem[];
  /** Cards played by the active player this turn (Ambush: "third card played"). */
  cardsPlayedThisTurn: number;
  /** Per-turn occurrence flags watched by Ambush cards (reset each turn). */
  turnFlags: { moved: boolean; unForgedEntry: boolean; healed: boolean };
}

export function emptyPlayer(): PlayerState {
  return {
    health: STARTING_HEALTH,
    armor: 0,
    poison: 0,
    rank: 1,
    turnInRank: 1,
    deck: [],
    hand: [],
    discard: [],
    removed: [],
    lanes: Array<CreatureState | null>(LANES).fill(null),
  };
}

export function effectiveHealth(c: CreatureState): number {
  return c.health - c.damage;
}

export function isDead(c: CreatureState): boolean {
  return effectiveHealth(c) <= 0;
}

export function opposing(p: PlayerId): PlayerId {
  return (1 - p) as PlayerId;
}

export function hasKeyword(c: CreatureState, kw: Keyword): boolean {
  return c.keywords.some((k) => k.keyword === kw)
    || c.tempKeywords.some((k) => k.keyword === kw)
    || c.staticKeywords.some((k) => k.keyword === kw);
}

export function keywordValue(c: CreatureState, kw: Keyword): number {
  let v = 0;
  for (const k of [...c.keywords, ...c.tempKeywords, ...c.staticKeywords]) if (k.keyword === kw) v += k.value;
  return v;
}

export function* allCreatures(s: GameState): Generator<CreatureState> {
  for (const p of s.players) for (const c of p.lanes) if (c) yield c;
}

export function findCreature(s: GameState, uid: number): CreatureState | null {
  for (const c of allCreatures(s)) if (c.uid === uid) return c;
  return null;
}
