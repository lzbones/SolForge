import { useEffect, useRef, useState } from "react";
import {
  applyAction, applyChoice, getStats, isOffensive,
  type CreatureState, type Game, type GameEvent, type GameState,
} from "@solforge/engine";
import {
  CARDS, getDeckOptions, hasSave, loadGame, newGameWith, saveGame, stepAi, uiSettings,
  type GameConfig,
} from "./controller.js";
import { artUrl, CardDetail, type HoverCard } from "./CardDetail.js";
import { DeckBuilder } from "./DeckBuilder.js";

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
  const [battling, setBattling] = useState(false);
  const [rankGlow, setRankGlow] = useState<0 | 1 | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [endDismissed, setEndDismissed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<"battle" | "decks">("battle");
  const [cfg, setCfg] = useState<GameConfig>({
    playerHealth: 120, aiHealth: 120, playerDeckId: "uterra", aiDeckId: "tempys",
    aiDifficulty: "hard", aiSpeed: 900, seed: "",
  });
  const [saveNotice, setSaveNotice] = useState("");
  const aiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      } else if (e.type === "play" || e.type === "spawn") {
        const isSpell = e.type === "play" && e.lane === undefined;
        added.push({
          id: fxId++, kind: isSpell ? "cast" : "play",
          player: e.player, lane: e.lane, played: { defId: e.defId, level: e.level },
        });
      } else if (e.type === "battle") {
        setBattling(true);
        setTimeout(() => setBattling(false), 550);
      } else if (e.type === "rankUp") {
        setRankGlow(e.player);
        setTimeout(() => setRankGlow(null), 1200);
      }
    }
    if (added.length) {
      setFx((old) => [...old, ...added]);
      const ids = new Set(added.map((f) => f.id));
      setTimeout(() => setFx((old) => old.filter((f) => !ids.has(f.id))), 1100);
    }
  };

  const bump = (events: GameEvent[]) => {
    spawnFx(events);
    const entries = events.map(describeEvent).filter((x): x is LogEntry => x !== null);
    setLog((l) => mergeDiscards([...l, ...entries]).slice(-200));
    setVersion((v) => v + 1);
  };

  /** Step the AI one action at a time so its turn is visible (animated). */
  const scheduleAiStep = (steps = 0) => {
    setAiRunning(true);
    aiTimer.current = setTimeout(() => {
      snapshotLanes();
      const step = stepAi(game, HUMAN);
      if (step.done) {
        setAiRunning(false);
        if (steps > 0) setLog((l) => [...l, { kind: "marker", text: "—— 你的回合 ——" }]);
        bump([]);
        return;
      }
      if (steps === 0) setLog((l) => [...l, { kind: "marker", text: "—— 对方回合 ——" }]);
      bump(step.events);
      scheduleAiStep(steps + 1);
    }, uiSettings.aiSpeed);
  };

  useEffect(() => () => { if (aiTimer.current) clearTimeout(aiTimer.current); }, []);

  // auto-scroll history to the newest entry
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // dismiss hover on turn change
  useEffect(() => setHover(null), [s.turnNumber]);

  const afterHumanAction = (events: GameEvent[]) => {
    bump(events);
    scheduleAiStep();
  };

  const pending = s.pending;
  const inputLocked = !myTurn || !!pending || aiRunning;

  const clickHand = (i: number) => {
    if (inputLocked) return;
    setSelectedHand(selectedHand === i ? null : i);
  };

  const clickLane = (lane: number) => {
    if (inputLocked) return;
    if (selectedHand !== null) {
      const inst = me.hand[selectedHand];
      if (inst && CARDS[inst.defId]?.types.includes("Creature")) {
        snapshotLanes();
        snapshotForCancel();
        try {
          afterHumanAction(applyAction(game, { type: "playCard", handIndex: selectedHand, lane }));
        } catch { /* illegal */ }
        if (!game.state.pending) preActionState.current = null;
        setSelectedHand(null);
        return;
      }
    }
    setSelectedHand(null);
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
    gameRef.current = newGameWith(cfg);
    setLog([{ kind: "marker", text: "—— 你的回合 ——" }]);
    setFx([]);
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
    gameRef.current = loaded;
    setLog([{ kind: "marker", text: "—— 读取存档 ——" }]);
    setFx([]);
    setSelectedHand(null);
    setHover(null);
    setAiRunning(false);
    setEndDismissed(loaded.state.phase === "gameOver");
    setShowSettings(false);
    setVersion((v) => v + 1);
  };

  const choiceTargets = new Set(pending?.request.options ?? []);
  const deckOpts = showSettings ? getDeckOptions() : [];

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
      <div className={`board ${battling ? "battling" : ""}`}>
        <PlayerPlate player={ai} side={1} />
        <LaneRow creatures={ai.lanes} game={game} enemy battling={battling}
          hoverable
          onHover={setHover}
          highlight={pending ? choiceTargets : null}
          onSlotClick={pending ? (uid) => answerChoice(uid) : undefined} />
        <div className="middle">
          {aiRunning && s.phase !== "gameOver" && <span className="ai-thinking">对方行动中…</span>}
          <button disabled={inputLocked || s.battlesLeft <= 0}
            onClick={() => { snapshotLanes(); afterHumanAction(applyAction(game, { type: "battle" })); }}>
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
        <LaneRow creatures={me.lanes} game={game} battling={battling}
          hoverable
          onHover={setHover}
          highlight={pending ? choiceTargets : null}
          onLaneClick={clickLane}
          onSlotClick={pending ? (uid) => answerChoice(uid) : undefined} />
        <PlayerPlate player={me} side={0} />
        <FxLayer fx={fx} />
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
              onLevelUp={myTurn && !pending && !aiRunning && s.playsLeft > 0 ? () => levelUpFromHand(i) : undefined}
              onClick={() => (isCreature ? clickHand(i) : playSpell(i))} />
          );
        })}
      </div>

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
  battling?: boolean;
  hoverable?: boolean;
  highlight?: Set<number> | null;
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
            className={`lane-slot ${hl ? "targetable" : ""}`}
            onClick={() => (cr && props.onSlotClick ? props.onSlotClick(cr.uid) : props.onLaneClick?.(lane))}
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
              ? <CreatureCard c={cr} game={props.game} battling={props.battling ?? false} enemy={!!props.enemy} />
              : <span className="empty">{lane + 1}</span>}
          </div>
        );
      })}
    </div>
  );
}

