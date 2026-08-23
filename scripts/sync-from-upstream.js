#!/usr/bin/env node
'use strict';
/*
 * sync-from-upstream.js
 * 自动同步上游 JS-banana/ai-opportunity-radar 的公开 snapshot.json 到本项目 data.json。
 * 上游即 airadar.laifuyou.com 的开源源码，其 src/data/snapshot.json 由飞书多维表格经 CI 定期生成并提交。
 *
 * 流程：拉取上游 → 枚举映射为中文 → 安全阈值校验 → 写 data.json（无变化则跳过）→ git 提交并推送。
 * 设计原则：与当前已上线 data.json 的映射逻辑逐字段一致，避免无意义的重写。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = '/Users/hope/Desktop/活动雷达/ai-activity-radar';
const OUT = path.join(PROJECT_DIR, 'data.json');
const REPO = 'JS-banana/ai-opportunity-radar';
const SNAP_PATH = 'src/data/snapshot.json';
const MSG_FILE = '/tmp/sync_commit_msg.txt';

// —— 枚举 → 中文（对齐上游 enums.ts 的 zh label，与已上线 data.json 一致）——
const TYPE_ZH = { hackathon: '黑客松', 'dev-challenge': '开发挑战', 'dev-incentive': '开发激励', 'ai-competition': 'AI竞赛', 'beta-access': '内测资格', benefit: '权益福利', 'content-creation': '内容创作', other: '其他' };
const REGION_ZH = { global: '全球', china: '中国', 'north-america': '北美', apac: '亚太', europe: '欧洲', japan: '日本', other: '其他' };
const REWARD_ZH = { cash: '奖金', 'api-credits': 'API积分', membership: '会员权益', physical: '实物', certificate: '证书', other: '其他' };
const OFFICIAL_ZH = { confirmed: '官方确认', suspected: '待确认', unofficial: '非官方' };
const SUGGEST_ZH = { 'act-now': '立即行动', 'worth-doing': '值得参加', watch: '先关注', skip: '跳过' };
const IMG_BY_TYPE = { '黑客松': 'event-pass-macro.png', '开发挑战': 'path-prize-envelope.png', '开发激励': 'path-api-credits-card.png', 'AI竞赛': 'coding-workshop-duotone.png', '权益福利': 'path-member-benefits-card.png', '内容创作': 'path-submission-stage.png', '内测资格': 'path-api-credits-card.png', other: 'path-prize-envelope.png' };

function toDateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// 通过 curl 拉取（自动遵循 HTTP_PROXY 环境变量，适配本机代理环境）
function fetchText(url) {
  try {
    return execSync(`curl -sSL --max-time 40 ${JSON.stringify(url)}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return null;
  }
}

function getSnapshotJson() {
  // 优先 jsDelivr CDN（直连可用）
  const jsd = fetchText(`https://cdn.jsdelivr.net/gh/${REPO}@main/${SNAP_PATH}`);
  if (jsd) {
    try { return JSON.parse(jsd); } catch (e) { /* fallthrough */ }
  }
  // 兜底 GitHub API（base64 内容，可能按行切分）
  const api = fetchText(`https://api.github.com/repos/${REPO}/contents/${SNAP_PATH}?ref=main`);
  if (api) {
    try {
      const j = JSON.parse(api);
      if (j && j.content) {
        return JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
      }
    } catch (e) { /* fallthrough */ }
  }
  return null;
}

function mapOpp(o) {
  return {
    id: o.id,
    title: o.title,
    vendor: o.vendor || '',
    type: TYPE_ZH[o.type] || o.type || '其他',
    score: o.score || 0,
    difficulty: o.difficulty ?? null,
    difficultyNote: o.difficultyNote || null,
    reward: o.rewardSummary || '',
    rewardDetail: o.rewardDetail || null,
    rewardTypes: (o.rewardTypes || []).map(r => REWARD_ZH[r] || r),
    format: o.format || null,
    participation: o.participation || null,
    winningCriteria: o.winningCriteria || null,
    timelineNotes: o.timelineNotes || null,
    startAt: o.startAt || null,
    endAt: o.endAt || null,
    deadline_date: toDateOnly(o.endAt),
    region: REGION_ZH[o.region] || o.region || '其他',
    officialStatus: OFFICIAL_ZH[o.officialStatus] || o.officialStatus || '',
    url: o.registrationUrl || '',
    source: o.sourceChannel || null,
    estimatedEffort: o.estimatedEffort || null,
    suggestion: SUGGEST_ZH[o.suggestion] || null,
    discoveredAt: o.discoveredAt || null,
    slug: o.slug || null,
    image: IMG_BY_TYPE[TYPE_ZH[o.type] || '其他'] || 'path-prize-envelope.png',
  };
}

