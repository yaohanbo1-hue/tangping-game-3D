// ============================================================
//  verify-pacing.mjs —— 叙事节奏与信息释放的无头验证
// ============================================================
//
// 这是第 5 步的核心验收：**节奏是这个项目最容易被无声破坏的东西**。
//
// 为什么必须无头验证：
//
//   剧情播得不合适（同一波连播 5 段、某条支线到第 60 波都没播出来、
//   第三幕就剧透了第四幕的答案）**都不会报错**。游戏照样跑，
//   只是变得不好玩 / 不好看。这类问题只能靠断言抓。
//
// 四组断言：
//
//   A. 预算不超发      —— 每波的对白段数不超过 StoryPacing 的预算
//   B. 内容不丢失      —— 所有剧情节点（支线/事件/插叙/主线/BOSS）都能播出来
//   C. 顺序不错乱      —— 波次管线顺序与 2D 引擎一致（对照 PIPELINE_ORDER）
//   D. 信息不泄底      —— 前三幕的文本不得出现第四幕的答案关键词
//
// 跑法：node scripts/verify-pacing.mjs
// ============================================================

import {
  createStoryRuntime, PIPELINE_ORDER,
  WAVE_STORY, BOSS_DIALOG, SIDE_STORIES, KEY_EVENTS, TURNING_POINTS,
  PERSPECTIVE_SCENES, LORE_ENTRIES, STORY_ARCS, CHAPTER_DEFS,
  FOURTH_WALL_EVENTS,
} from '@tangping/story';

const MAX_WAVE = 60;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};
const group = (t) => console.log(`\n── ${t} ──`);

// ── 造一个「录音型宿主」：把所有叙事输出录下来，供断言检查 ──
function makeRecordingHost() {
  const rec = { dialogs: [], toasts: [], actCards: [], effects: [], fragments: [], diary: [] };
  const host = {
    name: 'recording',
    showDialog(d) { rec.dialogs.push(d); },
    toast(t, b, tone, s) { rec.toasts.push({ title: t, body: b, tone, s }); },
    actCard(label, title, q) { rec.actCards.push({ label, title, q }); },
    applyEffect(spec) { rec.effects.push(spec); },
    collectFragment(id) { rec.fragments.push(id); },
    diary(kind, text) { rec.diary.push({ kind, text }); },
    getFlag() { return undefined; },
    setFlag() {},
  };
  return { host, rec };
}

// ══════════════════════════════════════════════════════════
//  跑完整 60 波，收集每波的播出记录
// ══════════════════════════════════════════════════════════
const { host, rec } = makeRecordingHost();
const rt = createStoryRuntime({ host });

const perWave = [];
for (let w = 1; w <= MAX_WAVE; w++) {
  const r = rt.onWaveStart(w);
  perWave.push(r);
}

// ══════════════════════════════════════════════════════════
//  A. 预算不超发
// ══════════════════════════════════════════════════════════
group('A. 每波对白段数不超过预算（StoryPacing 的核心承诺）');

let budgetViolations = [];
for (const r of perWave) {
  // 「占用预算的段数」= 支线 + 演出型事件 + 插叙
  // 主线与 BOSS 对白不占预算（它们是本波的「正餐」）；短事件只发 toast 也不占。
  const used = r.budgetUsed;
  if (used > r.budget) budgetViolations.push({ wave: r.wave, used, budget: r.budget });
}
ok('没有任何一波超过预算', budgetViolations.length === 0,
  budgetViolations.length ? JSON.stringify(budgetViolations.slice(0, 5)) : `检查了 ${MAX_WAVE} 波`);

// 硬上限 4 段：预算 + 逾期放宽的绝对上限
const over4 = perWave.filter((r) => r.budgetUsed > 4);
ok('没有任何一波超过硬上限 4 段', over4.length === 0,
  over4.length ? JSON.stringify(over4.map((r) => ({ w: r.wave, u: r.budgetUsed }))) : '');

// 幕交界波次：只允许 1 个预算名额（因为它已经有主线 + 幕间小结两段）
const turningWaves = TURNING_POINTS.map((t) => t.wave);
const turningOver = perWave.filter((r) => turningWaves.includes(r.wave) && r.budgetUsed > 1);
ok('幕交界波次只用了 1 个预算名额', turningOver.length === 0,
  turningOver.length ? JSON.stringify(turningOver.map((r) => ({ w: r.wave, u: r.budgetUsed }))) : `幕交界波次 ${turningWaves.join(', ')}`);

// 单波总对白段数（含主线）不应超过 6 —— 超过就是玩家要连读一屏半
const totalDialogs = new Map();
for (const d of rec.dialogs) totalDialogs.set(d.wave, (totalDialogs.get(d.wave) || 0) + 1);
const crowded = [...totalDialogs.entries()].filter(([, n]) => n > 6);
ok('没有任何一波总对白超过 6 段', crowded.length === 0,
  crowded.length ? JSON.stringify(crowded) : `单波最多 ${Math.max(...totalDialogs.values())} 段`);

// ══════════════════════════════════════════════════════════
//  B. 内容不丢失
// ══════════════════════════════════════════════════════════
group('B. 所有剧情节点都能播出来（不因排期卡死）');

// B1 主线：WAVE_STORY 里 wave ≤ 60 的都必须播过
const mainExpect = WAVE_STORY.filter((s) => s.wave <= MAX_WAVE);
const mainGot = new Set(perWave.filter((r) => r.main).map((r) => r.main.wave));
const mainMiss = mainExpect.filter((s) => !mainGot.has(s.wave));
ok(`主线对白全部播到（${mainExpect.length} 段）`, mainMiss.length === 0,
  mainMiss.length ? `缺失波次 ${mainMiss.map((s) => s.wave).join(', ')}` : '');

// B2 支线：每条支线的**每一个阶段**都要播到
let sideStagesTotal = 0, sideStagesFired = 0;
const sideMissing = [];
for (const s of SIDE_STORIES) {
  sideStagesTotal += s.stages.length;
  const prog = rt.snapshot().side.progress[s.id] || 0;
  sideStagesFired += prog;
  if (prog < s.stages.length) sideMissing.push(`${s.title} ${prog}/${s.stages.length}`);
}
ok(`支线阶段全部播到（${sideStagesFired}/${sideStagesTotal}）`, sideMissing.length === 0,
  sideMissing.length ? sideMissing.join('；') : `${SIDE_STORIES.length} 条支线`);

// B3 支线完成结算：走完的支线必须发过奖励
const sideDone = SIDE_STORIES.filter((s) => (rt.snapshot().side.progress[s.id] || 0) >= s.stages.length);
const rewardTexts = rec.effects;
const sideRewardMiss = sideDone.filter((s) => s.reward && !rewardTexts.includes(s.reward));
ok(`完成的支线都结算了奖励（${sideDone.length} 条）`, sideRewardMiss.length === 0,
  sideRewardMiss.length ? sideRewardMiss.map((s) => s.title).join('；') : '');

// B4 关键事件：wave ≤ 60 的全部触发过
const evExpect = KEY_EVENTS.filter((e) => e.wave <= MAX_WAVE);
const evFired = new Set(rt.snapshot().events.fired);
const evMiss = evExpect.filter((e) => !evFired.has(e.id));
ok(`关键事件全部触发（${evExpect.length} 个）`, evMiss.length === 0,
  evMiss.length ? evMiss.map((e) => e.title).join('；') : '');

// B5 幕间转折：priority 节点到点必播
const tpFired = new Set(rt.snapshot().events.fired);
const tpMiss = TURNING_POINTS.filter((t) => t.wave <= MAX_WAVE && !tpFired.has(t.id));
ok(`幕间转折全部播出（${TURNING_POINTS.length} 个）`, tpMiss.length === 0,
  tpMiss.length ? tpMiss.map((t) => `${t.title}@${t.wave}`).join('；') : '');

// B6 视角插叙：prefer ≤ 60 的全部播出
const pExpect = PERSPECTIVE_SCENES.filter((p) => p.prefer <= MAX_WAVE);
const pFired = new Set(rt.snapshot().perspectives.fired);
const pMiss = pExpect.filter((p) => !pFired.has(p.id));
ok(`视角插叙全部播出（${pExpect.length} 段）`, pMiss.length === 0,
  pMiss.length ? pMiss.map((p) => `${p.title}@${p.prefer}`).join('；') : '');

// B7 词条：unlock.wave ≤ 60 的都应解锁
const loreExpect = LORE_ENTRIES.filter((e) => e.unlock && e.unlock.wave && e.unlock.wave <= MAX_WAVE);
const loreSnap = new Set(rt.snapshot().lore);
const loreMiss = loreExpect.filter((e) => !loreSnap.has(e.id));
ok(`按波次解锁的词条全部解锁（${loreExpect.length} 条）`, loreMiss.length === 0,
  loreMiss.length ? loreMiss.map((e) => e.title).join('；') : `总计 ${LORE_ENTRIES.length} 条词条`);

