/** Seeded RNG (mulberry32) — deterministic replays for tests and AI simulation. */
export type Rng = {
  next(): number; // [0, 1)
  int(n: number): number; // [0, n)
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: T[]): T[];
};

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ ((t ^ (t >>> 14)) >>> 0);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => {
      if (arr.length === 0) throw new Error("pick from empty array");
      return arr[Math.floor(next() * arr.length)]!;
    },
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    },
  };
  return rng;
}
