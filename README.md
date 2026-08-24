# AI 活动雷达 (ai-pick)

> 在时间截止前找到 AI 机会

**在线地址：** https://hope0719.github.io/ai-pick/

**代码仓库：** https://github.com/hope0719/ai-pick

---

## 🙏 致谢

本项目在设计与数据架构上深受以下两个开源/分享项目的启发，特此致谢：

1. **[LucianaiB2004/ai-village-intelligence](https://github.com/LucianaiB2004/ai-village-intelligence)**（AI 村口情报中心）
   本项目的**最初灵感来源**。它用「AI + 飞书多维表格 + 飞书原生自动化」构建个人情报闭环，其「AI 情报日报」与「截止日期救命器」两大功能启发我们：AI 机会信息应当**结构化、可自动维护、可按时效驱动**。我们在保留这一理念的同时，选择了更轻量的「纯 GitHub 静态部署」路线（不用飞书）。

2. **[JS-banana/ai-opportunity-radar](https://github.com/JS-banana/ai-opportunity-radar)**（即 airadar.laifuyou.com 的开源源码）
   本项目的**布局与数据架构参考**。我们参考了它的页面视觉（米色纸感、卡片网格、即将截止高亮区）与数据模型（飞书多维表格 → 快照 JSON → 静态托管），并直接复用了其公开的 `snapshot.json` 作为**第一数据源**，同时在其基础上新增了中文映射、第二数据源（LucianaiB 飞书表）合并、去重与本地化增强。

---

## 一、项目目的

**用一张随时更新的「AI 机会雷达图」，帮开发者/创作者在截止日期前发现值得投入的 AI 活动（黑客松、竞赛、开发挑战、权益福利、内容创作等）。**

核心问题：AI 领域的比赛/活动信息分散在 Devpost、Kaggle、天池、ModelScope、GitCode、微信公众号等大量渠道，且**高度依赖时效**（过期即失效）。本项目把散落的机会聚合到单一页面，并持续自动同步，解决三个痛点：

1. **信息聚合**：将多源 AI 活动统一为结构化数据，按类型/地区/排序筛选，一眼找到合适的。
2. **时效管理**：高亮"即将截止"活动，动态隐藏过期超过 7 天的活动（后端保留全量，前端按时效过滤）；无截止日期的活动归入独立"长期有效"区块。
3. **投入判断**：每张卡片提供推荐指数、难度、奖励类型、官方确认状态、行动建议（立即行动/值得参加/先关注/跳过），并通过"立即行动"按钮直达报名入口。

数据当前规模：**202 条活动**（黑客松 75 / AI 竞赛 52 / 开发挑战 33 / 内容创作 21 / 权益福利 14 / 开发激励 7），覆盖全球（125）与中国（62）为主，其中**长期有效（无截止日期）26 条**。

---

## 二、技术规范

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    上游数据（双源）                            │
│  源1: JS-banana/ai-opportunity-radar@main                     │
│       src/data/snapshot.json（字段完整）                      │
│  源2: LucianaiB 飞书多维表格「AI 活动推荐」                    │
│       app_token=N2H8bkae1aBvULsrBedc1TtGnBd /                 │
│       table=tblbwA8TGM8eHLRA（lark-cli --as user 拉取）        │
└──────────────────────────┬────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              scripts/sync-from-upstream.js                   │
│  拉取两源 → 中文枚举映射 → 合并去重 → 安全阈值校验 →            │
│  写 data.json（无变化跳过）→ git commit + push origin/main    │
└──────────────────────────┬────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Pages 静态托管                      │
│   index.html（骨架） + app.js（渲染逻辑） + style.css（样式）   │
│   https://hope0719.github.io/ai-pick/                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 HTML + CSS + JavaScript（ES6+） | 无框架、无构建、无后端；`index.html`（骨架）+ `app.js`（逻辑）+ `style.css`（样式）分离 |
| 数据 | `data.json`（JSON） | 全量活动数据（202 条），前端 fetch 拉取后渲染 |
| 部署 | GitHub Pages | 静态托管，push 到 `origin/main` 自动触发构建（pages-build-deployment） |
| 数据同步 | Node.js 脚本 `scripts/sync-from-upstream.js` | 双源合并同步，支持 `--dry-run` |
| 飞书数据源 | `lark-cli`（@larksuite/cli） | 以用户身份（`--as user`）拉取多维表格 |
| 自动化 | WorkBuddy 每日定时任务 | 周期执行同步脚本，无人值守更新数据 |
| 信息源 | `SOURCES.md` | 人工维护的信息渠道清单（中文资讯/竞赛平台/开发者计划/学术/自媒体） |

### 2.3 数据模型（data.json）

顶层结构：

```json
{
  "site_name": "AI 活动雷达",
  "tagline": "在时间截止前找到 AI 机会",
  "updated_at": "2026-08-24T11:32:00.000Z",
  "source": "JS-banana/ai-opportunity-radar (airadar.laifuyou.com) + LucianaiB 飞书表「AI 活动推荐」双源合并",
  "activities": [ /* 活动记录数组 */ ]
}
```

单条活动字段（27 个）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识（沿用上游记录 id） |
| `title` | string | 活动标题（前端渲染时自动剥离金额摘要，避免与奖励盒重复） |
| `vendor` | string | 主办方/厂商 |
| `type` | enum | 活动类型：黑客松 / AI竞赛 / 开发挑战 / 开发激励 / 权益福利 / 内容创作 / 内测资格 / 其他 |
| `score` | number(1-5) | 推荐指数（星级展示） |
| `difficulty` | number(1-5) | 难度（星级展示，可空） |
| `difficultyNote` | string | 难度说明（参赛门槛/面向人群） |
| `reward` | string | 奖励摘要（80 字符截断版） |
| `rewardDetail` | string | 奖励完整版（优先展示，避免与 reward 重复） |
| `rewardTypes` | enum[] | 奖励类型：奖金 / API积分 / 会员权益 / 实物 / 证书 / 其他 |
| `format` | string | 赛事形式（线上/线下等） |
| `participation` | string | 参与方式/报名规则 |
| `winningCriteria` | string | 获奖条件 |
| `timelineNotes` | string | 时间备注 |
| `startAt` / `endAt` | ISO datetime | 开始/截止时间（endAt 为时效判定主依据；两者皆空 → 归入长期有效区） |
| `deadline_date` | date | 截止日期（YYYY-MM-DD） |
| `region` | enum | 地区：全球 / 中国 / 北美 / 亚太 / 欧洲 / 日本 / 其他 |
| `officialStatus` | enum | 官方确认 / 待确认 / 非官方 |
| `url` | string | 报名入口链接（仅展示在"立即行动"按钮内） |
| `source` | string | 来源渠道（Devpost / 天池 / DoraHacks / lucianaib 等） |
| `estimatedEffort` | string | 预计投入 |
| `suggestion` | enum | 行动建议：立即行动 / 值得参加 / 先关注 / 跳过 |
| `discoveredAt` | ISO datetime | 发现时间 |
| `slug` | string | SEO 短链接 |
| `image` | string | 类型封面图（assets/ 下） |

### 2.4 双源合并与去重

`scripts/sync-from-upstream.js` 的核心逻辑：

1. **源1 拉取**：jsDelivr CDN 优先、GitHub API（base64）兜底，获取 `JS-banana/ai-opportunity-radar@main/src/data/snapshot.json`。
2. **源2 拉取**：`lark-cli base +record-list --as user` 拉取 LucianaiB 飞书表，仅保留状态为 `进行中 / 长期 / 待参加 / 等待结果` 的记录（剔除 `结束 / 结束且差评`）。**拉取失败不致命**——仅告警并继续用源1。
3. **枚举映射**：将上游英文枚举（`hackathon`/`global`/`confirmed` 等）映射为中文，与页面展示一致。
4. **合并去重**：按「归一化标题 / 链接 / 包含关系」全局比对，冲突时**优先保留字段更完整的 JS-banana**（如微信小程序开发大赛在 LucianaiB 与 JS-banana 同时出现时只保留后者）。
5. **安全阈值**：合并后记录数 < 现有数据 50% 时中止（防上游异常空表误覆盖）。
6. **幂等提交**：与现有 data.json 比对，**无变化跳过**；有变化才写盘并 `git commit` + `push origin main` 触发 Pages 更新。

### 2.5 页面结构与渲染规则

页面分三个区块（导航可直达）：

| 区块 | 锚点 | 展示内容 | 过滤逻辑 |
|---|---|---|---|
| **即将截止** | `#closing` | 最紧迫的 4 条（未结束且 deadline 最近） | `endAt` 在未来，按截止时间升序取前 4 |
| **全部机会** | `#opportunities` | 所有有截止日期且未过期超 7 天的活动 | `matches(a) && endOf(a)`；`endAt` 为空 → 不在此区 |
| **长期有效** | `#longterm` | 无截止日期的活动（随时可参与） | `!endOf(a)` |

- **数据加载**：fetch `data.json`（`cache:'no-store'`），无构建、无框架。
- **时效过滤**：`endAt` 超过当前时间 7 天 → 从"全部机会"隐藏（后端数据全量保留，前端动态过滤）。
- **即将截止徽章**：≤7 天 → 红色 `urgent`；≤30 天 → 琥珀 `soon`；更远 → 灰 `distant`；已过 → `已结束`；无日期 → `长期开放`。
- **卡片信息**：标题（自动去金额）→ 厂商·地区 → 截止日 + 官方状态徽章 + 行动建议 + 奖励类型 chips → 推荐★ + 难度★ 同行 → 奖励详情盒 → 参与方式摘要 → 类型标签 + **"立即行动"按钮**。
- **筛选排序**：类型 / 地区 / 排序（**截止日期 / 推荐指数 / 奖金池 / 最新发现**，奖金池按 `reward` 字段解析金额排序）。

### 2.6 本地开发与同步

```bash
# 1. 本地预览（任选一个静态服务器）
python3 -m http.server 8000          # 或 npx serve
# 打开 http://localhost:8000

# 2. 手动触发数据同步（拉取双源 → 合并 → 提交推送）
node scripts/sync-from-upstream.js

# 3. 试运行（只写 /tmp/data_merged_dry.json，不提交）
node scripts/sync-from-upstream.js --dry-run

# 4. 依赖（仅脚本需要，前端零依赖）
#    lark-cli: @larksuite/cli（拉取飞书表用，需以用户身份授权）
```

> ⚠️ 注意：源2（LucianaiB 飞书表）依赖飞书用户 token（`lark-cli --as user`）。token 过期时脚本会告警并自动降级为仅源1，不会中断同步；恢复需重新登录 lark-cli。

### 2.7 目录结构

```
ai-pick/
├── index.html                     # 页面骨架（三区块：即将截止/全部机会/长期有效）
├── app.js                         # 前端渲染逻辑（筛选/排序/时效过滤/卡片渲染）
├── style.css                      # 全部样式
├── data.json                      # 全量活动数据（202 条，双源合并）
├── SOURCES.md                     # 信息源清单（人工维护）
├── assets/                        # 类型封面图（6 张 png）
├── scripts/
│   └── sync-from-upstream.js      # 双源同步脚本（支持 --dry-run）
└── .gitignore                     # 忽略 .DS_Store / *.log / .workbuddy/
```

---

## License

MIT（数据源分别遵循其上游项目各自的许可；请在使用前核实。）
