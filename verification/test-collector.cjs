const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const core = require('../yollgo-collector.user.js');
const script = fs.readFileSync(require.resolve('../yollgo-collector.user.js'), 'utf8');
const API = 'https://ssl.freex.es/api/articulos/6085';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=', 'base64');
const artifactDir = path.resolve(process.env.YOLLGO_TEST_OUTPUT || path.join(__dirname, '../work/verification'));
fs.mkdirSync(artifactDir, { recursive: true });
const checks = [];
const pass = s => { checks.push(s); console.log('PASS', s); };
const product = (id, extra = {}) => ({ artId: id, mulUID: '004', namecn: '测试商品', namees: 'Prueba', precio: 2.5, ...extra });
(async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(core.context('{"muluid":"004","submuluid":"0001","token":"fixture-secret"}', API))), { shopid: '6085', muluid: '004', submuluid: '0001' });
  assert.equal(core.context(new URLSearchParams('muluid=004'), API).muluid, '004');
  const fd = new FormData(); fd.set('muluid', '004'); assert.equal(core.context(fd, API).muluid, '004');
  assert.equal(core.lists({ a: { articulo_lists: [] }, b: { articulo_lists: [] } }), null);
  assert.ok(!JSON.stringify(core.clean({ raw: { access_token: 'secret', 'API-Key': 'secret', x: 'Bearer fixture-secret' }, url: 'https://e.test/a?sign=x' })).includes('secret'));
  assert.equal(core.hashInURL('abcdefgh', 'https://e.test/abcdefgh.webp'), true);
  assert.equal(core.hashInURL('abcdefgh', 'https://e.test/prefix-abcdefgh.webp'), false);
  const observed = new Set(['https://e.test/abcdefgh.webp']);
  const rows = [core.merge(null, product('1', { imageHash: 'abcdefgh' }), {}, '2026-10-10T00:00:00Z'), core.merge(null, product('2', { imageHash: 'abcdefgh' }), {}, '2026-10-10T00:00:00Z')];
  assert.equal(core.matchImages(rows, observed, new Map(), 'now').length, 0);
  const firstMatched = core.matchImages([rows[0]], observed, new Map(), 'now')[0];
  assert.equal(firstMatched.images.length, 1);
  assert.equal(core.matchImages([firstMatched, rows[1]], observed, new Map(), 'later')[0].images.length, 0);
  assert.equal(core.matchImages([firstMatched, rows[1]], new Set(), new Map(), 'later')[0].images.length, 0);
  assert.ok(core.csv([{ namecn: ' \t=HYPERLINK("bad")' }]).includes("' \t=HYPERLINK"));
  pass('纯函数：类目白名单、凭据过滤、歧义数组、共享 hash 不关联、CSV 公式防护');

  const server = http.createServer((req, res) => {
    if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><body><h1>商品测试页面（本地模拟）</h1><main></main></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  let responseRows = [], delay = 0, apiCount = 0, requests = [];
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    await ctx.addInitScript({ content: script });
    await ctx.route('https://ssl.freex.es/**', async route => {
      const req = route.request(); apiCount++; requests.push({ url: req.url(), method: req.method(), body: req.postData() });
      const current = responseRows, ms = delay; if (ms) await new Promise(r => setTimeout(r, ms));
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ data: { articulo_lists: current }, auth_token: 'envelope-secret' }) });
    });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto(base);
    await page.getByRole('status').filter({ hasText: '监听已就绪' }).waitFor();
    async function send(rows, category = '004', mode = 'fetch', api = API) {
      responseRows = rows;
      return page.evaluate(async ({ api, category, mode }) => {
        const body = `shopid=6085&muluid=${category}&submuluid=001`;
        if (mode.startsWith('xhr')) return new Promise((resolve, reject) => {
          const x = new XMLHttpRequest(); x.open('POST', api); if (mode === 'xhr-json') x.responseType = 'json';
          x.onload = () => resolve(mode === 'xhr-json' ? x.response : JSON.parse(x.responseText)); x.onerror = reject; x.send(body);
        });
        if (mode === 'request') return (await fetch(new Request(api, { method: 'POST', body }))).json();
        return (await fetch(api, { method: 'POST', body })).json();
      }, { api, category, mode });
    }
    async function count(n, duplicates) {
      const text = `商品 ${n} · 重复命中 ${duplicates}`;
      await page.locator('[data-summary]').filter({ hasText: text }).waitFor();
    }
    async function exported(button = '导出 JSON') {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
      return { data: JSON.parse(fs.readFileSync(await download.path(), 'utf8')), filename: download.suggestedFilename() };
    }
    await send([product('001', { access_token: 'row-secret', attributes: { color: 'red', signature: 'nested-secret' }, extra: 'keep' }), { namecn: 'missing id' }]);
    await count(1, 0);
    assert.equal((await exported()).data.products[0].raw.extra, 'keep');
    pass('Fetch JSON 对网页仍可读，捕获单类目，跳过无 artId 商品');
    await send([product('001', { precio: 9 }), product('002')], '005', 'xhr-json');
    await count(2, 1);
    let data = (await exported()).data;
    assert.equal(data.products.find(p => p.artId === '001').sources.length, 2);
    assert.equal(data.products.find(p => p.artId === '001').precio, 9);
    assert.ok(!JSON.stringify(data).includes('secret'));
    pass('XHR responseType=json、跨类目按 artId 合并，更新字段并保留来源');
    await send([product('003')], '006', 'xhr-text'); await count(3, 1);
    await send([product('004')], '007', 'request'); await count(4, 1);
    assert.equal((await exported()).data.products.find(p => p.artId === '004').sources[0].muluid, null);
    pass('XHR 文本响应、Request 对象正文不读取且网页仍可读');
    const before = apiCount; await page.waitForTimeout(1100); assert.equal(apiCount, before);
    await send([product('wrong-shop')], '004', 'fetch', API.replace('6085', '9999')); await count(4, 1);
    pass('不会自行重放 API；忽略其他店铺接口');

    delay = 300;
    responseRows = [product('late')];
    await page.evaluate(api => { window.fixturePending = fetch(api, { method: 'POST', body: 'muluid=004' }).then(r => r.json()); }, API);
    await page.getByRole('button', { name: '暂停采集', exact: true }).click();
    await page.getByRole('button', { name: '恢复采集', exact: true }).click();
    await page.evaluate(() => window.fixturePending); delay = 0;
    await count(4, 1); assert.ok(!(await exported()).data.products.some(p => p.artId === 'late'));
    await page.getByRole('button', { name: '暂停采集', exact: true }).click();
    await send([product('paused')]); await count(4, 1);
    await page.reload(); await page.getByRole('button', { name: '恢复采集', exact: true }).waitFor(); await count(4, 1);
    pass('暂停跨刷新保存，暂停/恢复后不接收旧在途响应，IndexedDB 商品仍在');
    await page.getByRole('button', { name: '恢复采集', exact: true }).click();
    await send([product('001', { imageHash: 'uniquehash001' }), product('002'), product('005', { imageHash: 'sharedhash12' }), product('006', { imageHash: 'sharedhash12' })]);
    await count(6, 3);
    await page.evaluate(base => {
      const main = document.querySelector('main');
      main.innerHTML = `<img src="${base}/uniquehash001.png"><article data-art-id="002"><img src="${base}/explicit.png"></article><img src="${base}/sharedhash12.png"><img src="${base}/unknown.png"><img src="${base}/signed.png?token=fixture-secret">`;
    }, base);
    await page.locator('[data-images]').filter({ hasText: '图片已匹配 2' }).waitFor();
    data = (await exported()).data;
    assert.equal(data.products.find(p => p.artId === '001').images[0].evidence, 'unique-hash-token+observed-resource');
    assert.equal(data.products.find(p => p.artId === '002').images[0].evidence, 'explicit-dom-artId+loaded-image');
    assert.equal(data.products.find(p => p.artId === '005').imageStatus, 'pending');
    assert.ok(!JSON.stringify(data).includes('signed.png'));
    pass('真实图片资源：唯一 hash 完整路径片段与显式 DOM artId 匹配；共享 hash、未知图片、带凭据 URL 不关联');

    const follower = await ctx.newPage(); await follower.goto(base);
    await follower.getByRole('status').filter({ hasText: '只读' }).waitFor();
    assert.equal(await follower.getByRole('button', { name: '暂停采集' }).isDisabled(), true);
    pass('多标签页只有一个写入者，其他标签页为只读'); await follower.close();

    await page.getByText('图片下载与数据管理', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '下载匹配图片' }).isDisabled(), true);
    await page.getByRole('checkbox').check();
    const downloads = []; page.on('download', d => { if (/\.(png|jpg)$/.test(d.suggestedFilename())) downloads.push(d); });
    const imageRequests = []; page.on('request', req => { if (req.url().endsWith('.png') && req.resourceType() === 'fetch') imageRequests.push(req); });
    await page.getByRole('button', { name: '下载匹配图片', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '图片下载已结束' }).waitFor();
    assert.equal(downloads.length, 2);
    for (const req of imageRequests) { const headers = await req.allHeaders(); assert.ok(!headers.cookie && !headers.authorization && !headers.referer); }
    assert.ok(PNG.equals(fs.readFileSync(await downloads[0].path())));
    pass('图片授权勾选与确认、无 Cookie/Authorization/Referer 的顺序 GET、下载字节与原资源一致');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText('已捕获的类目', { exact: true }).click();
    await page.screenshot({ path: path.join(artifactDir, 'panel-preview.png') });

    const backup = (await exported('导出备份')).data;
    fs.writeFileSync(path.join(artifactDir, 'fixture-backup.json'), JSON.stringify(backup));
    await page.getByRole('button', { name: '清空本地数据', exact: true }).click();
    await count(0, 0);
    await page.locator('[data-file]').setInputFiles(path.join(artifactDir, 'fixture-backup.json'));
    await page.getByRole('status').filter({ hasText: '备份已合并 6 件' }).waitFor(); await count(6, backup.stats.duplicates);
    data = (await exported()).data; assert.equal(data.products.length, 6);
    assert.ok(data.products.every(p => p.images.length === 0));
    pass('清空本脚本存储、JSON 备份恢复、保留类目与时间、导入图片证据重新验证');
    await page.setViewportSize({ width: 375, height: 812 });
    const box = await page.locator('#yollgo-collector-panel').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 375);
    await page.screenshot({ path: path.join(artifactDir, 'panel-mobile.png') });
    assert.deepEqual(errors, []); pass('375px 面板不越界、浏览器无未捕获错误');
    fs.writeFileSync(path.join(artifactDir, '测试结果.txt'), `测试环境：本机 Chrome headless，localhost 模拟页面；未登录访问真实商品 API。\n时间：${new Date().toISOString()}\n\n${checks.map(s => 'PASS ' + s).join('\n')}\n\n真实网站与 Tampermonkey 扩展注入兼容性仍需按照使用说明现场验收。\n`);
    await ctx.close();
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });


