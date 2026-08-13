import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  applyAction, applyChoice, canAttack, getStats, hasKeyword, isOffensive,
  type CreatureState, type Game, type GameEvent, type GameState, type PendingChoice,
} from "@solforge/engine";
import { choiceOwner } from "@solforge/ai";
import {
  CARDS, getDeckOptions, hasSave, loadGame, newGameWith, saveGame, stepAi, uiSettings,
  type GameConfig,
} from "./controller.js";
import { artUrl, CardDetail, type HoverCard } from "./CardDetail.js";
import { DeckBuilder } from "./DeckBuilder.js";
import { isSfxEnabled, playSfx, setSfxEnabled } from "./sound.js";

const HUMAN: 0 | 1 = 0;

// ---------- battle history ----------

/** A text segment, optionally carrying a card reference (hoverable in history). */
type Seg = string | { defId: string; level: number };

type LogEntry =
  | { kind: "entry"; who: 0 | 1 | null; parts: Seg[]; cls?: string }
  | { kind: "marker"; text: string };

const WHO = ["你", "对手"] as const;

function cardName(defId: string): string {
  return CARDS[defId]?.name ?? defId;
}

/** card segment shown as "L2 牌名" with hover detail */
const c = (defId: string, level: number): Seg => ({ defId, level });

/** Pre-action lane snapshot (module-level so describeEvent can resolve dead cards). */
const laneSnapshot = new Map<string, { defId: string; level: number }>();

/** Convert engine events into readable Chinese history lines. */
function describeEvent(e: GameEvent): LogEntry | null {
  switch (e.type) {
    case "play":
      return {
        kind: "entry", who: e.player,
        parts: e.lane !== undefined
          ? ["打出了 ", c(e.defId, e.level), `（${e.lane + 1} 号位）`]
          : ["施放了 ", c(e.defId, e.level)],
      };
    case "spawn":
      return { kind: "entry", who: e.player, parts: ["召唤了 ", c(e.defId, e.level), `（${e.lane + 1} 号位）`] };
    case "levelUp":
      return { kind: "entry", who: e.player, parts: [c(e.defId, e.toLevel), ` 升级为 L${e.toLevel}`], cls: "lvl" };
    case "discard":
      return { kind: "entry", who: e.player, parts: ["弃置 ", c(e.defId, e.level)], cls: "muted" };
    case "damage":
      return { kind: "entry", who: null, parts: [`${e.target.player === 0 ? "我方" : "敌方"}${(e.target.lane ?? 0) + 1} 号位受到 ${e.amount} 点伤害`], cls: "dmg" };
    case "playerDamage":
      return { kind: "entry", who: null, parts: [`${WHO[e.player]}受到 ${e.amount} 点伤害`], cls: "dmg" };
    case "heal":
      return { kind: "entry", who: null, parts: [`${WHO[e.player]}回复 ${e.amount} 点生命`], cls: "heal" };
    case "healCreature":
      return { kind: "entry", who: null, parts: [`${e.player === 0 ? "我方" : "敌方"}${e.lane + 1} 号位回复 ${e.amount}`], cls: "heal" };
    case "buff":
      return { kind: "entry", who: null, parts: [`${e.player === 0 ? "我方" : "敌方"}${e.lane + 1} 号位获得 ${e.attack >= 0 ? "+" : ""}${e.attack}/${e.health >= 0 ? "+" : ""}${e.health}${e.temp ? "（本回合）" : ""}`] };
    case "grantKeyword":
      return { kind: "entry", who: null, parts: [`${e.player === 0 ? "我方" : "敌方"}${e.lane + 1} 号位获得 ${e.keyword}${e.value ? ` ${e.value}` : ""}${e.temp ? "（本回合）" : ""}`] };
    case "negateKeyword":
      return { kind: "entry", who: null, parts: [`${e.player === 0 ? "我方" : "敌方"}${e.lane + 1} 号位失去 ${e.keyword}`] };
    case "moved":
      return { kind: "entry", who: e.player, parts: [`将生物从 ${e.from + 1} 号位移动到 ${e.to + 1} 号位`] };
    case "activated":
      return { kind: "entry", who: e.player, parts: ["发动了生物异能"] };
    case "destroyed": {
      const lvl = laneSnapshot.get(`${e.player}:${e.lane}`)?.level ?? 1;
      return { kind: "entry", who: null, parts: [`${e.player === 0 ? "我方" : "敌方"}${e.lane + 1} 号位的 `, c(e.defId, lvl), " 被消灭"], cls: "death" };
    }
    case "banished":
      return { kind: "entry", who: e.player, parts: [c(e.defId, e.level), " 被移出游戏"], cls: "death" };
    case "rankUp":
      return { kind: "entry", who: e.player, parts: [`升到 Rank ${e.rank}，弃牌堆洗回牌库`], cls: "rank" };
    case "battle":
      return { kind: "entry", who: null, parts: ["⚔ 战斗！"], cls: "battle" };
    case "gameOver":
      return { kind: "entry", who: null, parts: [`游戏结束——${e.winner === 0 ? "你赢了" : "对手赢了"}`], cls: "battle" };
    default:
      return null; // draw / reshuffle / marked / choiceRequest: 略
  }
}

