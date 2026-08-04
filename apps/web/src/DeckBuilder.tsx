import { useEffect, useMemo, useRef, useState } from "react";
import type { CardDef } from "@solforge/engine";
import { CARDS, loadSavedDecks, storeSavedDecks, type SavedDeck } from "./controller.js";
import { artUrl, CardDetail, type HoverCard } from "./CardDetail.js";

const FACTION_FILTERS = ["all", "Alloyin", "Nekrium", "Tempys", "Uterra"] as const;
const TYPE_FILTERS = ["all", "Creature", "Spell"] as const;
const RARITY_FILTERS = ["all", "Common", "Rare", "Heroic", "Legendary"] as const;

type FactionFilter = (typeof FACTION_FILTERS)[number];
type TypeFilter = (typeof TYPE_FILTERS)[number];
type RarityFilter = (typeof RARITY_FILTERS)[number];

const FACTION_LABEL: Record<FactionFilter, string> = {
  all: "全部阵营", Alloyin: "Alloyin 机械", Nekrium: "Nekrium 死亡", Tempys: "Tempys 元素", Uterra: "Uterra 自然",
};
const TYPE_LABEL: Record<TypeFilter, string> = { all: "全部类型", Creature: "生物", Spell: "法术" };
const RARITY_LABEL: Record<RarityFilter, string> = {
  all: "全部稀有度", Common: "Common 普通", Rare: "Rare 稀有", Heroic: "Heroic 英雄", Legendary: "Legendary 传说",
};

/** L1 attack/health, or "法术" for spells. */
function l1Stats(def: CardDef): string {
  const l1 = def.levels[0];
  return l1 && l1.attack !== null ? `${l1.attack} / ${l1.health}` : "法术";
}

/** Deck legality problems (empty = legal: exactly 30 cards, <=2 factions, <=3 copies each). */
function validate(counts: Record<string, number>): string[] {
  const msgs: string[] = [];
  const ids = Object.keys(counts);
  const total = ids.reduce((n, id) => n + (counts[id] ?? 0), 0);
  if (total !== 30) msgs.push(`牌组需正好 30 张，当前 ${total} 张`);
  const factions = new Set<string>();
  for (const id of ids) {
    const def = CARDS[id];
    if (def) factions.add(def.faction);
  }
  if (factions.size > 2) msgs.push(`最多 2 个阵营，当前 ${factions.size} 个（${[...factions].join("、")}）`);
  const over = ids.filter((id) => (counts[id] ?? 0) > 3);
  if (over.length) msgs.push(`同名卡超过 3 张：${over.map((id) => CARDS[id]?.name ?? id).join("、")}`);
  const bad = ids.filter((id) => !CARDS[id] || CARDS[id]!.rarity === "Token");
  if (bad.length) msgs.push(`包含不可收藏的卡：${bad.join("、")}`);
  return msgs;
}

