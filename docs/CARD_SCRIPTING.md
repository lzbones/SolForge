# SolForge 引擎 — 卡牌脚本编写指南

卡牌脚本为每张牌定义效果逻辑。数据（名称/攻防/原始文字）来自 `tools/scraper/build/cards_Set_1.json`，脚本在 `packages/engine/src/scripts/` 下用 TypeScript 编写并注册。

## 注册

```ts
// packages/engine/src/scripts/setN.ts
import { registerCard } from "./registry.js";
registerCard({ defId: "card-slug", levels: {...}, spell: {...} });
```

`defId` 是牌名 slug：`"Demara's Pitguard"` → `demaras-pitguard`（`slugify()` in load.ts）。
新文件必须在 `scripts/index.ts` 中 import。

## 生物：`levels: { [level]: LevelScript }`

```ts
levels: {
  1: {
    abilities: [/* 触发式异能 */],
    activates: [/* Activate 异能 */],
    statics:  [/* 静态异能（光环） */],
  },
  2: {...}, 3: {...},
}
```

多数牌三个等级只是数值不同，用 `Object.fromEntries([[1,..],[2,..],[3,..]].map(...))` 生成（见 set1.ts 示例）。

### 触发式异能 Ability
```ts
{
  id: "unique-within-level",
  trigger: "enterFromHand" | "enterPlay" | "enterReplace" | "destroyed"
    | "anyCreatureDestroyed" | "friendlyCreatureDestroyed" | "creatureDied"（敌方生物死）
    | "opposingCreatureDestroyed" | "battleDamageToPlayer" | "battleDamageToCreature"
    | "dealtDamageToCreature" | "damaged" | "moved" | "turnStart" | "turnEnd"
    | "rankGained" | "cardPlayed" | "spellPlayed" | "creaturePlayed" | "enemyCreatureEntered",
  targeted: true,               // 有目标的异能（批次中后结算）
  condition: (game, self, evt) => boolean,   // 可选；不满足则不进入批次
  prompt: (game, self, evt) => ChoiceRequest | null,  // 可选；需要玩家选择时提供
  resolve: (ctx, self, evt, choice) => { ...效果... },
}
```
- 对应原文关键词：`Forge:`→`enterFromHand`；`Vengeance:`→`destroyed`；`Upgrade:`→`enterReplace`；`Assault:`→`enterFromHand` + condition（其 lane 无其他生物）；`Formation:`→`enterFromHand` + condition（两侧相邻格均有友方生物）；`Allied:`→`enterFromHand` + condition（手牌有指定阵营/类型牌）；`Flank:`→`moved`；`Raid:`→`turnEnd` + condition（≥3 友方生物 hasBattled）；`At the start of your turn`→`turnStart`（condition 须限定 `game.state.active === self.owner`）；`At the end of your turn`→`turnEnd` 同理。
- `evt` 携带：`sourceUid/sourceDefId/sourceLevel/sourceOwner/lane/amount/targetPlayer`。
- `prompt` 返回 `{ kind, prompt, options, optional }`；kind: `yesNo | friendlyCreature | enemyCreature | anyCreature | anyCreatureOrPlayer | cardInHand`。玩家目标用 sentinel：`-1`=玩家0，`-2`=玩家1。**resolve 中先读 choice，declined（accepted===false）时不会调用 resolve。**
- 引擎规则（无需脚本处理）：死亡只在批次结束检查；同批内顺序 主动方非指向→非主动方非指向→主动方指向→非主动方指向，组内随机。

### Activate 异能
```ts
activates: [{ id, condition?, prompt?, resolve: (ctx, self, choice) => {...} }]
```
引擎已处理：守备态不能用、每回合一次、Aggressive 可即回合用。

### 静态异能（光环，如 Alloyin General）
```ts
statics: [{ id, apply: (game, self, target, stats) => { stats.attack += 2; } }]
```
对每个生物读属性时调用；可修改 `stats.attack/stats.health`（注意 Advanced Rules：按 lane 从左到右应用，引擎已排序）。

## 法术：`spell: { [level]: SpellScript }`
```ts
spell: { 1: { prompt?: (game, player) => ChoiceRequest | null,
              resolve: (ctx, player, choice) => {...} } }
```
引擎已处理：升级复制、Free 不占行动、Overload 移出游戏、进弃牌堆。