/** Merge consecutive discard lines by the same player into one. */
function mergeDiscards(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.kind === "entry" && e.cls === "muted" && prev?.kind === "entry" && prev.cls === "muted" && prev.who === e.who) {
      prev.parts.push("、", ...e.parts.slice(1));
    } else {
      out.push(e.kind === "entry" ? { ...e, parts: [...e.parts] } : e);
    }
  }
  return out;
}

// ---------- transient visual effects ----------

interface Fx {
  id: number;
  kind: "damage" | "heal" | "playerDamage" | "playerHeal" | "destroyed" | "play" | "cast";
  player?: 0 | 1 | undefined;
  lane?: number | undefined;
  amount?: number | undefined;
  ghost?: { defId: string; level: number } | undefined;
  played?: { defId: string; level: number } | undefined;
}

let fxId = 1;

// ---------- sequential battle planning ----------

const LANE_STEP = 250; // ms between lane resolutions
const LUNGE_MS = 500;  // matches the lunge keyframe duration

interface BattlePlan {
  /** lanes with any visible combat, in order */
  lanes: number[];
  /** expected playerDamage events (lane-timed), in engine emission order */
  hits: { lane: number; player: 0 | 1 }[];
}

/**
 * Predict which lanes fight (and where direct player damage lands) BEFORE the
 * battle action mutates state. Mirrors runBattle's lane loop in the engine;
 * the engine emits events lane-by-lane, the UI just plays them on a timeline.
 */
export function planBattle(game: Game): BattlePlan {
  const s = game.state;
  const lanes: number[] = [];
  const hits: { lane: number; player: 0 | 1 }[] = [];
  for (let lane = 0; lane < 5; lane++) {
    const a = s.players[0].lanes[lane];
    const b = s.players[1].lanes[lane];
    const aFights = !!a && canAttack(a);
    const bFights = !!b && canAttack(b);
    if (!aFights && !bFights) continue;
    const atkA = a ? getStats(game, a).attack : 0;
    const atkB = b ? getStats(game, b).attack : 0;
    const aDeals = aFights && atkA > 0;
    const bDeals = bFights && atkB > 0;
    // defenders hit back when attacked by a creature they can't attack themselves
    const aBack = aFights && !!b && !canAttack(b) && atkB > 0;
    const bBack = bFights && !!a && !canAttack(a) && atkA > 0;
    if (!aDeals && !bDeals && !aBack && !bBack) continue; // nothing visible
    lanes.push(lane);
    if (aFights && a) {
      if (b) {
        if (atkA > 0 && hasKeyword(a, "Breakthrough") && atkA - Math.max(0, b.health - b.damage) > 0) {
          hits.push({ lane, player: 1 });
        }
      } else if (atkA > 0) {
        hits.push({ lane, player: 1 });
      }
    }
    if (bFights && b) {
      if (a) {
        if (atkB > 0 && hasKeyword(b, "Breakthrough") && atkB - Math.max(0, a.health - a.damage) > 0) {
          hits.push({ lane, player: 0 });
        }
      } else if (atkB > 0) {
        hits.push({ lane, player: 0 });
      }
    }
  }
  return { lanes, hits };
}

