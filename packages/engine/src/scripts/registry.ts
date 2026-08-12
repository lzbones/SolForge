/**
 * Card script registry. Scripts register themselves at module load
 * (scripts/index.ts imports every set file).
 */
import type { CardScript, LevelScript, Ability } from "../triggers.js";

const scripts = new Map<string, CardScript>();
const granted = new Map<string, Ability>();

export function registerCard(script: CardScript): void {
  scripts.set(script.defId, script);
}

/** Ad-hoc abilities granted by other cards ("gets 'Vengeance: ...'"). */
export function registerGranted(ref: string, ability: Ability): void {
  granted.set(ref, ability);
}

/** Persistent player-level effects (auras / deferred spells). */
import type { PlayerEffectDef } from "../triggers.js";
const playerEffects = new Map<string, PlayerEffectDef>();
export function registerPlayerEffect(ref: string, def: PlayerEffectDef): void {
  playerEffects.set(ref, def);
}
export function getPlayerEffect(ref: string): PlayerEffectDef | null {
  return playerEffects.get(ref) ?? null;
}

export function getCardScript(defId: string): CardScript | null {
  return scripts.get(defId) ?? null;
}

export function getLevelScript(defId: string, level: number): LevelScript | null {
  const s = scripts.get(defId);
  if (!s?.levels) return null;
  return s.levels[level] ?? s.levels[Math.max(...Object.keys(s.levels).map(Number))] ?? null;
}

export function getGrantedAbility(ref: string): Ability | null {
  return granted.get(ref) ?? null;
}

export function registeredCards(): string[] {
  return [...scripts.keys()];
}