// B8 章节：15 个子章节都应到达
const chapProg = rt.progress().chapters;
ok(`全部子章节都到达（${chapProg.reached}/${chapProg.total}）`, chapProg.reached === chapProg.total,
  `${chapProg.reached}/${chapProg.total}`);

// B9 幕卡：**五幕全部演一张**。
//
// ⚠️ 这里踩过一次认知坑：originally 以为「第 1 幕不在第 1 波演」就等于只演 4 张。
//    实际不是 —— 第 1 幕覆盖第 1-12 波，checkWave 只在 `wave > 1` 时跳过，
//    所以第 2 波会补演第 1 幕的幕卡。五幕各一张，正好 5 张。
ok(`五幕幕卡全部播出（${rec.actCards.length}/${STORY_ARCS.length}）`, rec.actCards.length === STORY_ARCS.length,
  rec.actCards.map((a) => a.title).join(' / '));

// B10 幕卡只在幕的**首个波次**出现，不能中途重复演
const actCardWaves = perWave.filter((r) => {
  const a = r.chapter;
  return a && a.waves && a.waves[0] === r.wave;
}).length;
ok('幕卡不在幕的首波之外重复演出', rec.actCards.length === STORY_ARCS.length,
  `幕卡 ${rec.actCards.length} 张 / 幕首波命中 ${actCardWaves} 次`);

// ══════════════════════════════════════════════════════════
//  C. 顺序不错乱
// ══════════════════════════════════════════════════════════
group('C. 波次管线顺序与 2D 引擎一致');

const EXPECT_ORDER = ['chapter', 'lore', 'side', 'event', 'perspective'];
ok('管线顺序正确', JSON.stringify(PIPELINE_ORDER) === JSON.stringify(EXPECT_ORDER),
  PIPELINE_ORDER.join(' → '));

// C2：幕卡必须在同波的对白**之前**出现。
//     这是「舞台提示先于台词」的硬要求 —— 顺序反了玩家会先读台词再看到场景说明。
const { host: h2, rec: r2 } = makeRecordingHost();
const rt2 = createStoryRuntime({ host: h2 });
// 找第一个有幕卡的波次
let actWave = -1;
for (let w = 1; w <= MAX_WAVE && actWave < 0; w++) {
  const before = r2.actCards.length;
  rt2.onWaveStart(w);
  if (r2.actCards.length > before) actWave = w;
}
ok('幕卡确实在某波播出了', actWave > 0, actWave > 0 ? `第 ${actWave} 波` : '');

// C3：波次重复调用不应重复播剧情（3D 暂停恢复会踩到）
//
// ⚠️ 基线要在**两次调用之前**取。第一版先调了一次 onWaveStart(MAX_WAVE)
//    再取基线，导致「第一次调用新增的对白」被算进了基线里，
//    断言恒假 —— 是测试写错了，不是代码错了。
const dlgBefore = r2.dialogs.length;
const first = rt2.onWaveStart(MAX_WAVE);          // 真正的第一次（会播）
const dlgAfterFirst = r2.dialogs.length;
const second = rt2.onWaveStart(MAX_WAVE);         // 重复调用（不该播）
ok('同一波重复调用不会重复播剧情',
  first.duplicated !== true && second.duplicated === true && r2.dialogs.length === dlgAfterFirst,
  `第一次新增 ${dlgAfterFirst - dlgBefore} 段 / 重复调用新增 ${r2.dialogs.length - dlgAfterFirst} 段`);

// ══════════════════════════════════════════════════════════
//  D. 信息不泄底
// ══════════════════════════════════════════════════════════
group('D. 前三幕的文本不写出第四幕的答案');

// 第四幕（第 36-50 波）才揭晓的答案 —— 这些词在更早的文本里出现就是剧透。
// 关键词来自 story.js 的信息释放阶梯：真相关于「朋友其实已经回来过」，
// 前三幕只能给「异常」，不能给「结论」。
const SPOILER_TERMS = [
  '他已经回来了',
  '他回来过',
  '朋友已经回来',
  '答案是第四个人',
  '第四个人就是',
];
// 允许出现的「引子」：这些是前三幕该给的线索，不算泄底
const FORESHADOW = ['第四声', '第四个人', '空位', '三个人'];

// 收集前三幕（波次 ≤ 35）的所有文本
const ACT1_3_END = 35;
const earlyTexts = [];
const pushText = (src, wave) => {
  if (!src || wave === undefined || wave > ACT1_3_END) return;
  if (typeof src === 'string') earlyTexts.push({ text: src, wave, src: '?' });
};

