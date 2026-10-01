// ============================================================
//  verify-ending.mjs —— 结局移植保真校验（3D vs 2D EndingSystem）
// ============================================================
//
// 从 2D 引擎文本里抠出 ENDING_DEFS，与 3D 的 src/ending.js 逐项比对。
// 移植类改动的唯一可靠验收方式：手抄必然出错，必须让机器比对。
//
// 为什么这条校验必须存在（它是**真实抓到过 bug 的**）：
//   第一版 src/ending.js 里我把 end_wake 和 end_sleep 按 rank 顺序
//   排列，看起来完全正确 —— 排序后两者顺序相同，一致。
//   但 2D 刻意把 end_sleep 放在**数组末尾**，因为
//   `sorted.find() || ENDING_DEFS[length-1]` 的最后兜底要靠它。
//   按 rank 排序的比对发现不了这个漂移；只有比对「数组原序」才行。
//   ⇒ 结论已写进脚本：比对原序，不是比对排序后的顺序。
//
// 用法：node scripts/verify-ending.mjs
// ============================================================
//
// 从 2D 引擎代码里抠 ENDING_DEFS，与 3D 的 src/ending.js 逐项比对。
// 移植类改动的唯一可靠验收方式：手抄必然出错，必须让机器比对。
//
// ── 这个脚本踩过的三个坑（都修了，记下来防止后来人重踩）────────
//
//   坑1 比对「数组原序」而不是「rank 排序后的顺序」
//       rank 只决定优先级；数组位置还决定了
//       `ENDING_DEFS[length-1]`（find 全落空时的最后兜底）是谁。
//       2D 刻意把 end_sleep 放在数组末尾。排序后看不出这个差别 ——
//       我第一版就是按 rank 排序比对，结果漏掉了这个真实漂移。
//
//   坑2 切分结局块不能用 `\n  {\n`
//       结局正文里含有 `\n` 转义，紧跟着 `  {\n` 这种缩进花括号的内容
//       会出现在**块内**（比如正文里写「{」的场景），按行切会切错位。
//       改成**花括号配平**扫描，与文本内容完全无关。
//
//   坑3 正文比对不能粗暴去掉所有 `
//       2D 的字符串是 `'...' + '...'` 拼接（带 + 和引号），
//       3D 也是。粗暴 strip 之后两边都还留着 `+`，而且 2D 的
//       `\n' +` 与 3D 的 `\n` 换行位置不同。
//       正确做法：从源码里**求值**出真实字符串再比。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDING_DEFS, ENDING_TONES, createEndingSystem } from '../src/ending.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 这是一个**跨工程**一致性校验 ─────────────────────────
//
// 它把 3D 的结局定义（rank / tone / 全部文本字段 / 色调表 / 判定行为）
// 与 2D 引擎里那一份逐字段对拍，所以需要 2D 工程的源码在场。
//
// 在只含 3D 的仓库里（比如发布仓库）那份源码不存在。这时**明确跳过**：
//   · 不要崩 —— 会让 CI 红在一个"本来就不适用"的检查上
//   · 也不要假装通过 —— 那会让人以为结局一致性被验证过了
// 所以打一条显眼的 SKIP，并说明为什么。
const ENG = path.join(__dirname, '..', '..', 'tangping-game', 'src', 'engine', 'vendor-engine.js');
if (!fs.existsSync(ENG)) {
  console.log('⚠️  跳过：找不到 2D 引擎参考文件');
  console.log('   ' + ENG);
  console.log('   本套件做的是**跨工程一致性**校验（3D 结局定义 vs 2D 引擎那份逐字段对拍），');
  console.log('   需要 2D 工程与 3D 工程并排放置。只含 3D 的仓库里这是预期行为，不是失败。');
  console.log('   ⇒ 本次运行**没有**验证结局一致性。');
  process.exit(0);
}
const eng = fs.readFileSync(ENG, 'utf8');

// ══════════════════════════════════════════════════════════
//  花括号配平扫描：抠出 `const ENDING_DEFS = [ ... ];` 的完整内容
// ══════════════════════════════════════════════════════════

function extractBalanced(src, startPat, open, close) {
  const i = src.search(startPat);
  if (i < 0) return null;
  const j = src.indexOf(open, i);
  if (j < 0) return null;
  let depth = 0;
  let inStr = null;      // 当前字符串定界符
  let esc = false;
  let inLine = false, inBlock = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k], n = src[k + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; k++; continue; }
    if (c === '/' && n === '*') { inBlock = true; k++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(j, k + 1); }
  }
  return null;
}

const defsSrc = extractBalanced(eng, /const ENDING_DEFS\s*=/, '[', ']');
if (!defsSrc) { console.log('❌ 定位不到 2D 的 ENDING_DEFS 数组'); process.exit(1); }

// ══════════════════════════════════════════════════════════
//  把 2D 的数组字面量**求值**出来（最忠实的比对方式）
// ══════════════════════════════════════════════════════════

// 数组里有 `check: (c) => ...` 箭头函数，直接 eval 会引入对 G 的引用 ——
// 但箭头函数体不会执行，所以安全。`FRAGMENT_DEFS` 之类的标识符在
// 这里的 check 里也没出现（都是读 c.xxx），所以能干净求值。
let twoDefs;
try {
  // 只保留数据字段，把 check 替换成占位（避免 eval 时误引用外部标识符）
  const sandboxed = defsSrc.replace(/check:\s*\([^)]*\)\s*=>[^,}]*/g, 'check: null')
    .replace(/check:\s*\(\)\s*=>[^,}]*/g, 'check: null');
  // eslint-disable-next-line no-new-func
  twoDefs = new Function('return ' + sandboxed)();
} catch (e) {
  console.log('❌ 2D ENDING_DEFS 求值失败：', e.message);
  process.exit(1);
}

// ══════════════════════════════════════════════════════════
//  比对
// ══════════════════════════════════════════════════════════

const problems = [];
let checks = 0;

// ── 1. 数组**原序** + 数量 ──
checks++;
if (twoDefs.length !== ENDING_DEFS.length) {
  problems.push(`结局数量：2D ${twoDefs.length} vs 3D ${ENDING_DEFS.length}`);
}
checks++;
if (ENDING_DEFS[ENDING_DEFS.length - 1].id !== twoDefs[twoDefs.length - 1].id) {
  problems.push(
    `数组末尾（find 全落空时的最后兜底）不一致：`
    + `2D ${twoDefs[twoDefs.length - 1].id} vs 3D ${ENDING_DEFS[ENDING_DEFS.length - 1].id}`,
  );
}
for (let i = 0; i < Math.min(twoDefs.length, ENDING_DEFS.length); i++) {
  const a = twoDefs[i], b = ENDING_DEFS[i];
  checks++;
  if (a.id !== b.id || a.rank !== b.rank || a.tone !== b.tone) {
    problems.push(`原序第 ${i} 项：2D ${a.id}#${a.rank}:${a.tone} vs 3D ${b.id}#${b.rank}:${b.tone}`);
  }
}

// ── 2. 逐字段（含正文，求值后逐字比）──
const STR_FIELDS = ['title', 'icon', 'subtitle', 'conditionText', 'text', 'epilogue'];
for (const a of twoDefs) {
  const b = ENDING_DEFS.find((d) => d.id === a.id);
  if (!b) { problems.push(`3D 缺少结局 ${a.id}`); continue; }
  for (const f of STR_FIELDS) {
    checks++;
    if ((a[f] ?? null) !== (b[f] ?? null)) {
      problems.push(`${a.id}.${f} 不一致：\n    2D: ${JSON.stringify(a[f])}\n    3D: ${JSON.stringify(b[f])}`);
    }
  }
  checks++;
  if ((a.reward ?? null) !== (b.reward ?? null)) {
    problems.push(`${a.id}.reward 不一致：2D ${JSON.stringify(a.reward)} vs 3D ${JSON.stringify(b.reward)}`);
  }
}

// ── 3. 色调表 ──
const toneSrc = extractBalanced(eng, /const ENDING_TONES\s*=/, '{', '}');
let twoTones = null;
try { twoTones = new Function('return ' + toneSrc)(); } catch (e) { problems.push('色调表求值失败：' + e.message); }
if (twoTones) {
  for (const key of Object.keys(twoTones)) {
    checks++;
    const a = twoTones[key], b = ENDING_TONES[key];
    if (!b) { problems.push(`3D 色调表缺 ${key}`); continue; }
    for (const f of ['c1', 'c2', 'c3', 'glow', 'label']) {
      checks++;
      if (a[f] !== b[f]) problems.push(`色调 ${key}.${f}：2D ${a[f]} vs 3D ${b[f]}`);
    }
  }
}