export function DeckBuilder({ onBack }: { onBack: () => void }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [faction, setFaction] = useState<FactionFilter>("all");
  const [cardType, setCardType] = useState<TypeFilter>("all");
  const [rarity, setRarity] = useState<RarityFilter>("all");
  const [search, setSearch] = useState("");
  const [hover, setHover] = useState<HoverCard | null>(null);
  const [saved, setSaved] = useState<SavedDeck[]>(() => loadSavedDecks());
  const [deckName, setDeckName] = useState("");
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  /** collectible pool: everything except Token-rarity cards */
  const collection = useMemo(
    () => Object.values(CARDS)
      .filter((def) => def.rarity !== "Token")
      .sort((a, b) => a.faction.localeCompare(b.faction) || a.name.localeCompare(b.name)),
    [],
  );

  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  const problems = validate(counts);

  const flash = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2500);
  };

  const addCard = (id: string) => {
    setCounts((prev) => {
      const n = prev[id] ?? 0;
      if (n >= 3) return prev;
      if (Object.values(prev).reduce((s, c) => s + c, 0) >= 30) return prev;
      return { ...prev, [id]: n + 1 };
    });
  };

  const removeCard = (id: string) => {
    setCounts((prev) => {
      const n = prev[id] ?? 0;
      if (n === 0) return prev;
      const next = { ...prev };
      if (n === 1) delete next[id];
      else next[id] = n - 1;
      return next;
    });
  };

  const filtered = collection.filter(
    (def) =>
      (faction === "all" || def.faction === faction)
      && (cardType === "all" || def.types.includes(cardType))
      && (rarity === "all" || def.rarity === rarity)
      && (search.trim() === "" || def.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  const deckRows = Object.entries(counts)
    .map(([id, n]) => ({ id, n, def: CARDS[id] }))
    .sort((a, b) => (a.def?.name ?? a.id).localeCompare(b.def?.name ?? b.id));

  const saveDeck = () => {
    const name = deckName.trim();
    if (!name) { flash("请先输入牌组名称"); return; }
    const cards: string[] = [];
    for (const { id, n } of deckRows) for (let i = 0; i < n; i++) cards.push(id);
    const next = [...saved.filter((d) => d.name !== name), { name, cards }];
    if (!storeSavedDecks(next)) { flash("保存失败：localStorage 不可用"); return; }
    setSaved(next);
    setLoadedName(name);
    flash(`已保存「${name}」（${cards.length} 张）`);
  };

  const loadDeck = (d: SavedDeck) => {
    const next: Record<string, number> = {};
    for (const id of d.cards) {
      const def = CARDS[id];
      if (def && def.rarity !== "Token") next[id] = (next[id] ?? 0) + 1;
    }
    setCounts(next);
    setDeckName(d.name);
    setLoadedName(d.name);
    flash(`已载入「${d.name}」`);
  };

  const deleteDeck = (name: string) => {
    const next = saved.filter((d) => d.name !== name);
    if (!storeSavedDecks(next)) { flash("删除失败：localStorage 不可用"); return; }
    setSaved(next);
    if (loadedName === name) setLoadedName(null);
    flash(`已删除「${name}」`);
  };

  return (
    <div className="db">
      <div className="db-filters">
        <select value={faction} onChange={(e) => setFaction(e.target.value as FactionFilter)}>
          {FACTION_FILTERS.map((f) => <option key={f} value={f}>{FACTION_LABEL[f]}</option>)}
        </select>
        <select value={cardType} onChange={(e) => setCardType(e.target.value as TypeFilter)}>
          {TYPE_FILTERS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select value={rarity} onChange={(e) => setRarity(e.target.value as RarityFilter)}>
          {RARITY_FILTERS.map((r) => <option key={r} value={r}>{RARITY_LABEL[r]}</option>)}
        </select>
        <input type="text" placeholder="搜索卡名…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="db-hint">点击加入牌组，右键或 − 减一张（每卡 ≤3 张）</span>
        <button onClick={onBack}>← 返回对战</button>
      </div>

      <div className="db-wrap">
        <div className="db-grid">
          {filtered.map((def) => {
            const n = counts[def.id] ?? 0;
            const art = artUrl(def, 1);
            return (
              <div key={def.id}
                className={`db-card faction-${def.faction.toLowerCase()} ${n > 0 ? "in-deck" : ""} ${n >= 3 ? "maxed" : ""}`}
                onClick={() => addCard(def.id)}
                onContextMenu={(e) => { e.preventDefault(); removeCard(def.id); }}
                onMouseEnter={() => setHover({ def, level: 1 })}
                onMouseLeave={() => setHover(null)}>
                {n > 0 && <div className="db-count">{n}/3</div>}
                {art && <img src={art} alt={def.name} loading="lazy" />}
                <div className="name">{def.name}</div>
                <div className="stats">{l1Stats(def)}</div>
                <div className="db-card-btns">
                  <button title="减一张" onClick={(e) => { e.stopPropagation(); removeCard(def.id); }}>−</button>
                  <button title="加一张" disabled={n >= 3 || total >= 30}
                    onClick={(e) => { e.stopPropagation(); addCard(def.id); }}>＋</button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="db-empty">没有符合筛选条件的卡牌</div>}
        </div>

        <div className="db-deck">
          <div className="db-deck-title">
            <span>当前牌组　{total}/30</span>
            <button onClick={() => setCounts({})} disabled={total === 0}>清空</button>
          </div>

          <div className="db-msgs">
            {problems.length === 0
              ? <div className="ok">✓ 牌组合法，可在设置中选择使用</div>
              : problems.map((m) => <div key={m} className="err">✕ {m}</div>)}
          </div>

          <div className="db-rows">
            {deckRows.map(({ id, n, def }) => (
              <div key={id} className="db-row"
                onContextMenu={(e) => { e.preventDefault(); removeCard(id); }}
                onMouseEnter={() => def && setHover({ def, level: 1 })}
                onMouseLeave={() => setHover(null)}>
                <span className="rn">{n}×</span>
                <span className="rname">{def?.name ?? id}</span>
                <span className="rstats">{def ? l1Stats(def) : "未知卡"}</span>
                <button title="减一张" onClick={() => removeCard(id)}>−</button>
                <button title="加一张" disabled={n >= 3 || total >= 30} onClick={() => addCard(id)}>＋</button>
              </div>
            ))}
            {deckRows.length === 0 && <div className="db-empty">从左侧点击卡牌加入牌组</div>}
          </div>

          <div className="db-save-row">
            <input type="text" placeholder="牌组名称" value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveDeck(); }} />
            <button className="primary" onClick={saveDeck} disabled={total === 0}>保存</button>
          </div>
          {notice && <div className="db-notice">{notice}</div>}

          <div className="db-saved">
            <div className="db-saved-title">已存牌组（{saved.length}）</div>
            {saved.map((d) => (
              <div key={d.name} className={`db-saved-row ${loadedName === d.name ? "current" : ""}`}>
                <span className="sname">{d.name}（{d.cards.length} 张）</span>
                <button onClick={() => loadDeck(d)}>载入</button>
                <button onClick={() => deleteDeck(d.name)}>删除</button>
              </div>
            ))}
            {saved.length === 0 && <div className="db-empty">尚无保存的牌组；保存后可在设置的牌组下拉中选择</div>}
          </div>
        </div>
      </div>

      {hover && <CardDetail hover={hover} />}
    </div>
  );
}
