// ============================================================
//  verify-imports.mjs —— 架构边界静态检查
// ============================================================
//
// 第 3 步的验收标准之一是「范围不膨胀」。这个脚本用**文本扫描**守着三条边界：
//
//   边界 1  3D 工程不得 import 2D 引擎包
//            （core.js / render.js / ui.js / data.js / main.js …）
//            第 4 步接入战斗规则时，应该是「把规则搬过来」或
//            「通过一个明确的适配层 import」，而不是随手 import 整个引擎。
//
//   边界 2  只有 src/story.js 与 src/story-runtime.js 允许 import '@tangping/story'
//            防止叙事包耦合渗透到渲染/模拟层，将来换数据源要改一堆文件。
//
//            ⚠️ 第 5 步把 story-runtime.js 加进白名单，是因为它要实现
//            StoryHost 并把运行时工厂接进 3D（那本来就是「适配层」的活）。
//            白名单**只有这两个**，且两者都必须是「翻译」而不是「游戏逻辑」：
//               story.js         —— 数据 + 运行时工厂的再出口
//               story-runtime.js —— StoryHost 的 3D 实现 + 奖励文案解析
//            任何渲染 / 模拟 / UI 文件出现在这里都算腐化。
//
//   边界 3  src/world.js 不得 import 任何东西（除了空）
//            它是纯函数 + 常量模块，一旦它开始依赖别处，
//            「坐标契约」就不再是单一真相源了。
//
//   边界 4  src/rules/** 不得 import three / DOM / 任何 src/ 上层模块
//            这是第 4 步新加的最重要一条：规则层必须能在**纯 Node**
//            里跑（verify-rules / verify-combat 就是这么测的）。
//            一旦 rules/ 里出现 `import ... from 'three'`，
//            规则层立刻无法脱离浏览器测试，第 4 步的全部测试会静默失效。
//
//   边界 5  src/rules/** 不得直接读写 enemy.x / enemy.y
//            去像素化之后敌人没有 x/y 字段，位置一律走 ctx.xyOf()。
//            直写 .x/.y 会让「渲染改坐标顺带改逻辑」的老坑重演。
//
//   边界 6  叙事包（../tangping-game/src/story）不得用 `typeof 全局名` 探测宿主通道
//            包里的演出代码原本住在 2D 引擎的全局作用域，靠 typeof 判空调用
//            showStoryDialog / applyStoryEffect / pushDreamToast 等。
//            收成 ESM 包之后那些名字不存在，typeof 恒为 undefined，
//            演出被**静默跳过**（进度却照常推进，所以不容易发现）。
//            这条边界用源码文本把这类回归挡在测试里。
//
// 用法：node scripts/verify-imports.mjs
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const RULES = path.join(SRC, 'rules');

/** 2D 引擎的文件名 —— 出现在 import 路径里就是越界 */
const ENGINE_FILES = [
  'core.js', 'render.js', 'ui.js', 'data.js', 'names.js',
  'save.js', 'net.js', 'dream.js', 'quest.js', 'vendor-engine.js',
  'characters.js', 'chapters.js', 'endings.js', 'letters.js', 'story-bridge.js',
];

/** 允许 import @tangping/story 的文件（白名单，只有适配层） */
const STORY_ALLOWED = new Set(['story.js', 'story-runtime.js']);

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listJs(p));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 抓出所有 import ... from '...' 与裸 import '...' */
function extractImports(code) {
  const specs = [];
  const re = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) specs.push(m[1]);
  return specs;
}

const files = listJs(SRC);
const problems = [];
const report = [];

