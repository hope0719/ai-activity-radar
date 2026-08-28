#!/usr/bin/env node
'use strict';
/*
 * sync-from-upstream.js  (双源版)
 * 自动同步两类上游到本项目 data.json：
 *   源1：JS-banana/ai-opportunity-radar 的公开 snapshot.json（airadar.laifuyou.com 同源，字段完整）
 *   源2：LucianaiB 飞书多维表格「AI 活动推荐」(宋欣个人策展，字段较薄：标题/链接/状态/起止/备注)
 * 两源按「归一化标题 / 链接 / 包含关系」去重，冲突时优先保留字段更完整的 JS-banana。
 *
 * 流程：拉取两源 → 映射为中文 activity → 合并去重 → 安全阈值校验 →
 *       写 data.json（无变化则跳过）→ git 提交并推送（GitHub Pages 生效）。
 * 设计原则：与当前已上线 data.json 的字段逐一对齐；LucianaiB 拉取失败不致命（仅告警并用源1继续）。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = '/Users/hope/Desktop/活动雷达/ai-activity-radar';
const OUT_REAL = path.join(PROJECT_DIR, 'data.json');
const DRY = process.argv.includes('--dry-run');
const OUT = DRY ? '/tmp/data_merged_dry.json' : OUT_REAL;
const MSG_FILE = '/tmp/sync_commit_msg.txt';

// —— 源1：JS-banana 开源快照 ——
const REPO = 'JS-banana/ai-opportunity-radar';
const SNAP_PATH = 'src/data/snapshot.json';

// —— 源2：LucianaiB 飞书多维表格 ——
const LUC_APP = 'N2H8bkae1aBvULsrBedc1TtGnBd';
const LUC_TBL = 'tblbwA8TGM8eHLRA';
const LUC_KEEP_STATUS = ['进行中', '长期', '待参加', '等待结果']; // 剔除 结束 / 结束且差评

// —— 枚举 → 中文（对齐上游 enums.ts 的 zh label，与已上线 data.json 一致）——
const TYPE_ZH = { hackathon: '黑客松', 'dev-challenge': '开发挑战', 'dev-incentive': '开发激励', 'ai-competition': 'AI竞赛', 'beta-access': '内测资格', benefit: '权益福利', 'content-creation': '内容创作', other: '其他' };
const REGION_ZH = { global: '全球', china: '中国', 'north-america': '北美', apac: '亚太', europe: '欧洲', japan: '日本', other: '其他' };
const REWARD_ZH = { cash: '奖金', 'api-credits': 'API积分', membership: '会员权益', physical: '实物', certificate: '证书', other: '其他' };
const OFFICIAL_ZH = { confirmed: '官方确认', suspected: '待确认', unofficial: '非官方' };
const SUGGEST_ZH = { 'act-now': '立即行动', 'worth-doing': '值得参加', watch: '先关注', skip: '跳过' };
const IMG_BY_TYPE = { '黑客松': 'event-pass-macro.png', '开发挑战': 'path-prize-envelope.png', '开发激励': 'path-api-credits-card.png', 'AI竞赛': 'coding-workshop-duotone.png', '权益福利': 'path-member-benefits-card.png', '内容创作': 'path-submission-stage.png', '内测资格': 'path-api-credits-card.png', other: 'path-prize-envelope.png' };

// 链接域名 → 友好厂商名（仅用于 LucianaiB 薄字段补全）
const HOST_VENDOR = {
  'modelscope.cn': 'ModelScope', 'gitcode.com': 'GitCode', 'atomgit.com': 'AtomGit',
  'csdn.net': 'CSDN', 'juejin.cn': '掘金', 'mp.weixin.qq.com': '微信公众号',
  'university.aliyun.com': '阿里云', 'qianwenai.com': '千问', 'tch.cloud.tencent.com': '腾讯云',
  'cloud.tencent.com': '腾讯云', 'builderx.csdn.net': 'CSDN', 'lucianaib.feishu.cn': 'LucianaiB',
};

function toDateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function norm(s) {
  if (!s) return '';
  return s.toString().toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\[\]()（）【】“”"'`'·,，。、:：!！?？\-_/\\|~…]/g, '')
    .replace(/\n/g, '');
}
function extractUrl(link) {
  if (!link) return '';
  const m = String(link).match(/\]\(([^)]+)\)/); // [text](url)
  let u = m ? m[1] : String(link).trim();
  return u.split(/\s+/)[0];
}
function normUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    let p = url.pathname.replace(/\/+$/, '');
    const drop = ['ref', 'from', 'utm_source', 'utm_medium', 'utm_campaign', 'spm', 'share'];
    const q = new URLSearchParams(url.search);
    let changed = false;
    for (const k of drop) if (q.has(k)) { q.delete(k); changed = true; }
    const qs = changed ? q.toString() : url.search.replace(/^\?/, '');
    return (url.host + p + (qs ? '?' + qs : '')).toLowerCase();
  } catch (e) { return u.toLowerCase().replace(/\s+/g, ''); }
}
function contains(a, b) {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  return a.includes(b) || b.includes(a);
}
function deriveVendor(url) {
  try {
    const h = new URL(url).host.replace(/^www\./, '');
    return HOST_VENDOR[h] || HOST_VENDOR[h.split('.').slice(-2).join('.')] || '';
  } catch (e) { return ''; }
}

// 通过 curl 拉取（自动遵循 HTTP_PROXY 环境变量）
function fetchText(url) {
  try {
    return execSync(`curl -sSL --max-time 40 ${JSON.stringify(url)}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) { return null; }
}

// —— 源1 拉取 ——
function getSnapshotJson() {
  const jsd = fetchText(`https://cdn.jsdelivr.net/gh/${REPO}@main/${SNAP_PATH}`);
  if (jsd) { try { return JSON.parse(jsd); } catch (e) { /* fallthrough */ } }
  const api = fetchText(`https://api.github.com/repos/${REPO}/contents/${SNAP_PATH}?ref=main`);
  if (api) {
    try {
      const j = JSON.parse(api);
      if (j && j.content) return JSON.parse(Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8'));
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

// —— 源2 拉取（lark-cli，--as user；失败不致命）——
function resolveLarkCli() {
  const cand = ['/Users/hope/.workbuddy/binaries/node/cli-connector-packages/bin/lark-cli', 'lark-cli'];
  for (const c of cand) { if (c === 'lark-cli') return c; if (fs.existsSync(c)) return c; }
  return 'lark-cli';
}
function getLucianaiBRecords() {
  const LARK = resolveLarkCli();
  const out = 'luc_tmp.ndjson';
  const outPath = path.join(PROJECT_DIR, out);
  const manifest = path.join(PROJECT_DIR, 'luc_tmp.manifest.json');
  const cleanup = () => { for (const f of [outPath, manifest]) { try { fs.unlinkSync(f); } catch (e) {} } };
  try {
    execSync(`${JSON.stringify(LARK)} base +record-list --base-token ${LUC_APP} --table-id ${LUC_TBL} --as user --format ndjson --output ${out}`, { cwd: PROJECT_DIR, stdio: 'ignore' });
    if (!fs.existsSync(outPath)) { cleanup(); return null; }
    const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(l => l.trim());
    const recs = lines.map(l => JSON.parse(l));
    cleanup();
    return recs;
  } catch (e) {
    cleanup();
    return null;
  }
}
function mapLucRecord(r) {
  const status = Array.isArray(r['状态']) ? r['状态'][0] : (r['状态'] || '');
  const title = (r['活动标题'] || '').replace(/\n/g, '').trim();
  let url = extractUrl(r['活动链接']);
  if (!url) url = extractUrl(r['参考及注意事项']); // 部分记录链接写在备注里
  const notes = (r['参考及注意事项'] || '') ? String(r['参考及注意事项']).replace(/\n/g, '').trim() : null;
  const suggestion = (status === '进行中' || status === '长期') ? 'worth-doing'
    : (status === '待参加' || status === '等待结果') ? 'watch' : null;
  return {
    id: 'luc_' + (r.record_id || title),
    title,
    vendor: deriveVendor(url),
    type: '其他',
    score: 0,
    difficulty: null,
    difficultyNote: null,
    reward: '',
    rewardDetail: notes,
    rewardTypes: [],
    format: null,
    participation: null,
    winningCriteria: null,
    timelineNotes: null,
    startAt: r['开始日期'] || null,
    endAt: r['结束日期'] || null,
    deadline_date: toDateOnly(r['结束日期']),
    region: '其他',
    officialStatus: '',
    url,
    source: 'lucianaib',
    estimatedEffort: null,
    suggestion,
    discoveredAt: null,
    slug: null,
    image: IMG_BY_TYPE['其他'],
  };
}

// —— 合并去重：LucianaiB 与 JS-banana 冲突时优先保留 JS-banana ——
function mergeActivities(jb, luc) {
  const result = jb.slice();
  const jbNorm = jb.map(a => ({ nT: norm(a.title), nU: normUrl(a.url) }));
  let dropped = 0, kept = 0;
  for (const l of luc) {
    const nT = norm(l.title), nU = normUrl(l.url);
    let dup = false;
    for (const j of jbNorm) {
      if (nT && j.nT && nT === j.nT) { dup = true; break; }
      if (nU && j.nU && nU === j.nU) { dup = true; break; }
      if (contains(nT, j.nT)) { dup = true; break; }
    }
    if (dup) { dropped++; continue; }
    result.push(l); kept++;
  }
  return { result, dropped, kept };
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
  // 源1
  const snap = getSnapshotJson();
  if (!snap || !Array.isArray(snap.opportunities)) {
    console.error('✗ 无法获取上游 snapshot.json（jsDelivr 与 GitHub API 均失败）');
    process.exit(2);
  }
  const mappedJB = snap.opportunities.map(mapOpp);

  // 源2（失败不致命）
  let mappedLuc = [];
  const rawLuc = getLucianaiBRecords();
  if (rawLuc && rawLuc.length) {
    mappedLuc = rawLuc
      .filter(r => {
        const st = Array.isArray(r['状态']) ? r['状态'][0] : (r['状态'] || '');
        return LUC_KEEP_STATUS.includes(st);
      })
      .map(mapLucRecord);
    console.log(`✓ LucianaiB 表拉取成功：${rawLuc.length} 条，保留非结束 ${mappedLuc.length} 条`);
  } else {
    console.warn('⚠ LucianaiB 表拉取失败（飞书 token 可能过期），仅用 JS-banana 源继续。');
  }

  // 合并去重
  const { result, dropped, kept } = mergeActivities(mappedJB, mappedLuc);
  console.log(`✓ 合并：JS-banana ${mappedJB.length} + LucianaiB 新纳入 ${kept}（去重 ${dropped}）= 共 ${result.length}`);

  // 安全阈值（以 JS-banana 为主源）
  let currentCount = 0;
  let existing = null;
  if (fs.existsSync(OUT_REAL)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT_REAL, 'utf8'));
      currentCount = (existing.activities || []).length;
    } catch (e) { existing = null; }
  }
  const minCount = currentCount ? Math.ceil(currentCount * 0.5) : 50;
  if (mappedJB.length < minCount) {
    console.error(`✗ 上游记录数 ${mappedJB.length} 低于安全阈值 ${minCount}（现有 ${currentCount}），中止以免误覆盖`);
    process.exit(3);
  }

  // 保留手工补录（非双源来源）：source 不属于 lucianaib / 上游映射产生的记录
  // 这些是人工补录的（观猹/抖音/本地扩充等），双源同步不应冲掉它们
  const manualRecords = (existing && existing.activities ? existing.activities : [])
    .filter(a => {
      const s = a.source || '';
      return s !== 'lucianaib' && !s.startsWith(REPO.split('/')[1]) && !['Devpost','天池','DoraHacks','CompeteHub','lablab.ai','AgentDeadlines','HuggingFace','V2EX','Twitter','官网'].includes(s);
    })
    .filter(a => a.id && !result.some(r => r.id === a.id)); // 与双源去重（按 id）
  const merged = [...result, ...manualRecords];
  console.log(`ℹ 保留手工补录 ${manualRecords.length} 条（来源: ${[...new Set(manualRecords.map(a=>a.source||'?'))].join(', ') || '无'}）`);

  const data = {
    site_name: 'AI 活动雷达',
    tagline: '在时间截止前找到 AI 机会',
    updated_at: new Date().toISOString(),
    source: `${REPO} (airadar.laifuyou.com) + LucianaiB 飞书表「AI 活动推荐」双源合并` + (manualRecords.length ? ` + 手工补录 ${manualRecords.length} 条` : ''),
    activities: merged,
  };

  if (DRY) {
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    console.log(`✓ [dry-run] 已写入 ${OUT}（共 ${merged.length} 条，含手工 ${manualRecords.length} 条），未提交。`);
    process.exit(0);
  }

  // 无变化则跳过
  if (existing && JSON.stringify(existing.activities) === JSON.stringify(merged)) {
    console.log('✓ 双源均无变化，data.json 无需更新');
    process.exit(0);
  }

  const prevIds = new Set((existing ? existing.activities : []).map(a => a.id));
  const newIds = new Set(merged.map(a => a.id));
  let added = 0, removed = 0;
  for (const id of newIds) if (!prevIds.has(id)) added++;
  for (const id of prevIds) if (!newIds.has(id)) removed++;

  fs.writeFileSync(OUT_REAL, JSON.stringify(data, null, 2));

  const now = Date.now();
  const active = activeCount(merged, now);
  console.log(`✓ 已写入 data.json：${merged.length} 条（新增 ${added} / 移除 ${removed}），页面活跃展示约 ${active} 条`);

  const byType = {}, bySrc = {};
  for (const a of merged) { byType[a.type] = (byType[a.type] || 0) + 1; bySrc[a.source || '?'] = (bySrc[a.source || '?'] || 0) + 1; }
  console.log('类型分布：', JSON.stringify(byType));
  console.log('来源分布：', JSON.stringify(bySrc));

  const msg = `chore(sync): 双源同步 JS-banana(${mappedJB.length}) + LucianaiB(${kept},去重${dropped}) — 共${merged.length}条（含手工${manualRecords.length}，新增${added} 移除${removed}），活跃约${active}`;
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