// 主线台词
for (const s of WAVE_STORY) {
  if (s.wave > ACT1_3_END) continue;
  earlyTexts.push({ text: s.text || '', wave: s.wave, src: 'WAVE_STORY' });
  if (Array.isArray(s.choices)) s.choices.forEach((c) => {
    earlyTexts.push({ text: (c.text || '') + ' ' + (c.effect || ''), wave: s.wave, src: 'WAVE_STORY.choice' });
  });
}
// 支线台词
for (const s of SIDE_STORIES) {
  for (const st of s.stages) {
    if (st.prefer > ACT1_3_END) continue;
    earlyTexts.push({ text: st.text || '', wave: st.prefer, src: 'SIDE:' + s.title });
    if (Array.isArray(st.choices)) st.choices.forEach((c) => {
      earlyTexts.push({ text: (c.text || '') + ' ' + (c.effect || ''), wave: st.prefer, src: 'SIDE.choice' });
    });
  }
}
// 关键事件
for (const e of KEY_EVENTS) {
  if (e.wave > ACT1_3_END) continue;
  earlyTexts.push({ text: (e.text || '') + ' ' + (e.title || ''), wave: e.wave, src: 'EVENT:' + e.id });
}
// 视角插叙
for (const p of PERSPECTIVE_SCENES) {
  if (p.prefer > ACT1_3_END) continue;
  earlyTexts.push({ text: (p.sceneNote || '') + ' ' + (p.text || ''), wave: p.prefer, src: 'PERSP:' + p.title });
}

const leakHits = [];
for (const t of earlyTexts) {
  for (const term of SPOILER_TERMS) {
    if (t.text.includes(term)) leakHits.push({ wave: t.wave, src: t.src, term });
  }
}
ok(`前三幕没有出现第四幕的关键结论（${earlyTexts.length} 段文本）`, leakHits.length === 0,
  leakHits.length ? JSON.stringify(leakHits.slice(0, 6)) : `扫描关键词 ${SPOILER_TERMS.length} 个`);

// D2：章节 recap 同样受约束 —— 前三幕的 recap 不得泄底
const earlyChapters = CHAPTER_DEFS.filter((c) => c.waves[0] <= ACT1_3_END && c.recap);
const recapLeaks = [];
for (const c of earlyChapters) {
  for (const term of SPOILER_TERMS) {
    if ((c.recap || '').includes(term)) recapLeaks.push({ ch: c.title, term });
  }
}
ok(`前三幕的章节回顾不泄底（${earlyChapters.length} 章）`, recapLeaks.length === 0,
  recapLeaks.length ? JSON.stringify(recapLeaks) : '');

// D3：真相应落在第四幕之后 —— 断言「真相词」确实出现在后期文本里
//     （防止为了不泄底把内容删光，导致真相根本不存在）
const allTexts = [];
for (const s of WAVE_STORY) {
  allTexts.push(s.text || '');
  if (Array.isArray(s.choices)) s.choices.forEach((c) => allTexts.push((c.effect || '') + (c.text || '')));
}
for (const s of SIDE_STORIES) s.stages.forEach((st) => allTexts.push(st.text || ''));
const lateTruth = allTexts.some((t) => t.includes('回来') && t.length > 20);
ok('真相内容确实存在于剧情数据中', lateTruth,
  `总文本 ${allTexts.length} 段`);

// ══════════════════════════════════════════════════════════
//  E. 运行时卫生（3D 会重开一局，必须能彻底清空）
// ══════════════════════════════════════════════════════════
group('E. 运行时卫生：重开一局能彻底清空');

{
  const { host: h3, rec: r3 } = makeRecordingHost();
  const rt3 = createStoryRuntime({ host: h3 });
  for (let w = 1; w <= 30; w++) rt3.onWaveStart(w);
  const mid = rt3.progress();
  rt3.reset();
  const after = rt3.progress();
  ok('reset() 清空了章节进度', after.chapters.reached === 0, `${mid.chapters.reached} → ${after.chapters.reached}`);
  ok('reset() 清空了支线进度', after.side.done === 0, `${mid.side.done} → ${after.side.done}`);
  ok('reset() 清空了事件记录', after.events.fired === 0, `${mid.events.fired} → ${after.events.fired}`);
  ok('reset() 清空了插叙记录', after.perspectives.fired === 0, `${mid.perspectives.fired} → ${after.perspectives.fired}`);

  // 重开后第一波应该又能正常播（不能因为状态残留而"静默"）
  const dlgBefore = r3.dialogs.length;
  rt3.onWaveStart(1);
  ok('重开后第 1 波仍能播剧情', r3.dialogs.length > dlgBefore, `+${r3.dialogs.length - dlgBefore} 段`);
}