for (const file of files) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const code = fs.readFileSync(file, 'utf8');
  const specs = extractImports(code);
  report.push({ rel, imports: specs });

  for (const spec of specs) {
    // ⚠️ 只对**外部**依赖做名字匹配。
    //    相对路径 './save.js' 指的是 3D 工程**自己**的 src/save.js，
    //    与 2D 引擎的 save.js 同名但毫无关系 —— 早期版本按 basename
    //    匹配，于是 3D 自己新建一个 save.js 就被误判成「引入了 2D 引擎」。
    //    这是一个真实的假阳性：边界检查必须区分「同名」与「同源」。
    const isLocal = spec.startsWith('./') || spec.startsWith('../');
    const base = spec.split('/').pop();
    if (!isLocal && ENGINE_FILES.includes(base)) {
      problems.push(`[边界1] ${rel} 引入了 2D 引擎文件 '${spec}' —— 第 3 步不允许（第 4 步需显式适配）`);
    }
    if (/(^|\/)tangping-game\//.test(spec)) {
      problems.push(`[边界1] ${rel} 直接跨目录引入 tangping-game/：'${spec}'`);
    }

    // ── 边界 2：叙事包只许适配层 import ──
    if (spec === '@tangping/story' || spec.startsWith('@tangping/story/')) {
      if (!STORY_ALLOWED.has(rel)) {
        problems.push(`[边界2] ${rel} 直接 import 了叙事包 —— 只有 ${[...STORY_ALLOWED].join(' / ')} 可以`);
      }
    }

    // ── 边界 3：world.js 必须是纯模块 ──
    if (rel === 'world.js' && specs.length > 0) {
      problems.push(`[边界3] src/world.js 不应有任何 import，实为 ${specs.length} 个`);
    }

    // ── 边界 4：rules/ 必须能在纯 Node 里跑 ──
    if (rel.startsWith('rules/')) {
      if (spec === 'three' || spec.startsWith('three/')) {
        problems.push(`[边界4] ${rel} import 了 three —— 规则层必须零渲染依赖（纯 Node 可测）`);
      }
      // rules/ 只能 import 同层的 ./xxx.js，不许往上跳
      if (spec.startsWith('../') || /^\//.test(spec)) {
        problems.push(`[边界4] ${rel} 用了向上/绝对路径 '${spec}' —— 规则层只允许 import 同层模块`);
      }
    }
  }
}

// ── 边界 5：rules/ 不得直接读写 .x / .y（位置必须走 xyOf）──
{
  const RULE_ALLOW = new Set([
    // math.js 就是「位置解算」的所在地，它当然要读 .x/.y
    'math.js',
  ]);
  for (const name of fs.readdirSync(RULES)) {
    if (!name.endsWith('.js') || RULE_ALLOW.has(name)) continue;
    const raw = fs.readFileSync(path.join(RULES, name), 'utf8');
    // ⚠️ 必须先剥掉注释，否则「文档里举例说明 2D 怎么写 e.x = ...」
    //    会被误判成违规 —— wave.js 的文件头就有这样的示例注释。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 这种）
    // 只禁「对形参 e 的赋值」这种最常见误用模式。
    const enemyAssign = code.match(/\be\.(?:x|y)\s*(?:[-+*/]?=)/g) || [];
    if (enemyAssign.length) {
      problems.push(`[边界5] rules/${name} 直接给 e.x / e.y 赋值（${enemyAssign.join(', ')}）—— 位置真值只有 lane + progress，请走 ctx.knockProgress / pullProgress`);
    }
  }
}

// ── 额外检查：world.js 里不得出现 three / DOM ──
const worldCode = fs.readFileSync(path.join(SRC, 'world.js'), 'utf8');
for (const banned of ['document', 'window', 'three', 'THREE']) {
  if (new RegExp(`\\b${banned}\\b`).test(worldCode)) {
    problems.push(`[边界3] src/world.js 出现了 '${banned}' —— 它必须是纯坐标契约模块`);
  }
}

// ── 额外检查：sim.js 不得出现像素级硬编码字段 ──
const simCode = fs.readFileSync(path.join(SRC, 'sim.js'), 'utf8');
const pxFieldUse = /\.x\s*[-+*/]?=|e\.y\s*[-+*/]?=/.test(simCode);
if (pxFieldUse) {
  problems.push('[边界4] src/sim.js 似乎在直接给 .x/.y 赋值 —— 去像素化的真值源应只有 lane + progress');
}

