// 生产构建产物验证：起 vite preview，确认 dist/ 真的能跑。
// 只看构建日志不算数 —— 分包错了、路径错了、资源没加载，都只有真跑才知道。
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';

(async () => {
  const { chromium } = require(PW);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('[reqfail] ' + r.url()));

  await page.goto('http://localhost:5274/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const res = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    if (!T) return { ready: false };
    T.reset(); T.tick(900);
    return {
      ready: true,
      snapshot: T.snapshot(),
      contract: T.contract(),
      story: document.getElementById('story-state')?.textContent || '',
    };
  });

  console.log('调试面就绪:', res.ready);
  if (res.ready) {
    console.log('推演 15s:', JSON.stringify({ alive: res.snapshot.alive, spawned: res.snapshot.spawned, breaches: res.snapshot.breaches }));
    console.log('契约:', res.contract.ok ? 'PASS' : 'FAIL');
    console.log('叙事包:', res.story);
    await page.screenshot({ path: 'ui-review-3d/shot-3d-dist.png' });
    console.log('截图: shot-3d-dist.png');
  }
  if (errors.length) {
    console.log('\n❌ 生产产物有问题:');
    errors.forEach((e) => console.log('  ' + e));
  } else {
    console.log('\n✅ 生产产物无错误');
  }
  await browser.close();
  process.exit(errors.length || !res.ready ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