## 效果原语（从 `../effects.js` 导入）
- `dealCreatureDamage(game, events, creature, amount, source?, battle?)`
- `dealPlayerDamage(game, events, playerId, amount, source?, battle?)`
- `healPlayer(game, events, playerId, amount)` / `healCreature(game, events, c, amount)`
- `buffCreature(game, events, c, atk, hp, temp?)`（temp=true 表示"this turn"，回合结束自动消失）
- `grantKeyword(events, c, {keyword, value}, temp?)` / `negateKeyword(events, c, kw)`
- `destroyCreature(game, events, c)`（直接消灭）
- `spawnCreature(game, events, owner, defId, level, {lane?, replace?, overrideStats?})`（lane 省略=随机空格）
- `drawCardsEffect(game, events, playerId, n)`
- 工具：`getStats(game, c)`（含静态加成）、`findCreature(state, uid)`、`hasKeyword(c, kw)`、`keywordValue(c, kw)`、`opposing(p)`；`game.state.players[p].lanes/hand/deck/discard`。
- ctx：`{ game, events, rng }`。
- 衍生物 defId：`zombie`、`spirit-nekrium`、`sapling`、`seedling`、`treefolk`、`oozeling-green`（数值不对时用 overrideStats）。

## 关键词
引擎原生处理：`Aggressive Defender Armor Breakthrough Mobility Poison Regenerate Free Consistent Overload`（以及 Activate/Mobility 的行动规则）。原文中的关键词模板（如 `{{Armor|2}}`）已被解析进 CardDef.levels[].keywords，无需脚本。**给生物加关键词用 grantKeyword。**

## 测试
每张复杂牌（带触发/选择）至少一个测试：`packages/engine/test/`。运行：`npx vitest run`、`npx tsc --noEmit`。测试用真实数据加载（参考 behaviors.test.ts），`deckOf(id) = Array(30).fill(id)`，p1 常用 `cavern-hydra` 做陪练。选择用 `applyChoice(g, {id, accepted, targetUid})`。

## 参考示例
`scripts/set1.ts`：Lightning Spark（指向法术+choice）、Ferocious Roar（群体buff）、Aegis Conscript（Forge+可选目标）、Ashurian Mystic（Aggressive+战斗触发）、Death Seeker（Vengeance token）、Grimgaunt Devourer（死亡触发）、Firefist Uranti（Activate）、Brightsteel Gargoyle（回合末临时关键词）、Aerial Surge（给关键词法术）、Energy Surge（抽牌）。

## 引擎新增机制（Set 1.5/Set 2 起）
- **触发事件补充**：`anyCreatureEnterPlay`（任何生物进场广播，evt.fromHand 区分是否 Forged）、`friendlyCreatureMoved`（友方生物移动广播）、`friendlyBattleDamageToPlayer`、`cardPlayed`/`spellPlayed`（结算后广播，payload 带 sourceDefId/sourceLevel/sourceOwner）。
- **静态关键词授予**：StaticAbility.apply 的 out 参数为 `{attack, health, keywords}`，push `{keyword, value}` 到 keywords 即可；引擎在批次/battle/legalActions 前自动 refreshStatics。
- **沉默**：CreatureState.silenced=true 后触发/Activate 不触发。
- **多段选择链**：resolve 可 return 一个 ChoiceRequest（无 id）发起下一段选择；`ctx.priorAnswers` 携带之前所有答案（最后一个最新）。
- **Banish**：`banishFromDiscard(game, events, player, discardIndex)` / `banishCreature(game, events, c)`——移出游戏，不触发死亡。配套选择类型 `cardInDiscard`（options 为弃牌堆下标，答案在 choice.handIndex）。
- **Solbind**：CardScript 加 `solbind: ["def-id", ...]`（可重复），引擎开局自动把这些牌（L1）加入牌库。
- **Ambush**（Leyline 牌）：CardScript 加 `ambush: { watch: "thirdEnemyCard" | "enemyMove" | "enemyUnForgedEntry" | "enemyHeal" }`，引擎自动处理"对方回合触发 → Spawn 复制 → 弃掉并升级手牌"。
- **4 级牌**（Forgeborn 等）：levels 到 4 直接写 `levels: {1..4}`，maxLevel 自动处理。
- **额外出牌**：`state.playsLeft += 1`；**额外战斗**：`state.battlesLeft += 1`（Zyx/Call the Lightning 同款约定）。