// ── 边界 6：叙事包不得靠「全局探测」实现宿主通道 ──
//
// 叙事包（../tangping-game/src/story）里的 `_fire()` 之类的演出代码，
// 曾经用 `if (typeof showStoryDialog === 'function') showStoryDialog(...)`
// 这种写法 —— 那是因为它住在 2D 引擎的全局作用域里。
//
// 收进 ESM 包之后，`showStoryDialog` / `applyStoryEffect` / `pushDreamToast`
// / `DreamDiary` / `DreamFragments` / `LoreCodex` / `StoryPacing` 全都
// 不存在了，`typeof` 恒为 'undefined'，于是：
//    每一段对白、每一笔奖励、每一个碎片、每一条 toast 被**静默跳过**。
//
// 这个 bug 的可怕之处是进度照常推进，所以「支线都完成了」还是绿的 ——
// 只有「奖励都结算了」才会红。所以除了行为断言（verify-pacing 的 G 组），
// 再加一道**源码文本**断言：这几个名字不许以「全局探测」形式出现。
{
  // 叙事包的位置随仓库形态而变：
  //   · 开发工作目录：与 2D 工程平级，包在 ../tangping-game/src/story
  //   · 独立发布仓库：包被复制进 ./packages/story
  // 两个都找，找到哪个用哪个。
  const STORY_CANDIDATES = [
    path.join(__dirname, '..', 'packages', 'story'),
    path.join(__dirname, '..', '..', 'tangping-game', 'src', 'story'),
  ];
  const STORY = STORY_CANDIDATES.find((p) => fs.existsSync(p)) || null;

  // ⚠️ 找不到就**报错**，不要静默跳过。
  //    这条边界抓到过 11 处真漏改，是本套件里最有价值的一条。
  //    早先它写成 `if (fs.existsSync(STORY)) { ... }` —— 路径一变，
  //    整段检查就悄悄不执行了，而套件仍然打印「架构边界检查通过」。
  //    一个会静默跳过的检查比没有检查更糟：它让人以为验过了。
  if (!STORY) {
    problems.push('[边界6] 找不到叙事包目录，无法执行全局探测检查 —— '
      + '试过：' + STORY_CANDIDATES.join(' / ')
      + '。请确认 packages/story 存在（或 2D 工程在场）。');
  }

  // 只允许出现在 host.js 里（那是给 2D 回落用的 makeGlobalHost，
  // 它**本来**就是要读 globalThis 的兼容层）。
  const ALLOW = new Set(['host.js']);
  // 这些是「2D 引擎全局」的名字，包里不该再有它们的 typeof 探测
  const FORBIDDEN = [
    'showStoryDialog', 'applyStoryEffect', 'pushDreamToast',
    'DreamDiary', 'DreamFragments', 'LetterSystem', 'QuestSystem',
  ];
  if (STORY) {
    let scanned = 0;
    for (const name of fs.readdirSync(STORY)) {
      if (!name.endsWith('.js') || ALLOW.has(name)) continue;
      scanned++;
      const raw = fs.readFileSync(path.join(STORY, name), 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const sym of FORBIDDEN) {
        // 匹配 `typeof showStoryDialog` 这类探测
        const re = new RegExp(`typeof\\s+${sym}\\b`);
        if (re.test(code)) {
          problems.push(`[边界6] 叙事包 ${name} 用 \`typeof ${sym}\` 做全局探测 —— `
            + `在 ESM 里它恒为 undefined，该通道会被静默跳过。请改走 getStoryHost().xxx()`);
        }
      }
    }
    // 扫到 0 个文件也说明路径不对 —— 同样要报出来，不能"0 个问题"就绿
    if (scanned === 0) {
      problems.push(`[边界6] 叙事包目录里没有可扫描的 .js：${STORY}`);
    }
    console.log(`── 边界6：已扫描叙事包 ${scanned} 个文件（${path.relative(path.join(__dirname, '..'), STORY)}）──`);
  }
}

console.log('── 模块依赖 ──');
for (const r of report) {
  console.log(`  ${r.rel.padEnd(14)} ${r.imports.length ? '← ' + r.imports.join(', ') : '（无依赖）'}`);
}

console.log('');
if (problems.length) {
  console.log('❌ 边界检查未通过：');
  problems.forEach((p) => console.log('  · ' + p));
  process.exit(1);
}
console.log('✅ 架构边界检查通过（3D 无引擎耦合 / 叙事包仅适配层可见 / world.js 纯净 / rules 纯逻辑 / 位置只走 xyOf / 叙事包无全局探测）');