export function App() {
  const gameRef = useRef<Game>(newGameWith({
    playerHealth: 120, aiHealth: 120, playerDeckId: "uterra", aiDeckId: "tempys",
    aiDifficulty: "hard", aiSpeed: 900, seed: "",
  }));
  const [, setVersion] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([{ kind: "marker", text: "—— 你的回合 ——" }]);
  const [selectedHand, setSelectedHand] = useState<number | null>(null);
  const [hover, setHover] = useState<HoverCard | null>(null);
  const [fx, setFx] = useState<Fx[]>([]);
  const [lunging, setLunging] = useState<number[]>([]); // lanes currently playing their battle lunge
  const [battlePlaying, setBattlePlaying] = useState(false); // sequential battle timeline running
  const [rankGlow, setRankGlow] = useState<0 | 1 | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [endDismissed, setEndDismissed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<"battle" | "decks">("battle");
  const [sfxOn, setSfxOn] = useState(isSfxEnabled());
  const [drag, setDrag] = useState<{ i: number; x: number; y: number } | null>(null);
  const [dragLane, setDragLane] = useState<number | null>(null);
  const [cfg, setCfg] = useState<GameConfig>({
    playerHealth: 120, aiHealth: 120, playerDeckId: "uterra", aiDeckId: "tempys",
    aiDifficulty: "hard", aiSpeed: 900, seed: "",
  });
  const [saveNotice, setSaveNotice] = useState("");
  const aiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fxTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const suppressClick = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const prevLanes = useRef<Map<string, { defId: string; level: number }>>(new Map());
  const game = gameRef.current;
  const s = game.state;
  const me = s.players[HUMAN];
  const ai = s.players[1];
  const myTurn = s.active === HUMAN && s.phase !== "gameOver";

  const snapshotLanes = () => {
    prevLanes.current.clear();
    laneSnapshot.clear();
    for (const p of [0, 1] as const) {
      s.players[p].lanes.forEach((cr, lane) => {
        if (cr) {
          prevLanes.current.set(`${p}:${lane}`, { defId: cr.defId, level: cr.level });
          laneSnapshot.set(`${p}:${lane}`, { defId: cr.defId, level: cr.level });
        }
      });
    }
  };

  /** Full state snapshot for canceling a pending target choice (undo the play). */
  const preActionState = useRef<GameState | null>(null);
  const snapshotForCancel = () => {
    const clone = structuredClone(game.state);
    clone.cards = game.state.cards; // share the read-only defs table
    preActionState.current = clone;
  };
  const cancelPending = () => {
    if (!s.pending || !preActionState.current) return;
    if (aiTimer.current) clearTimeout(aiTimer.current);
    game.state = preActionState.current;
    preActionState.current = null;
    setAiRunning(false);
    setLog((l) => [...l, { kind: "marker", text: "（取消了出牌）" }]);
    setVersion((v) => v + 1);
  };

  const spawnFx = (events: GameEvent[]) => {
    const added: Fx[] = [];
    for (const e of events) {
      if (e.type === "damage" && e.amount > 0) {
        added.push({ id: fxId++, kind: "damage", player: e.target.player, lane: e.target.lane, amount: e.amount });
      } else if (e.type === "playerDamage" && e.amount > 0) {
        added.push({ id: fxId++, kind: "playerDamage", player: e.player, amount: e.amount });
      } else if (e.type === "heal" && e.amount > 0) {
        added.push({ id: fxId++, kind: "playerHeal", player: e.player, amount: e.amount });
      } else if (e.type === "healCreature" && e.amount > 0) {
        added.push({ id: fxId++, kind: "heal", player: e.player, lane: e.lane, amount: e.amount });
      } else if (e.type === "destroyed") {
        const ghost = prevLanes.current.get(`${e.player}:${e.lane}`);
        added.push({ id: fxId++, kind: "destroyed", player: e.player, lane: e.lane, ghost });
        playSfx("destroy");
      } else if (e.type === "play" || e.type === "spawn") {
        const isSpell = e.type === "play" && e.lane === undefined;
        added.push({
          id: fxId++, kind: isSpell ? "cast" : "play",
          player: e.player, lane: e.lane, played: { defId: e.defId, level: e.level },
        });
        playSfx("play");
      } else if (e.type === "rankUp") {
        setRankGlow(e.player);
        setTimeout(() => setRankGlow(null), 1200);
        playSfx("rankUp");
      }
    }
    if (added.length) {
      setFx((old) => [...old, ...added]);
      const ids = new Set(added.map((f) => f.id));
      setTimeout(() => setFx((old) => old.filter((f) => !ids.has(f.id))), 1100);
    }
  };

  /** Timer helper tracked for cleanup on restart/unmount. */
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      fxTimers.current = fxTimers.current.filter((x) => x !== t);
      fn();
    }, ms);
    fxTimers.current.push(t);
  };
  const clearFxTimers = () => {
    for (const t of fxTimers.current) clearTimeout(t);
    fxTimers.current = [];
  };

  /**
   * Play a battle lane-by-lane: each fighting lane lunges and shows its damage
   * numbers ~250ms apart; leftovers (deaths-trigger spawns, rank ups, game over)
   * play after the last lane; onDone fires when the show is over.
   */
  const playBattleFx = (events: GameEvent[], plan: BattlePlan, onDone: () => void) => {
    const perLane = new Map<number, GameEvent[]>();
    const tail: GameEvent[] = [];
    const hits = [...plan.hits];
    const toLane = (lane: number, e: GameEvent) => {
      const arr = perLane.get(lane) ?? [];
      arr.push(e);
      perLane.set(lane, arr);
    };
    let pastBattle = false;
    for (const e of events) {
      if (e.type === "battle") { pastBattle = true; continue; }
      if (!pastBattle) { tail.push(e); continue; }
      if (e.type === "damage" && e.target.lane !== undefined && plan.lanes.includes(e.target.lane)) {
        toLane(e.target.lane, e);
      } else if ((e.type === "healCreature" || e.type === "destroyed") && plan.lanes.includes(e.lane)) {
        toLane(e.lane, e);
      } else if (e.type === "playerDamage") {
        // playerDamage carries no lane; consume the predicted hits in order for timing
        const hi = hits.findIndex((h) => h.player === e.player);
        if (hi >= 0) {
          toLane(hits[hi]!.lane, e);
          hits.splice(hi, 1);
        } else {
          tail.push(e);
        }
      } else {
        tail.push(e);
      }
    }
    setBattlePlaying(true);
    plan.lanes.forEach((lane, i) => {
      later(i * LANE_STEP, () => {
        setLunging((old) => [...old, lane]);
        later(LUNGE_MS, () => setLunging((old) => old.filter((l) => l !== lane)));
        const evs = perLane.get(lane);
        if (evs?.length) spawnFx(evs);
        playSfx("clash");
      });
    });
    later(plan.lanes.length * LANE_STEP + 150, () => {
      spawnFx(tail);
      setBattlePlaying(false);
      onDone();
    });
  };

  const bump = (events: GameEvent[], plan: BattlePlan | null, onDone: () => void) => {
    const entries = events.map(describeEvent).filter((x): x is LogEntry => x !== null);
    setLog((l) => mergeDiscards([...l, ...entries]).slice(-200));
    setVersion((v) => v + 1);
    if (plan && plan.lanes.length > 0 && events.some((e) => e.type === "battle")) {
      playBattleFx(events, plan, onDone);
    } else {
      spawnFx(events);
      onDone();
    }
  };

  /** Step the AI one action at a time so its turn is visible (animated). */
  const scheduleAiStep = (steps = 0) => {
    setAiRunning(true);
    aiTimer.current = setTimeout(() => {
      snapshotLanes();
      const plan = planBattle(game); // cheap; only used if this step is a battle
      const step = stepAi(game, HUMAN);
      if (step.done) {
        setAiRunning(false);
        if (steps > 0) setLog((l) => [...l, { kind: "marker", text: "—— 你的回合 ——" }]);
        bump([], null, () => {});
        return;
      }
      if (steps === 0) setLog((l) => [...l, { kind: "marker", text: "—— 对方回合 ——" }]);
      bump(step.events, plan, () => scheduleAiStep(steps + 1));
    }, uiSettings.aiSpeed);
  };

  useEffect(() => () => {
    if (aiTimer.current) clearTimeout(aiTimer.current);
    clearFxTimers();
  }, []);

  // auto-scroll history to the newest entry
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // dismiss hover on turn change
  useEffect(() => setHover(null), [s.turnNumber]);

  const afterHumanAction = (events: GameEvent[], plan: BattlePlan | null = null) => {
    bump(events, plan, () => scheduleAiStep());
  };

  const pending = s.pending;
  const inputLocked = !myTurn || !!pending || aiRunning || battlePlaying;

  const clickHand = (i: number) => {
    if (inputLocked) return;
    setSelectedHand(selectedHand === i ? null : i);
  };

  /** Play a creature from hand to a lane (shared by click-select and drag-drop). */
  const playCreatureAt = (i: number, lane: number) => {
    if (inputLocked) return;
    const inst = me.hand[i];
    if (!inst || !CARDS[inst.defId]?.types.includes("Creature")) return;
    snapshotLanes();
    snapshotForCancel();
    try {
      afterHumanAction(applyAction(game, { type: "playCard", handIndex: i, lane }));
    } catch { /* illegal */ }
    if (!game.state.pending) preActionState.current = null;
    setSelectedHand(null);
  };

  const clickLane = (lane: number) => {
    if (inputLocked) return;
    if (selectedHand !== null) playCreatureAt(selectedHand, lane);
    setSelectedHand(null);
  };

  /** Player-row lane under a screen point, if any (drag-drop target). */
  const laneFromPoint = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y);
    const slot = el?.closest("[data-drop-lane]");
    if (!slot) return null;
    const v = Number(slot.getAttribute("data-drop-lane"));
    return Number.isInteger(v) ? v : null;
  };

  /** Pointer-based drag: creatures can be dragged from hand onto a lane. */
  const onHandPointerDown = (e: ReactPointerEvent, i: number) => {
    if (e.button !== 0 || inputLocked) return;
    const inst = me.hand[i];
    if (!inst || !CARDS[inst.defId]?.types.includes("Creature")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        active = true;
        setSelectedHand(null);
        setHover(null);
      }
      setDrag({ i, x: ev.clientX, y: ev.clientY });
      setDragLane(laneFromPoint(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!active) return; // plain click — let onClick handle it
      // Swallow the click fired after this drag (it may land on a common
      // ancestor instead of the card, so auto-clear after this event tick).
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      const lane = laneFromPoint(ev.clientX, ev.clientY);
      setDrag(null);
      setDragLane(null);
      if (lane !== null) playCreatureAt(i, lane);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const playSpell = (i: number) => {
    if (inputLocked) return;
    snapshotLanes();
    snapshotForCancel();
    try {
      afterHumanAction(applyAction(game, { type: "playCard", handIndex: i }));
    } catch { /* illegal */ }
    if (!game.state.pending) preActionState.current = null;
    setSelectedHand(null);
  };

  const levelUpFromHand = (i: number) => {
    if (inputLocked) return;
    try {
      afterHumanAction(applyAction(game, { type: "discardToLevel", handIndex: i }));
    } catch { /* illegal: no plays left */ }
    setSelectedHand(null);
  };

  const answerChoice = (targetUid?: number, accepted = true, handIndex?: number) => {
    if (!pending) return;
    snapshotLanes();
    afterHumanAction(applyChoice(game, {
      id: pending.request.id, accepted,
      ...(targetUid !== undefined ? { targetUid } : {}),
      ...(handIndex !== undefined ? { handIndex } : {}),
    }));
  };

  const restart = () => {
    if (aiTimer.current) clearTimeout(aiTimer.current);
    clearFxTimers();
    gameRef.current = newGameWith(cfg);
    setLog([{ kind: "marker", text: "—— 你的回合 ——" }]);
    setFx([]);
    setLunging([]);
    setBattlePlaying(false);
    setDrag(null);
    setDragLane(null);
    setSelectedHand(null);
    setHover(null);
    setAiRunning(false);
    setEndDismissed(false);
    setShowSettings(false);
    setVersion((v) => v + 1);
  };

  const doSave = () => {
    setSaveNotice(saveGame(game) ? "已保存当前对局" : "保存失败");
    setTimeout(() => setSaveNotice(""), 2000);
  };

  const doLoad = () => {
    const loaded = loadGame();
    if (!loaded) {
      setSaveNotice("没有可读取的存档");
      setTimeout(() => setSaveNotice(""), 2000);
      return;
    }
    if (aiTimer.current) clearTimeout(aiTimer.current);
    clearFxTimers();
    gameRef.current = loaded;
    setLog([{ kind: "marker", text: "—— 读取存档 ——" }]);
    setFx([]);
    setLunging([]);
    setBattlePlaying(false);
    setDrag(null);
    setDragLane(null);
    setSelectedHand(null);
    setHover(null);
    setAiRunning(false);
    setEndDismissed(loaded.state.phase === "gameOver");
    setShowSettings(false);
    setVersion((v) => v + 1);
  };

  const choiceTargets = new Set(pending?.request.options ?? []);
  const deckOpts = showSettings ? getDeckOptions() : [];

  // pending choice that the human must answer with a creature target
  const TARGET_KINDS = ["friendlyCreature", "enemyCreature", "anyCreature", "anyCreatureOrPlayer"];
  const targeting = !!pending && choiceOwner(game) === HUMAN && TARGET_KINDS.includes(pending.request.kind);
  const targetingId = targeting && pending ? pending.request.id : null;

  // "pick a target" cue whenever a new human target choice appears
  useEffect(() => {
    if (targetingId) playSfx("select");
  }, [targetingId]);

  // Esc cancels a cancelable pending play (undo via the pre-action snapshot)
  useEffect(() => {
    if (!pending) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPending();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pending]);

  return (
    <div className="app">
      <div className="main">
      <header>
        <h1>SolForge Clone</h1>
        <nav className="tabs">
          <button className={`tab ${view === "battle" ? "active" : ""}`} onClick={() => setView("battle")}>对战</button>
          <button className={`tab ${view === "decks" ? "active" : ""}`} onClick={() => setView("decks")}>组牌器</button>
        </nav>
        {view === "battle" && (
          <div className="status">
            <span>回合 {s.turnNumber}</span>
            <span className={rankGlow === HUMAN ? "rank-glow" : ""}>我方 Rank {me.rank}（{me.turnInRank}/4）</span>
            <span className={rankGlow === 1 ? "rank-glow" : ""}>对方 Rank {ai.rank}</span>
            <span>行动 {s.playsLeft}/2</span>
            <button className="settings-btn" onClick={() => setShowSettings(true)}>⚙ 设置</button>
          </div>
        )}
      </header>

      <div style={{ display: view === "battle" ? "block" : "none" }}>
      <div className="board"
        onClick={(e) => {
          // blank click while targeting cancels the pending play (valid targets stopPropagation)
          if (!pending || !preActionState.current) return;
          if ((e.target as HTMLElement).closest(".middle")) return;
          cancelPending();
        }}
        onContextMenu={(e) => {
          if (pending && preActionState.current) {
            e.preventDefault();
            cancelPending();
          }
        }}>
        <PlayerPlate player={ai} side={1} />
        <LaneRow creatures={ai.lanes} game={game} enemy lunging={lunging}
          hoverable
          onHover={setHover}
          highlight={pending ? choiceTargets : null}
          onSlotClick={pending ? (uid) => answerChoice(uid) : undefined} />
        <div className="middle">
          {aiRunning && s.phase !== "gameOver" && <span className="ai-thinking">对方行动中…</span>}
          {battlePlaying && <span className="ai-thinking">战斗中…</span>}
          <button disabled={inputLocked || s.battlesLeft <= 0}
            onClick={() => {
              snapshotLanes();
              const plan = planBattle(game);
              let events: GameEvent[];
              try {
                events = applyAction(game, { type: "battle" });
              } catch { return; }
              afterHumanAction(events, plan);
            }}>
            ⚔ Battle
          </button>
          <button disabled={inputLocked}
            onClick={() => { snapshotLanes(); afterHumanAction(applyAction(game, { type: "endTurn" })); }}>
            结束回合
          </button>
          {s.phase === "gameOver" && (
            <div className="gameover">{s.winner === HUMAN ? "你赢了！" : s.winner === 1 ? "你输了" : "平局"}</div>
          )}
        </div>
        <LaneRow creatures={me.lanes} game={game} lunging={lunging}
          hoverable
          droppable
          dropLane={dragLane}
          onHover={setHover}
          highlight={pending ? choiceTargets : null}
          onLaneClick={clickLane}
          onSlotClick={pending ? (uid) => answerChoice(uid) : undefined} />
        <PlayerPlate player={me} side={0} />
        <FxLayer fx={fx} />
        {targeting && pending && <TargetArrow pending={pending} />}
      </div>

      {pending && (
        <div className="choice-bar">
          <span>{pending.request.prompt}</span>
          {pending.request.kind === "anyCreatureOrPlayer" && (
            <>
              <button onClick={() => answerChoice(-2)}>对方玩家</button>
              <button onClick={() => answerChoice(-1)}>我方玩家</button>
            </>
          )}
          {pending.request.optional && <button onClick={() => answerChoice(undefined, false)}>跳过</button>}
          {pending.request.kind === "yesNo" && (
            <>
              <button onClick={() => answerChoice(undefined, true)}>是</button>
              <button onClick={() => answerChoice(undefined, false)}>否</button>
            </>
          )}
          {(pending.request.kind === "cardInHand" || pending.request.kind === "cardInDiscard") && (
            <span className="hint">（点击下方候选牌选择）</span>
          )}
          {preActionState.current !== null && (
            <button className="cancel" onClick={cancelPending}>✕ 取消出牌</button>
          )}
          {pending.request.kind !== "cardInHand" && pending.request.kind !== "cardInDiscard" && (
            <span className="hint">（高亮生物可作为目标）</span>
          )}
        </div>
      )}

      {pending && (pending.request.kind === "cardInHand" || pending.request.kind === "cardInDiscard") && (
        <div className="choice-cards">
          {(pending.request.options ?? []).map((idx) => {
            const pile = pending.request.kind === "cardInHand" ? me.hand : me.discard;
            const inst = pile[idx];
            const def = inst && CARDS[inst.defId];
            if (!inst || !def) return null;
            return (
              <CardFace key={inst.uid} defId={def.id} level={inst.level}
                selected={false}
                onHover={setHover}
                onClick={() => answerChoice(undefined, true, idx)} />
            );
          })}
        </div>
      )}

      <div className="hand">
        {me.hand.map((inst, i) => {
          const def = CARDS[inst.defId]!;
          const isCreature = def.types.includes("Creature");
          return (
            <CardFace key={inst.uid} defId={def.id} level={inst.level}
              selected={selectedHand === i}
              onHover={setHover}
              onPointerDown={(e) => onHandPointerDown(e, i)}
              onLevelUp={myTurn && !pending && !aiRunning && s.playsLeft > 0 ? () => levelUpFromHand(i) : undefined}
              onClick={() => {
                if (suppressClick.current) { suppressClick.current = false; return; }
                if (isCreature) clickHand(i); else playSpell(i);
              }} />
          );
        })}
      </div>

      {drag && (() => {
        const inst = me.hand[drag.i];
        const def = inst && CARDS[inst.defId];
        if (!inst || !def) return null;
        const art = artUrl(def, inst.level);
        return (
          <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
            {art && <img src={art} alt={def.name} draggable={false} />}
            <div className="fx-play-name">L{inst.level} {def.name}</div>
          </div>
        );
      })()}

      {showSettings && (
        <div className="end-overlay" onClick={() => setShowSettings(false)}>
          <div className="end-panel settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="end-title settings-title">设置</div>

            <div className="set-row">
              <label>我方血量</label>
              <input type="number" min={1} max={999} value={cfg.playerHealth}
                onChange={(e) => setCfg({ ...cfg, playerHealth: Math.max(1, Number(e.target.value) || 120) })} />
            </div>

            <div className="set-row">
              <label>对方血量</label>
              <input type="number" min={1} max={999} value={cfg.aiHealth}
                onChange={(e) => setCfg({ ...cfg, aiHealth: Math.max(1, Number(e.target.value) || 120) })} />
              <span className="set-hint">双方可不一致（默认各 120）</span>
            </div>

            <div className="set-row">
              <label>我方牌组</label>
              <select value={cfg.playerDeckId} onChange={(e) => setCfg({ ...cfg, playerDeckId: e.target.value })}>
                {deckOpts.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </div>

            <div className="set-row">
              <label>对方牌组</label>
              <select value={cfg.aiDeckId} onChange={(e) => setCfg({ ...cfg, aiDeckId: e.target.value })}>
                {deckOpts.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </div>

            <div className="set-row">
              <label>AI 难度</label>
              <select value={cfg.aiDifficulty}
                onChange={(e) => {
                  const v = e.target.value as "easy" | "hard";
                  setCfg({ ...cfg, aiDifficulty: v });
                  uiSettings.aiDifficulty = v;
                }}>
                <option value="easy">简单</option>
                <option value="hard">困难</option>
              </select>
              <span className="set-hint">即时生效</span>
            </div>

            <div className="set-row">
              <label>AI 速度</label>
              <select value={cfg.aiSpeed}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCfg({ ...cfg, aiSpeed: v });
                  uiSettings.aiSpeed = v;
                }}>
                <option value={400}>快</option>
                <option value={900}>中</option>
                <option value={1600}>慢</option>
              </select>
              <span className="set-hint">即时生效</span>
            </div>

            <div className="set-row">
              <label>音效</label>
              <select value={sfxOn ? "on" : "off"}
                onChange={(e) => {
                  const v = e.target.value === "on";
                  setSfxOn(v);
                  setSfxEnabled(v);
                  if (v) playSfx("select");
                }}>
                <option value="on">开</option>
                <option value="off">关</option>
              </select>
              <span className="set-hint">即时生效</span>
            </div>

            <div className="set-row">
              <label>随机种子</label>
              <input type="text" placeholder="留空 = 随机" value={cfg.seed}
                onChange={(e) => setCfg({ ...cfg, seed: e.target.value })} />
              <span className="set-hint">相同种子 = 相同牌序</span>
            </div>

            <div className="set-actions">
              <button onClick={doSave}>保存当前局</button>
              <button onClick={doLoad} disabled={!hasSave()}>读取存档</button>
              <button className="primary" onClick={restart}>重新开始</button>
              <button onClick={() => setShowSettings(false)}>关闭</button>
            </div>
            {saveNotice && <div className="save-notice">{saveNotice}</div>}
            <div className="set-hint" style={{ marginTop: 8 }}>血量 / 牌组 / 种子在"重新开始"后生效</div>
          </div>
        </div>
      )}

      {hover && <CardDetail hover={hover} />}

      {s.phase === "gameOver" && !endDismissed && (
        <div className="end-overlay" onClick={() => setEndDismissed(true)}>
          <div className="end-panel" onClick={(e) => e.stopPropagation()}>
            <div className="end-title">
              {s.winner === HUMAN ? "胜利！" : s.winner === 1 ? "败北" : "平局"}
            </div>
            <div className="end-buttons">
              <button onClick={() => setEndDismissed(true)}>查看棋盘</button>
              <button className="primary" onClick={restart}>再来一局</button>
            </div>
          </div>
        </div>
      )}
      </div>

      {view === "decks" && <DeckBuilder onBack={() => setView("battle")} />}
      </div>

      {view === "battle" && (
        <aside className="history">
          <div className="history-title">战报</div>
          <div className="history-scroll" ref={historyRef}>
            {log.map((e, i) =>
              e.kind === "marker" ? (
                <div key={i} className="h-marker">{e.text}</div>
              ) : (
                <div key={i} className={`h-entry ${e.cls ?? ""} ${e.who === 1 ? "who-ai" : e.who === 0 ? "who-me" : ""}`}>
                  {e.who !== null && <b>{WHO[e.who]} </b>}
                  {e.parts.map((p, j) =>
                    typeof p === "string" ? (
                      <span key={j}>{p}</span>
                    ) : (
                      <span key={j} className="h-card"
                        onMouseEnter={() => {
                          const def = CARDS[p.defId];
                          if (def) setHover({ def, level: p.level });
                        }}
                        onMouseLeave={() => setHover(null)}>
                        L{p.level} {cardName(p.defId)}
                      </span>
                    ),
                  )}
                </div>
              ),
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

// ---------- subcomponents ----------

function PlayerPlate({ player, side }: { player: { health: number; rank: number }; side: 0 | 1 }) {
  return (
    <div className={`player-plate side-${side}`}>
      <span className="hp">❤ {player.health}</span>
      <span className="rank">Rank {player.rank}</span>
    </div>
  );
}

function FxLayer({ fx }: { fx: Fx[] }) {
  return (
    <div className="fx-layer">
      {fx.map((f) => {
        if ((f.kind === "play" || f.kind === "cast") && f.played) {
          const def = CARDS[f.played.defId];
          if (!def) return null;
          const art = artUrl(def, f.played.level);
          return (
            <div key={f.id}
              className={`fx-play ${f.kind === "cast" ? "fx-cast" : `lane-${f.lane}`} ${f.player === 1 ? "from-enemy" : "from-player"}`}>
              {art && <img src={art} alt={def.name} />}
              <div className="fx-play-name">L{f.played.level} {def.name}</div>
            </div>
          );
        }
        if (f.kind === "destroyed" && f.ghost) {
          const def = CARDS[f.ghost.defId];
          if (!def) return null;
          const art = artUrl(def, f.ghost.level);
          return (
            <div key={f.id} className={`fx-ghost lane-${f.lane} ${f.player === 1 ? "row-enemy" : "row-player"}`}>
              {art && <img src={art} alt="" />}
            </div>
          );
        }
        if (f.kind === "damage" || f.kind === "heal") {
          return (
            <div key={f.id}
              className={`fx-num ${f.kind === "damage" ? "fx-dmg" : "fx-heal"} lane-${f.lane} ${f.player === 1 ? "row-enemy" : "row-player"}`}>
              {f.kind === "damage" ? `-${f.amount}` : `+${f.amount}`}
            </div>
          );
        }
        return (
          <div key={f.id}
            className={`fx-num ${f.kind === "playerDamage" ? "fx-dmg" : "fx-heal"} plate-${f.player}`}>
            {f.kind === "playerDamage" ? `-${f.amount}` : `+${f.amount}`}
          </div>
        );
      })}
    </div>
  );
}

function LaneRow(props: {
  creatures: (CreatureState | null)[];
  game: Game;
  enemy?: boolean;
  lunging?: number[] | undefined;
  hoverable?: boolean;
  highlight?: Set<number> | null;
  /** player row accepts drag-drops; dragLane = lane currently hovered by a drag */
  droppable?: boolean;
  dropLane?: number | null | undefined;
  onHover?: ((h: HoverCard | null) => void) | undefined;
  onLaneClick?: ((lane: number) => void) | undefined;
  onSlotClick?: ((uid: number) => void) | undefined;
}) {
  return (
    <div className={`lane-row ${props.enemy ? "enemy" : ""}`}>
      {props.creatures.map((cr, lane) => {
        const hl = cr && props.highlight?.has(cr.uid);
        return (
          <div key={lane}
            className={`lane-slot ${hl ? "targetable" : ""} ${props.dropLane === lane ? "drop-target" : ""}`}
            {...(cr ? { "data-uid": cr.uid } : {})}
            {...(props.droppable ? { "data-drop-lane": lane } : {})}
            onClick={(e) => {
              if (cr && props.onSlotClick) {
                e.stopPropagation(); // during targeting, board clicks mean "cancel"
                if (props.highlight?.has(cr.uid)) props.onSlotClick(cr.uid);
                return;
              }
              props.onLaneClick?.(lane);
            }}
            onMouseEnter={() => {
              if (!cr || !props.onHover) return;
              const def = CARDS[cr.defId]!;
              const stats = getStats(props.game, cr);
              props.onHover({
                def, level: cr.level,
                live: {
                  attack: stats.attack, health: stats.health, damage: cr.damage,
                  defensive: !isOffensive(cr),
                  keywords: [...cr.keywords, ...cr.tempKeywords, ...cr.staticKeywords].map((k) => k.keyword),
                },
              });
            }}
            onMouseLeave={() => props.onHover?.(null)}>
            {cr
              ? <CreatureCard c={cr} game={props.game} lunging={props.lunging?.includes(lane) ?? false} enemy={!!props.enemy} />
              : <span className="empty">{lane + 1}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Level indicator dots: filled up to the card's current level. */
function LevelPips({ total, level }: { total: number; level: number }) {
  return (
    <span className="pips">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`pip ${i < level ? "on" : ""}`} />
      ))}
    </span>
  );
}

function CreatureCard({ c, game, lunging, enemy }: { c: CreatureState; game: Game; lunging: boolean; enemy: boolean }) {
  const def = CARDS[c.defId]!;
  const stats = getStats(game, c);
  const art = artUrl(def, c.level);
  const ready = isOffensive(c);
  return (
    <div className={`creature faction-${def.faction.toLowerCase()} rarity-${def.rarity.toLowerCase()} ${ready ? "ready" : "defensive"} ${lunging && ready ? (enemy ? "lunge-down" : "lunge-up") : ""}`}>
      <div className="cr-name">
        <span className="cname">L{c.level} {def.name}</span>
        <LevelPips total={def.levels.length} level={c.level} />
      </div>
      <div className="cr-art">
        {art && <img src={art} alt={def.name} draggable={false} />}
        <span className="badge atk">{stats.attack}</span>
        <span className={`badge hp ${c.damage > 0 ? "hurt" : ""}`}>{stats.health - c.damage}</span>
      </div>
      <div className="rarity-bar" />
    </div>
  );
}

function CardFace({ defId, level, selected, onClick, onHover, onLevelUp, onPointerDown }: {
  defId: string; level: number; selected: boolean;
  onClick: () => void;
  onHover: (h: HoverCard | null) => void;
  /** 弃牌升级（discard-to-level）；undefined 表示不可用 */
  onLevelUp?: (() => void) | undefined;
  /** drag-to-play start (hand cards only) */
  onPointerDown?: ((e: ReactPointerEvent) => void) | undefined;
}) {
  const def = CARDS[defId]!;
  const lvl = def.levels.find((l) => l.level === level) ?? def.levels[0]!;
  const art = artUrl(def, level);
  const canLevel = level < def.levels.length;
  return (
    <div className={`card faction-${def.faction.toLowerCase()} rarity-${def.rarity.toLowerCase()} ${selected ? "selected" : ""}`}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onMouseEnter={() => onHover({ def, level })}
      onMouseLeave={() => onHover(null)}>
      <div className="card-name">
        <span className="cname">L{level} {def.name}</span>
        <LevelPips total={def.levels.length} level={level} />
      </div>
      <div className="card-art">
        {art && <img src={art} alt={def.name} draggable={false} />}
        {lvl.attack !== null && (
          <>
            <span className="badge atk">{lvl.attack}</span>
            <span className="badge hp">{lvl.health}</span>
          </>
        )}
      </div>
      {canLevel && onLevelUp && (
        <button className="lv-btn" title={`弃掉这张牌，将 L${level + 1} 版本放入弃牌堆（消耗 1 个行动）`}
          onClick={(e) => { e.stopPropagation(); onLevelUp(); }}>
          ↟ 升级
        </button>
      )}
      <div className="rarity-bar" />
    </div>
  );
}

/** Curved SVG arrow from the pending choice's source to the cursor (Hearthstone-style). */
function TargetArrow({ pending }: { pending: PendingChoice }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);
  if (!pos) return null;
  const r = pending.resume;
  const uid = r.kind === "trigger" || r.kind === "activate" ? r.selfUid : null;
  let el = uid !== null ? document.querySelector(`[data-uid="${uid}"]`) : null;
  if (!el) el = document.querySelector(".choice-bar"); // spells: arrow from the prompt bar
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const sx = b.left + b.width / 2;
  const sy = b.top + b.height / 2;
  const dx = pos.x - sx;
  const dy = pos.y - sy;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(110, Math.max(24, len * 0.25));
  // quadratic control point: perpendicular to the chord, biased upward
  const cx = (sx + pos.x) / 2 + (-dy / len) * bend * 0.6;
  const cy = (sy + pos.y) / 2 + (dx / len) * bend * 0.6 - bend * 0.4;
  return (
    <svg className="target-arrow">
      <defs>
        <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${pos.x} ${pos.y}`} markerEnd="url(#arrowhead)" />
    </svg>
  );
}