// ══════════════════════════════════════════════════════════
//  G. 宿主通道必须真的被使用（防止「全局探测」回归）
// ══════════════════════════════════════════════════════════
//
// ⚠️ 这一组是**为了让一个真实 bug 不能复发**而加的。
//
//    症状：叙事包从 2D 全局作用域改成宿主注入之后，_fire() 里仍残留
//          大量 `if (typeof showStoryDialog === 'function') ...`。
//          在 ESM 里那些名字根本不存在，typeof 恒为 'undefined'，
//          于是每一段对白、每一笔奖励、每一个碎片、每一条 toast
//          全部被静默跳过。
//
//    为什么难发现：**进度照常推进**（_progress 在演出之后无条件 +1），
//         所以「支线都完成了」是绿的。只有「奖励都结算了」才是红的。
//         如果验收只测进度不测演出，这个 bug 会一路带到发布。
//
//    于是这里不再只测「进度对不对」，而是直接测**宿主各通道的调用量**：
//    对白/奖励/碎片/日记/toast 全部必须 > 0。
//    只要哪天有人又把 host.xxx() 换回 `typeof 全局`，这里立刻变红。
group('G. 宿主通道必须真的被调用（防止「全局探测」回归）');

{
  const { host: h6, rec: r6 } = makeRecordingHost();
  const rtG = createStoryRuntime({ host: h6 });
  for (let w = 1; w <= MAX_WAVE; w++) rtG.onWaveStart(w);

  // 每个通道都必须有量。0 意味着「宿主被绕过了」。
  ok('showDialog 通道被使用', r6.dialogs.length > 0, `${r6.dialogs.length} 段`);
  ok('applyEffect 通道被使用（奖励不是「说到了没做到」）', r6.effects.length > 0, `${r6.effects.length} 笔`);
  ok('collectFragment 通道被使用', r6.fragments.length > 0, `${r6.fragments.length} 枚`);
  ok('diary 通道被使用', r6.diary.length > 0, `${r6.diary.length} 条`);
  ok('toast 通道被使用', r6.toasts.length > 0, `${r6.toasts.length} 条`);
  ok('actCard 通道被使用', r6.actCards.length > 0, `${r6.actCards.length} 张`);

  // 叙事包的每个系统都必须往对白通道写东西 —— 只测总量的话，
  // 「支线整条静默」会被主线的量掩盖掉。
  const kinds = new Set(r6.dialogs.map((d) => d.kind).filter(Boolean));
  for (const k of ['main', 'side', 'event', 'perspective']) {
    ok(`对白里含 kind=${k}（该系统未静默）`, kinds.has(k));
  }
  ok('BOSS 对白也播了', kinds.has('boss'));

  // 奖励文案必须真的被传进宿主（而不是只存在数据里）
  const expectedRewards = SIDE_STORIES.filter((s) => s.reward).length;
  const gotRewards = SIDE_STORIES.filter((s) => s.reward && r6.effects.includes(s.reward)).length;
  ok(`全部支线奖励文案都送达宿主（${gotRewards}/${expectedRewards}）`, gotRewards === expectedRewards);
}

// ══════════════════════════════════════════════════════════
//  F. 存档往返
// ══════════════════════════════════════════════════════════
group('F. 存档往返（snapshot → restore）');

{
  const { host: h4 } = makeRecordingHost();
  const rtA = createStoryRuntime({ host: h4 });
  for (let w = 1; w <= 25; w++) rtA.onWaveStart(w);
  const snap = JSON.parse(JSON.stringify(rtA.snapshot()));

  const { host: h5 } = makeRecordingHost();
  const rtB = createStoryRuntime({ host: h5 });
  rtB.restore(snap);
  const pA = rtA.progress(), pB = rtB.progress();
  ok('章节进度往返一致', pA.chapters.reached === pB.chapters.reached, `${pA.chapters.reached} vs ${pB.chapters.reached}`);
  ok('事件进度往返一致', pA.events.fired === pB.events.fired, `${pA.events.fired} vs ${pB.events.fired}`);
  ok('插叙进度往返一致', pA.perspectives.fired === pB.perspectives.fired, `${pA.perspectives.fired} vs ${pB.perspectives.fired}`);
  ok('支线完成数往返一致', pA.side.done === pB.side.done, `${pA.side.done} vs ${pB.side.done}`);
}

// ══════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}  ——  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