function activeCount(list, now) {
  const CUTOFF = 7 * 864e5;
  let n = 0;
  for (const x of list) {
    const s = x.endAt || x.deadline_date;
    if (!s) { n++; continue; }
    const t = new Date(s).getTime();
    if (isNaN(t)) { n++; continue; }
    if (now - t > CUTOFF) continue;
    n++;
  }
  return n;
}

function main() {
  const snap = getSnapshotJson();
  if (!snap || !Array.isArray(snap.opportunities)) {
    console.error('✗ 无法获取上游 snapshot.json（jsDelivr 与 GitHub API 均失败）');
    process.exit(2);
  }
  const ops = snap.opportunities;

  // 安全阈值：上游记录数不得低于现有 data.json 的 50%，否则可能是上游异常/空表，中止以免误覆盖
  let currentCount = 0;
  let existing = null;
  if (fs.existsSync(OUT)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      currentCount = (existing.activities || []).length;
    } catch (e) { existing = null; }
  }
  const minCount = currentCount ? Math.ceil(currentCount * 0.5) : 50;
  if (ops.length < minCount) {
    console.error(`✗ 上游记录数 ${ops.length} 低于安全阈值 ${minCount}（现有 ${currentCount}），中止以免误覆盖`);
    process.exit(3);
  }

  const mapped = ops.map(mapOpp);
  const data = {
    site_name: 'AI 活动雷达',
    tagline: '在时间截止前找到 AI 机会',
    updated_at: new Date().toISOString(),
    source: `${REPO} (airadar.laifuyou.com) 开源 snapshot.json`,
    activities: mapped,
  };

  // 无变化则跳过（避免每次运行都重写 + 空提交）
  if (existing && JSON.stringify(existing.activities) === JSON.stringify(mapped)) {
    console.log('✓ 上游无变化，data.json 无需更新');
    process.exit(0);
  }

  // 计算新增/移除（按 id 比对），用于提交说明
  const prevIds = new Set((existing ? existing.activities : []).map(a => a.id));
  const newIds = new Set(mapped.map(a => a.id));
  let added = 0, removed = 0;
  for (const id of newIds) if (!prevIds.has(id)) added++;
  for (const id of prevIds) if (!newIds.has(id)) removed++;

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));

  const now = Date.now();
  const active = activeCount(mapped, now);
  console.log(`✓ 已写入 data.json：${mapped.length} 条（新增 ${added} / 移除 ${removed}），页面活跃展示约 ${active} 条`);

  // 统计分布
  const byType = {};
  for (const a of mapped) byType[a.type] = (byType[a.type] || 0) + 1;
  console.log('类型分布：', JSON.stringify(byType));

  // git 提交并推送
  const msg = `chore(sync): 自动同步上游 ${REPO} — 共${mapped.length}条（新增${added} 移除${removed}），活跃约${active}`;
  try {
    fs.writeFileSync(MSG_FILE, msg, 'utf8');
    execSync(`git -C ${JSON.stringify(PROJECT_DIR)} add data.json`, { stdio: 'ignore' });
    execSync(`git -C ${JSON.stringify(PROJECT_DIR)} commit -F ${JSON.stringify(MSG_FILE)}`, { stdio: 'ignore' });
    execSync(`git -C ${JSON.stringify(PROJECT_DIR)} push origin main`, { stdio: 'ignore' });
    console.log('✓ 已提交并推送：', msg);
  } catch (e) {
    console.error('✗ git 提交/推送失败：', e.message);
    process.exit(4);
  }
}

main();
