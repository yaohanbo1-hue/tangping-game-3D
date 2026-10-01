// ============================================================
//  check-story-media.cjs —— 校验 6 条剧情镜头素材确实在仓库里
// ============================================================
//
//  为什么需要这个检查：
//
//    素材是**外置文件**，而且历史上正好踩过一次坑 —— 3D 工程的 .gitignore
//    里写着 `public/assets/story/*.mp4`，意味着这些视频**不会进仓库**。
//    如果带着这条规则发布，GitHub Pages 上会是一个没有剧情镜头的版本，
//    而且**不会有任何报错**（游戏本来就设计成"素材缺失时静默退回纯文字"）。
//
//    这正是本项目最怕的一类失败：静默降级，看起来一切正常。
//    所以把它变成构建期可见的检查。
//
//  用法：node scripts/check-story-media.cjs
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'assets', 'story');

// 六个镜头位，与叙事包的 STORY_VIDEO_SLOTS 键名一致
const EXPECTED = [
  'wake_0307.mp4',
  'first_return.mp4',
  'ledger_four.mp4',
  'mirror_bed.mp4',
  'message_0307.mp4',
  'morning_door.mp4',
];

// 单个文件至少要有这么大 —— 防止把 0 字节占位文件当成素材提交
const MIN_BYTES = 100 * 1024;

const missing = [];
const tooSmall = [];
let total = 0;

for (const name of EXPECTED) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) { missing.push(name); continue; }
  const size = fs.statSync(p).size;
  total += size;
  if (size < MIN_BYTES) tooSmall.push(`${name}（${size} 字节）`);
}

console.log('剧情镜头素材检查：' + EXPECTED.length + ' 个镜头位');
for (const name of EXPECTED) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) { console.log('  ❌ ' + name + '  缺失'); continue; }
  const mb = (fs.statSync(p).size / 1048576).toFixed(2);
  console.log('  ✅ ' + name.padEnd(20) + mb + ' MB');
}

if (missing.length || tooSmall.length) {
  console.error('\n❌ 素材不完整：');
  if (missing.length) console.error('   缺失：' + missing.join(', '));
  if (tooSmall.length) console.error('   过小（疑似占位文件）：' + tooSmall.join(', '));
  console.error('   注意：游戏会静默退回纯文字，不会报错 —— 所以必须在这里拦住。');
  process.exit(1);
}

console.log('\n✅ 全部就位，共 ' + (total / 1048576).toFixed(1) + ' MB');