function CreatureCard({ c, game, battling, enemy }: { c: CreatureState; game: Game; battling: boolean; enemy: boolean }) {
  const def = CARDS[c.defId]!;
  const stats = getStats(game, c);
  const art = artUrl(def, c.level);
  const ready = isOffensive(c);
  return (
    <div className={`creature ${ready ? "ready" : "defensive"} ${battling && ready ? (enemy ? "lunge-down" : "lunge-up") : ""}`}>
      {art && <img src={art} alt={def.name} />}
      <div className="name">L{c.level} {def.name}</div>
      <div className="stats">
        <span className="atk">{stats.attack}</span> / <span className={c.damage > 0 ? "hp hurt" : "hp"}>{stats.health - c.damage}</span>
      </div>
    </div>
  );
}

function CardFace({ defId, level, selected, onClick, onHover, onLevelUp }: {
  defId: string; level: number; selected: boolean;
  onClick: () => void;
  onHover: (h: HoverCard | null) => void;
  /** 弃牌升级（discard-to-level）；undefined 表示不可用 */
  onLevelUp?: (() => void) | undefined;
}) {
  const def = CARDS[defId]!;
  const lvl = def.levels.find((l) => l.level === level) ?? def.levels[0]!;
  const art = artUrl(def, level);
  const canLevel = level < def.levels.length;
  return (
    <div className={`card faction-${def.faction.toLowerCase()} ${selected ? "selected" : ""}`}
      onClick={onClick}
      onMouseEnter={() => onHover({ def, level })}
      onMouseLeave={() => onHover(null)}>
      {art && <img src={art} alt={def.name} />}
      <div className="name">L{level} {def.name}</div>
      {lvl.attack !== null && <div className="stats">{lvl.attack} / {lvl.health}</div>}
      {canLevel && onLevelUp && (
        <button className="lv-btn" title={`弃掉这张牌，将 L${level + 1} 版本放入弃牌堆（消耗 1 个行动）`}
          onClick={(e) => { e.stopPropagation(); onLevelUp(); }}>
          ↟ 升级
        </button>
      )}
    </div>
  );
}
