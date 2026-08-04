# SolForge 复刻调研报告

> 调研日期：2026-08-02。目标：复刻 Stone Blade Entertainment 的原版数字卡牌游戏 **SolForge**（2012–2016 运营，2017 年 1 月关服）。设计者为 Justin Gary 与 Richard Garfield（万智牌之父）。
>
> 注意区分：**SolForge Fusion**（2022，实体+数字混合版）规则不同（20 牌双阵营融合牌组、中央 Forge 争夺、Forgeborn 英雄技能等），本计划不以其为目标。

---

## 1. 完整规则

来源：[SolForge Wiki - How to Play](https://solforge.fandom.com/wiki/How_to_Play)、[Advanced Rules](https://solforge.fandom.com/wiki/Advanced_Rules)（原始 wikitext 已存至 `research/wiki/`）。

### 1.1 基本设定
- 双方各 **30 张牌**、**120 点生命**。目标：将对手生命降至 0 或以下。
- 战场为 **5 条 lane（ lane 道）**，每条 lane 分上下两个格子（双方各一格），每格最多 1 个生物。
- 无费用/法力系统：每回合抽 5 张，但**只能打出 2 张**（两个"行动点"），回合结束弃掉剩余手牌。

### 1.2 回合结构
1. **回合开始**：触发"回合开始时"效果（Poison/Regenerate 同批次，先 Poison 后 Regenerate，批次结束才结算死亡）；己方生物变为 offensive（进攻态）。
2. **主阶段 1**：可打牌。
3. **战斗（Battle）**：玩家手动按 Battle 按钮触发。
4. **主阶段 2**：可继续打牌（"打牌 / 打牌 / 战斗"三步可任意顺序，共两个行动）。
5. **弃手牌**；若升 rank，弃牌堆洗回牌库。
6. **回合结束效果 + 升 rank 效果**（同批次）。
7. "直到回合结束"效果消失，抽 5 张新牌。

### 1.3 战斗
- 刚打出的生物为 **defensive（守备态）**（牌面有锁链尖刺圈）：不能攻击、不能用 Activate、不能 Mobility，须等一回合。除非有 **Aggressive**。
- 战斗阶段：所有非守备生物对同 lane 对面生物造成伤害（对面无生物则打脸）；被攻击的守备生物会回击。两个守备生物同 lane 不会互相伤害。
- 伤害按 lane 从左到右结算，但在同一批次；生物生命 ≤0 死亡（批次结束才移除）。
- 战斗实际为**三个批次**：①战斗伤害→死亡检查；②伤害触发异能→死亡检查；③死亡触发异能。
- 双方同时 ≤0 血：血低者负；相同则进入 Sudden Death（打到某回合结束一方血更低为止）。

### 1.4 升级（Leveling）—— 游戏核心机制
- 开局牌库中所有牌为 **1 级**。打出一張牌时，其**下一级版本进入你的弃牌堆**。
- 也可以"弃牌升级"：不打出去、消耗 1 个行动把牌弃掉并升级。
- **每 4 回合升 1 个 rank**，弃牌堆洗回牌库，从而能抽到高级牌。
- 洗牌时**高于你当前 rank 等级的牌留在弃牌堆不洗回**（例如 rank 2 时 3 级牌不回库）。
- 大部分牌最高 **3 级**；后期系列少数牌有 **4 级**（如 Cercee, Hand of Varna、Oros, Deepwood's Chosen）。法术最高 3 级。
- 牌库抽空需抽牌时：立即将弃牌堆洗回再继续抽。

### 1.5 组牌规则（Standard）
- 恰好 30 张；**至多 2 个阵营**；同名牌至多 3 张。
- Solbind 牌会在开局时额外往牌库加牌（牌库可因此超过 30）。
- 其他赛制：Unlegendary（无传说）、Unheroic（无传说/英雄）、无同名限制、20 牌、4 阵营 Singleton。

### 1.6 关键词（23 个，定义已抓取至 `research/wiki/kw_*.txt`）
| 关键词 | 效果 |
|---|---|
| Activate | 进攻态时每回合可点击发动一次 |
| Aggressive | 永远处于进攻态（进场当回合即可攻击/发动能力） |
| Allied | 从手牌进场时，若手牌中有指定类型牌则获得后续异能 |
| Ambush | 异能在手牌中生效（仅 4 张 Leyline 生物） |
| Armor X | 每回合防止前 X 点伤害（生物或玩家） |
| Assault | 从手牌进场时若其 lane 无其他生物则获得后续异能 |
| Breakthrough | 进攻时溢出战斗伤害打脸 |
| Consistent | 洗牌时洗入牌库顶 20 张内 |
| Defender | 不能主动发起战斗（不能打脸，仍会回击） |
| Flank | 当此生物移动时触发 |
| Forge | 从手牌进场时获得后续异能 |
| Formation | 打出时两侧相邻格均有友方生物则触发（仅中间格"处于 Formation"） |
| Free | 打出不占两个行动之一（但弃牌升级仍占行动） |
| Mobility X | 进攻态时每回合可移动至多 X 条 lane 一次 |
| Negate | 移除生物的异能且不能再获得 |
| Overload | 打出后移出游戏而非进弃牌堆 |
| Poison X | 每个回合开始受 X 点伤害（可被 Armor 挡） |
| Raid | 回合结束时若 ≥3 个友方生物发起了战斗则触发 |
| Regenerate X | 回合开始回复 X 点生命（不超过当前上限） |
| Solbind | 开局时把列出的牌加入牌库 |
| Spawn | 在随机友方空格放入衍生物 |
| Upgrade | 替换（replace）一个生物进场时获得后续异能 |
| Vengeance | 被消灭时触发 |

### 1.7 高级规则要点（实现引擎时必须注意）
- **批次（Batch）结算**：同一事件触发的一批异能先全部结算，批次结束才做死亡检查。批内顺序：主动方非指向 → 非主动方非指向 → 主动方指向；同组内随机顺序。
- **静态异能**按 lane 从左到右应用（影响 Shardplate Behemoth 这类"攻击=生命"与加攻的叠加顺序）。
- **额外战斗**（Staff of Vaerus、Call the Lightning、Zyx 等）：只在特定效果时重新检查，规则细节见 `research/wiki/Advanced_Rules.txt` Combat 节。
- 复活效果（Lyria / Varna's Pact / Tarsus Deathweaver）有专门细则。
- 游戏时钟：每回合 75 秒，另有 3 分 45 秒一次性储备时间，耗尽判负。

---

## 2. 已发布的全部系列（共 22 个小版本 / 约 747 张牌）

来源：[Card Sets](https://solforge.fandom.com/wiki/Card_Sets)（已存档 `research/wiki/Card_Sets.txt`）。

| 编号 | 名称 | 发布日期 | 牌数 |
|---|---|---|---|
| 1.0 | Alpha | 2012–2013 | 184 |
| 1.5 | （补丁） | | 24 |
| 2.0 | Rise of the Forgeborn | 2014-03-21 | 100 |
| 2.1–2.3 | RotF 三次补丁 | 2014-05 ~ 07 | 20+20+16 |
| 3.0 | Secrets of Solis | 2014-08-19 | 60 |
| 3.1 | SoS: Unveiled | 2014-09-22 | 7 |
| 4.0 | Imprisoned Heralds | 2014-11-11 | 60 |
| 4.1 / 4.2 | Unchained / Arisen | 2014-12 / 2015-01 | 8+8 |
| 5.0 | Reign of Varna | 2015-02-25 | 48 |
| 5.1 / 5.2 | Darkness Rising / Immortal King | 2015-03 / 05 | 8+4 |
| 6.0 | Darkforge Uprising | 2015-06-28 | 48 |
| 6.1 / 6.2 | Factions United / Prelude to War | 2015-08 / 09 | 8+8 |
| 7.0 | Raiders Unchained | 2016-05-31 | 48 |
| 7.1–7.3 | Front Line / Ancient Grudge / Rise to Power | 2016-07 ~ 11 | 8+8+8 |

四个阵营：**Alloyin**（机械/蓝）、**Nekrium**（死亡/黑）、**Tempys**（元素/红）、**Uterra**（自然/绿）。
稀有度四档：Common（绿）/ Rare（蓝）/ Heroic（黄）/ Legendary（红）。牌类型：Creature（有种族 subtype）与 Spell。

**实测可机读的卡牌枚举**（wiki 分类，已存 `research/wiki/cat_*.json`）：
- Category:Alloyin = 181 张、Category:Nekrium = 188、Category:Tempys = 189、Category:Uterra = 189，合计 **747 张**。

---

## 3. 卡牌数据源（机读）

**最佳来源：SolForge Wiki 的单卡页面**，结构化模板 `{{CardTable}}`，含全部所需字段（示例已验证，见 `research/wiki/` 抓取记录）：

```
name, faction, rarity, release(所在系列), type1..4, subtype1..4,
text1..text4（每级规则文字，含 {{Poison|2}} 等模板标记）,
attack1..4 / health1..4（每级攻防）,
image（每级卡图文件名 gallery）
```

抓取方法（已实测可行）：
1. 用 MediaWiki API 拉 4 个阵营 Category 的成员列表（`action=query&list=categorymembers&cmtitle=Category:Alloyin&cmlimit=500`）。
2. 逐卡取 `action=parse&page=<牌名>&prop=wikitext`，解析 `{{CardTable}}` 模板即可得到 JSON。
3. 注意：直接抓 HTML 会 403，必须走 `api.php` 并带 User-Agent。

风险点：部分牌的效果文字是自然语言，需要逐张实现效果脚本；个别后期牌有第 4 级。

---

## 4. 图片与素材来源

### 4.1 卡图（每级一张，已验证）
- Wiki 每卡每级都有图，如 `Demara's Pitguard 1.jpg`（337×337 PNG/JPG）。
- 批量取 URL：`api.php?action=query&titles=File:<文件名>&prop=imageinfo&iiprop=url`，CDN 域名 `static.wikia.nocookie.net`（可直接下载）。
- 另有 Alternate Art（AA）版本。

### 4.2 游戏客户端素材（卡牌框、图标、棋盘）
原版是 Unity 游戏，Steam 版安装目录内含现成素材（来自 [riddle-me-solforge](https://github.com/skermes/riddle-me-solforge) README 的实证）：
```
Steam/steamapps/common/SolForge/Game/compiled/assets/art/
├── card_art_small/        全部卡图
├── card_frames_small/     卡框：lvl1~lvl4 × {death,nature,elemental,mechanical} × {creature,spell}
└── （关键词图标、棋盘、UI 图等）
```
若能找到 Steam 旧客户端或社区素材备份，这是最完整的素材来源。GitHub 上另有若干粉丝项目（riddle-me-solforge 等）可参考卡框拼卡方式。

### 4.3 参考用 UI 截图/视频
- [Steam SolForge Fusion 页面](https://store.steampowered.com/app/2400960/SolForge_Fusion/)（Fusion 的 UI 与原版布局相似，可作参考）
- YouTube "SolForge gameplay"、[Giant Bomb 条目](https://www.giantbomb.com/sol-forge/3030-42040/)、[UI 评测文](http://blog.andreashubert.com/?p=103)
- Wiki 的界面标注图（How to Play 页 PlayZones.jpg）：战场、双方格子、生命/等级/名字、手牌、Battle 按钮。

### 4.4 版权提示
所有卡图、卡框、美术版权归 Stone Blade Entertainment。个人学习用途的本地复刻一般可接受；**公开发布/商用有风险**。安全做法：程序与素材分离，素材不进公开仓库，发布版用占位图或自制美术。

---

## 5. UI 规格摘要（复刻用）

**主界面**：主页/菜单、收藏管理、Deck Builder、商店、Draft、对战。

**对战界面**（据 wiki 界面图与评测）：
- 中央 5 lane 战场，上方对手 5 格、下方我方 5 格；
- 对手生命/等级(rank)/名字在上方，我方的在下方；
- 底部为手牌区；右侧 Battle 按钮；
- 打出牌升级、rank 进度（每 4 回合）需有明确指示；
- 生物守备态有锁链圈标识；右键/长按查看牌的各级形态；
- 目标选择用拖拽箭头；战斗按 lane 依次碰撞动画。

**牌面布局**：阵营色边框 + 中央阵营图标、右上角等级标记、底部稀有度色条、攻/血数字位、完整视图顶部写稀有度。

---

## 6. 关键参考链接
- Wiki 主站：https://solforge.fandom.com/wiki/SolForge_Wiki
- 规则：https://solforge.fandom.com/wiki/How_to_Play ・ https://solforge.fandom.com/wiki/Advanced_Rules
- 系列：https://solforge.fandom.com/wiki/Card_Sets
- 单卡模板示例：https://solforge.fandom.com/wiki/Demara%27s_Pitguard
- 客户端素材线索：https://github.com/skermes/riddle-me-solforge
- 原始抓取存档：本仓库 `research/wiki/`
