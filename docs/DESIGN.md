# SolForge 复刻 设计计划

> 依据 `docs/RESEARCH.md` 的调研。目标：复刻原版 SolForge（非 Fusion）。
> 已定决策：**Web (TypeScript)** 技术栈 / **单机 + AI 对手** 先行 / **Set 1（Alpha, 184 张）先行**。

---

## 1. 总体架构

```
solforge-clone/
├── packages/
│   ├── engine/      # 纯 TS 规则引擎（无 DOM、无框架依赖，可跑在 Node 里测试）
│   ├── data/        # 卡牌 JSON（爬虫产物）+ 每张牌的效果脚本
│   └── ai/          # AI 对手（启发式 → MCTS）
├── apps/
│   └── web/         # React + CSS/Canvas 的游戏前端
├── tools/
│   └── scraper/     # wiki 爬虫：卡数据 JSON + 卡图下载
├── assets/          # 素材（不进 git 公开仓库，见版权说明）
└── docs/
```

关键原则：**引擎与表现完全分离**。引擎输入玩家指令（打牌/弃牌升级/按 Battle/用 Activate），输出事件流；前端只渲染事件。这样引擎可以在 Node 里用脚本跑整局对战做自动化测试，AI 也直接基于引擎做模拟。

## 2. 规则引擎设计（核心难点）

### 2.1 数据模型
- `CardDef`（静态定义）：id、name、faction、rarity、set、type(creature/spell)、subtype、levels[1..4] = { attack, health, keywords, text, effectScriptId }。
- `CardInstance`（对局中的牌）：defId、当前等级、owner。
- `CreatureOnBoard`：instance、lane、attack/health 当前值、defensive 标记、伤害、关键字集合、临时效果列表。
- `GameState`：双方 { hp, rank, turnInRank, deck, hand, discard, lanes[5], removed }、activePlayer、phase、rng 种子。

### 2.2 事件 + 批次（Batch）系统
严格按照高级规则实现（`research/wiki/Advanced_Rules.txt`）：
1. 所有效果以事件表示：`PlayCard / DealDamage / Heal / Buff / Move / Spawn / Destroy / Draw / Shuffle …`
2. 触发式异能挂到事件上，收集成 **Batch** 后统一结算；**死亡检查只在 batch 结束时做**。
3. 批内结算顺序：主动方非指向 → 非主动方非指向 → 主动方指向；同组随机（用种子 RNG，保证可回放）。
4. 战斗 = 3 个连续 batch（战斗伤害 → 伤害触发 → 死亡触发）。
5. 静态异能（如 Alloyin General）在每次读取属性时按 lane 从左到右重算。

### 2.3 卡牌效果脚本化
747 张牌效果各不相同，Set 1 也有 184 张。方案：
- 引擎内建一套**效果原语**（dealDamage(target,X)、buff(+a/+h)、spawn(token)、moveCreature、drawCards、poison、armor…）+ **触发器类型**（onEnterFromHand、onDeath、onBattleDamage、startOfTurn、endOfTurn、activate、static…）。
- 每张牌的 JSON 里用声明式 DSL 描述效果，覆盖 ~80% 的牌；剩余复杂牌（Grimgaunt Doomrider 等）写专门的 TS 脚本，按 effectScriptId 挂载。
- 先实现 Set 1 的 184 张 + 全部 23 个关键词。

### 2.4 升级与洗牌
- 打牌/弃牌升级 → 把 `level+1` 的同名牌实例放入弃牌堆；rank up（每 4 回合）洗牌回库，**高于当前 rank 的牌留在弃牌堆**。
- Consistent 洗入顶部 20 张；Overload 移出游戏；Solbind 开局加牌——都在洗牌/开局逻辑里特判。

## 3. 数据管线（tools/scraper）
1. `fetch-card-list.ts`：拉 4 个阵营 Category → 全卡名列表（已验证 API 可行）。
2. `fetch-card-data.ts`：逐卡拉 wikitext，解析 `{{CardTable}}` 模板 → `packages/data/cards/setN.json`。字段含每级 text/attack/health/image 文件名。
3. `fetch-images.ts`：用 `prop=imageinfo` 解析卡图 CDN URL 批量下载到 `assets/cards/<Card>/<level>.jpg`。
4. `lint-cards.ts`：校验字段完整性，标记需要人工写脚本的牌。
5. 卡框/UI 素材：优先从 Steam 客户端 `assets/art/` 目录提取（卡框 lvl1–4 × 4 阵营 × creature/spell、关键词图标、棋盘）；缺的部分用 CSS 重绘。

## 4. 前端（apps/web）
- React + TypeScript；牌桌用 CSS transform/动画即可（原版即偏静态 2D），必要时引 PixiJS 做粒子/战斗动画——**第一版不用**。
- 界面：主菜单 / 收藏 / Deck Builder（30 张、≤2 阵营、≤3 同名 校验）/ 对战界面。
- 对战界面按 wiki 规格：5 lane 上下两排、双方 HP/rank/名字、手牌区、Battle 按钮、守备态锁链标识、长按查看各级形态、拖拽指定目标。
- 前端通过"指令→事件流"与引擎交互；动画从事件流驱动（伤害数字、升级发光、洗牌）。

## 5. AI 对手
- v1 启发式：按"打出收益"打分（大身材生物优先、解场法术打高威胁目标、必按 Battle、不弃有用的牌升级）。
- v2 MCTS：引擎支持种子回放和状态深拷贝，直接跑蒙特卡洛树搜索。
- 难度档位 = 模拟次数/启发式噪声。

## 6. 里程碑
| # | 内容 | 验收 |
|---|---|---|
| M1 | 爬虫管线 + Set 1 全卡 JSON + 卡图下载 | 184 张数据校验通过 |
| M2 | 引擎骨架：状态、行动、回合结构、战斗 3 批次、升级/rank | 单元测试覆盖核心规则（含 Advanced Rules 用例） |
| M3 | 23 个关键词 + Set 1 效果 DSL/脚本 | 184 张全部可打出，效果对拍测试 |
| M4 | 对战界面 + 组牌器（占位图可用） | 浏览器里完整打完一局 |
| M5 | AI v1 + 难度档 | 人机能正常对局 |
| M6 | 素材整合（卡图/卡框/棋盘）、动画打磨 | 视觉接近原版 |
| M7 | 逐系列扩充（Set 1.5 → 7.3，共 747 张） | 每系列回归测试 |
| 远期 | 联机对战、Draft 模式、每日/经济系统 | 另行设计 |

## 7. 版权与素材策略
- 代码原创；卡图/卡框等素材仅本地使用，**不进公开仓库**（`assets/` 加 .gitignore）。
- 若将来公开发布：替换为占位/自制美术，卡牌数据以用户自行导入方式提供。

## 8. 开放问题（实现时再定）
- 少数有第 4 级的牌（Set 6+）与 Forgeborn 机制到 M7 再处理。
- Sudden Death、额外战斗（Staff of Vaerus 类）等边角规则先按 Advanced Rules 文档实现，用测试用例固化。
- 游戏时钟（75s + 3:45 储备）单机版可简化或做成可选开关。
