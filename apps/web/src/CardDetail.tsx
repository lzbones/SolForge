import { displayText, type CardDef } from "@solforge/engine";

/** Card art URL: /cards/<Name sanitized>/<image file> (assets/ is vite's publicDir). */
export function artUrl(def: CardDef, level: number): string | null {
  const img = def.images[Math.min(level, def.images.length) - 1];
  if (!img) return null;
  return `/cards/${def.name.replace(/[^\w\- ]/g, "_")}/${img.replace(/'/g, "_")}`;
}

// ---------- hover detail ----------

export interface HoverCard {
  def: CardDef;
  level: number;
  /** live creature overrides (board) */
  live?: { attack: number; health: number; damage: number; defensive: boolean; keywords: string[] };
}

/** Hover detail panel: all levels, full cleaned rules text. */
export function CardDetail({ hover }: { hover: HoverCard }) {
  const { def, live } = hover;
  return (
    <div className={`card-detail faction-${def.faction.toLowerCase()}`}>
      <div className="detail-head">
        <strong>{def.name}</strong>
        <span>{def.faction} · {def.rarity} · {def.types.join("/")}{def.subtypes.length ? ` — ${def.subtypes.join(", ")}` : ""}</span>
      </div>
      {live && (
        <div className="detail-live">
          当前：{live.attack} / {live.health - live.damage}
          {live.defensive && <span className="tag">守备</span>}
          {live.keywords.map((k) => <span key={k} className="tag">{k}</span>)}
        </div>
      )}
      <div className="detail-levels">
        {def.levels.map((l) => {
          const art = artUrl(def, l.level);
          return (
            <div key={l.level} className={`detail-level ${l.level === hover.level ? "current" : ""}`}>
              {art && <img src={art} alt="" />}
              <div className="lv-head">Lv{l.level}{l.attack !== null ? `　${l.attack}/${l.health}` : ""}</div>
              <div className="lv-text">{displayText(l.text) || "（无效果）"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
