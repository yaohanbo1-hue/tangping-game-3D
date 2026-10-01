// ============================================================
//  host.js —— 叙事运行时的「宿主接口」注入点
// ============================================================
//
// 为什么需要这个文件：
//
//   叙事包里的运行时系统（SideStorySystem / KeyEventSystem /
//   PerspectiveSystem / LoreCodex / BossLore）原本靠 `typeof xxx !== 'undefined'`
//   去探测宿主能力 —— 那是 2D 引擎「全局作用域 + 判空解耦」时代的产物。
//
//   3D 工程是真正的 ESM，没有那个全局作用域。如果运行时继续用 typeof 探测，
//   3D 侧就必须往 window 上挂一堆假全局才能让叙事跑起来 —— 那等于把
//   2D 的架构债原样搬到 3D，是不可接受的。
//
// 做法：把这些能力收敛成一个**显式的宿主对象**，运行时只认它。
//
//   ┌─────────────────────────────────────────────────────────┐
//   │  叙事运行时（本包，纯逻辑，跨 2D/3D 共用）              │
//   │      │                                                  │
//   │      └──► host.get() ──► StoryHost 接口                  │
//   │                            ▲                            │
//   │              ┌─────────────┴─────────────┐              │
//   │        2D 引擎适配                      3D 工程适配      │
//   │   （bridge 里包一层全局作用域）    （story-runtime.js）  │
//   └─────────────────────────────────────────────────────────┘
//
// ⚠️ 向后兼容：get() 在宿主没被显式注入时，会**回落到全局作用域探测**。
//    这样 2D 引擎一行不改，行为与之前完全一致（它现在就是把叙事包
//    的运行时也 bridge 回全局，两边共用同一份实现）。
//
// ── StoryHost 接口（全部可选，缺省即「这个宿主不具备该能力」）──
//
//   showDialog({ wave, speaker, text, choices, kind })  → void
//       弹出剧情对话框。kind: 'main' | 'side' | 'event' | 'perspective'
//       这是叙事层最重要的输出通道。
//
//   toast(title, body, tone, seconds)                    → void
//       一条不打断战斗的浮动提示。tone: 'gold' | 'green' | 'red' | 'blue'
//       短事件、设定解锁、章节推进都走这里。
//
//   actCard(label, title, question)                      → void
//       幕卡演出（第一幕 · 床边的第四声 / 核心疑问…）。
//
//   applyEffect(spec)                                    → void
//       结算叙事奖励。spec 是人类可读字符串（如「获得 620 金币、38 灵魂」），
//       由宿主解析。为什么不做成结构化数据：奖励文案是策划写的自由文本，
//       强行结构化会让 900 行剧情数据全部要改。
//
//   collectFragment(id)                                  → void
//       收集梦境碎片（去重 + 演出由宿主负责）。
//
//   diary(kind, text)                                    → void
//       写一条梦境日记。kind: 'story' | 'discover'
//
//   unlockLore(id)                                       → boolean
//       解锁世界观词条。**由 host 自己实现很怪** —— 词条数据就在本包里，
//       所以 LoreCodex 自己管解锁，host 只负责「解锁时提示玩家」。
//
//   getFlag(key) / setFlag(key, val)                      → any / void
//       读写宿主侧的游戏状态（比如 2D 的 G.wave、3D 的 gb.wave）。
//       只在极少数需要「当时游戏状态」的地方用。
//
//   hasWaves / waveStoryWaves 等「占用表」查询由本包内部完成，
//   不需要宿主提供 —— 数据就在本包里（WAVE_STORY / BOSS_DIALOG…）。
// ============================================================

/**
 * 缺省宿主：什么都不做的空实现。
 * 保证所有宿主接口**永远可调用**，运行时里不需要再写 `if (host.toast)`。
 * 这比「每个调用点判空」少写几十个分支，也少几十个漏判的机会。
 */
const NULL_HOST = {
  showDialog() {},
  toast() {},
  actCard() {},
  applyEffect() {},
  collectFragment() {},
  diary() {},
  getFlag() { return undefined; },
  setFlag() {},
  name: 'null',
};

let _host = null;

/**
 * 注入宿主。3D 工程在启动时调用一次；2D 引擎不调用（走全局回落）。
 * @param {object} host
 */
export function setStoryHost(host) {
  if (!host) { _host = null; return; }
  // 用 Object.create 继承空实现：宿主只需提供它真正具备的能力，
  // 其余的自动变成 no-op。这比「缺字段就报错」宽容，也比「到处判空」干净。
  _host = Object.assign(Object.create(NULL_HOST), host);
  return _host;
}

/** 取当前宿主（3D 注入的优先；没注入则回落到全局探测） */
export function getStoryHost() {
  if (_host) return _host;
  return makeGlobalHost();
}

/** 是否已显式注入宿主（调试/校验用） */
export function hasInjectedHost() { return _host !== null; }

/**
 * 2D 引擎的回落宿主：从全局作用域取同名函数。
 *
 * ⚠️ 这是**兼容层**，只服务于还没模块化的 2D 引擎。
 *    3D 侧永远不要走这条路 —— 那意味着它在往 window 上挂假全局。
 *    用 setStoryHost 显式注入是 3D 侧唯一的正确做法。
 */
function makeGlobalHost() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const call = (name) => (...args) => {
    const fn = g[name];
    if (typeof fn === 'function') {
      try { return fn(...args); } catch (e) { console.warn('[story-host] ' + name + ':', e); }
    }
    return undefined;
  };
  return Object.assign(Object.create(NULL_HOST), {
    name: 'global',
    showDialog: call('showStoryDialog'),
    toast: call('pushDreamToast'),
    actCard: call('showActCard'),
    applyEffect: call('applyStoryEffect'),
    collectFragment: (id) => {
      const df = g.DreamFragments;
      if (df && typeof df.collectFragment === 'function') {
        try { return df.collectFragment(id); } catch (e) { console.warn('[story-host] collectFragment:', e); }
      }
      return undefined;
    },
    diary: (kind, text) => {
      const dd = g.DreamDiary;
      if (dd && typeof dd.addEntry === 'function') {
        try { return dd.addEntry(kind, text); } catch (e) { console.warn('[story-host] diary:', e); }
      }
      return undefined;
    },
    getFlag: (key) => {
      const gg = g.G;
      return gg ? gg[key] : undefined;
    },
    setFlag: (key, val) => {
      const gg = g.G;
      if (gg) gg[key] = val;
    },
  });
}

/**
 * 宿主能力自检 —— 3D 侧启动时用它确认「叙事真的能显示出来」。
 * 一个只注入了 toast 却忘了 showDialog 的宿主，表现是「剧情静默丢失」，
 * 极难排查；这个自检把它变成一个启动期就能看见的警告。
 */
export function auditHost() {
  const h = getStoryHost();
  const needs = ['showDialog', 'toast', 'actCard', 'applyEffect', 'diary', 'collectFragment'];
  const missing = needs.filter((k) => {
    const fn = h[k];
    // NULL_HOST 上的 no-op 也「存在」，但它不代表宿主真的实现了。
    // 所以检查得看它是不是 NULL_HOST 的原型方法本身。
    return typeof fn !== 'function' || fn === NULL_HOST[k];
  });
  return { ok: missing.length === 0, host: h.name, missing };
}