// ── 4. check 函数的行为等价（用一批人造上下文各跑一遍）──
const cases = [
  { name: '全满（完美）', c: { allBonded: true, sideDoneAll: true, loreUnlocked: 60, fragTotal: 30, fragCollected: 30, mercyDone: 9, maxAffinity: 15 } },
  { name: '碎片满', c: { allBonded: false, sideDoneAll: false, loreUnlocked: 10, fragTotal: 30, fragCollected: 30, mercyDone: 0, maxAffinity: 0 } },
  { name: '理解路线 5 次', c: { allBonded: false, sideDoneAll: false, loreUnlocked: 10, fragTotal: 30, fragCollected: 3, mercyDone: 5, maxAffinity: 0 } },
  { name: '羁绊 10', c: { allBonded: false, sideDoneAll: false, loreUnlocked: 10, fragTotal: 30, fragCollected: 3, mercyDone: 0, maxAffinity: 10 } },
  { name: '全空（3D 现状）', c: { allBonded: false, sideDoneAll: false, loreUnlocked: 0, fragTotal: 30, fragCollected: 0, mercyDone: 0, maxAffinity: 0 } },
  { name: '仅羁绊 2', c: { allBonded: false, sideDoneAll: false, loreUnlocked: 0, fragTotal: 30, fragCollected: 0, mercyDone: 0, maxAffinity: 2 } },
];

/** 复刻 2D 的 evaluate 判定（rank 排序 + 首个命中 + 数组末尾兜底） */
function judge2d(c) {
  const sorted = twoDefs.slice().sort((x, y) => x.rank - y.rank);
  const hit = sorted.find((e) => {
    // 2D 的 check 在 eval 时被替换成 null，这里重新取源码里的判定
    return checkOf(e.id)(c);
  });
  return (hit || twoDefs[twoDefs.length - 1]).id;
}

/** 从 3D 的实现里取 check */
function judge3d(c) {
  const sys = createEndingSystem();
  // ⚠️ 这里要**喂全** ending.js 支持的全部入参，包括 affinity / mercy。
  //    如果只喂 gb + progress，「全满」「理解路线」「羁绊」三个用例会
  //    被判定成「3D 侧没有这两个系统 → 读成 0」而落到 end_sleep，
  //    看起来像移植错误，其实是测试没把口子接上。
  //    ending.js 里 buildContext 早就留好了这两个参数（见那段注释），
  //    所以这里必须按它的契约喂 —— 这也顺带验证了「将来把
  //    AffinitySystem 搬过来时，判定逻辑不用改」这个承诺是真的。
  const r = sys.evaluate({
    gb: {
      wave: 60,
      fragments: new Array(c.fragCollected).fill('f'),
    },
    progress: {
      side: { done: c.sideDoneAll ? 5 : 0, total: 5 },
      lore: { unlocked: c.loreUnlocked, total: 60 },
    },
    affinity: {
      list: () => [
        { who: '林小夏', value: c.maxAffinity },
        { who: '周默', value: c.maxAffinity },
        { who: '赵磊', value: c.maxAffinity },
      ],
    },
    mercy: { done: c.mercyDone },
  });
  return r.def.id;
}

// 2D 的 check 源码：直接从 defsSrc 里按 id 抠出该段再求值
function checkOf(id) {
  const i = defsSrc.indexOf(`id: '${id}'`);
  if (i < 0) return () => false;
  // 找到该段里的 check
  const rest = defsSrc.slice(i);
  const m = rest.match(/check:\s*(\([\s\S]*?\)\s*=>[\s\S]*?)(?=\n\s*\w+:|\n\s*\}|$)/);
  if (!m) return () => false;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return (' + m[1].replace(/,\s*$/, '') + ')')();
  } catch (e) { return () => false; }
}

console.log('── 结局移植保真校验 ──');
console.log(`  结局数：2D ${twoDefs.length} / 3D ${ENDING_DEFS.length}`);
console.log(`  数组原序：${ENDING_DEFS.map((e) => e.id).join(' → ')}`);
console.log(`  判定顺序：${ENDING_DEFS.slice().sort((a, b) => a.rank - b.rank).map((e) => `${e.id}(${e.rank})`).join(' → ')}`);
console.log(`  最后兜底：${ENDING_DEFS[ENDING_DEFS.length - 1].id}`);

for (const t of cases) {
  checks++;
  const a = judge2d(t.c), b = judge3d(t.c);
  const ok = a === b;
  console.log(`  行为 [${t.name}]：2D=${a} 3D=${b} ${ok ? '✓' : '✗'}`);
  if (!ok) problems.push(`判定行为不一致 [${t.name}]：2D ${a} vs 3D ${b}`);
}

console.log(`  检查项：${checks}`);
if (problems.length) {
  console.log('\n❌ 不一致：');
  problems.forEach((p) => console.log('  · ' + p));
  process.exit(1);
}
console.log('\n✅ ending.js 与 2D EndingSystem 一致（原序/rank/tone/全部文本字段/色调表/判定行为）');
