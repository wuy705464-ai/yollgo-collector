// ==UserScript==
// @name         Yollgo 商品被动采集助手
// @namespace    local.yollgo.passive-collector
// @version      1.0.1
// @description  仅监听网页商品响应；本地续存、去重、CSV/JSON 备份。无认证凭据采集。
// @homepageURL  https://github.com/wuy705464-ai/yollgo-collector
// @supportURL   https://github.com/wuy705464-ai/yollgo-collector/issues
// @downloadURL  https://raw.githubusercontent.com/wuy705464-ai/yollgo-collector/main/yollgo-collector.user.js
// @updateURL    https://raw.githubusercontent.com/wuy705464-ai/yollgo-collector/main/yollgo-collector.user.js
// @match        https://app.yollgo.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const SHOP = '6085';
  const FIELDS = ['artId', 'usercode', 'bianhao', 'namecn', 'namees', 'precio',
    'baozhuangshu', 'zhuangxiangshu', 'mulUID', 'imageHash', 'attributes', 'is_hot'];
  // Only explicit product ID attributes; add verified site attributes here, never generic data-id.
  const IMAGE_ID_ATTRIBUTES = ['data-art-id', 'data-artid'];
  const SECRET = /cookie|authorization|apikey|accesskey|secret|signature|credential|password|passwd|token|session|jwt|csrf|xsrf|^sign$|^sig$|^auth$|^headers?$/i;
  function sensitiveKey(key) { return SECRET.test(key.replace(/[^a-z0-9]/gi, '')); }
  function safeURL(value, base = 'https://app.yollgo.com/') {
    try {
      const u = new URL(value, base);
      // Do not rewrite signed URLs, store them, or guess an unsigned replacement.
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
      if (/(?:bearer\s|eyJ[a-zA-Z0-9_-]+\.|(?:token|signature|credential|api[_-]?key)[=/])/i.test(u.pathname)) return null;
      return u.href;
    } catch { return null; }
  }
  function clean(value, depth = 0) {
    if (depth > 30) return '[depth limit]';
    if (typeof value === 'string') {
      if (/(?:\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|(?:cookie|authorization|token|api[_-]?key|signature|password)\s*[:=])/i.test(value)) return '[redacted]';
      if (/^https?:\/\//i.test(value)) return safeURL(value) || '[private URL omitted]';
      return value;
    }
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = Object.create(null);
      for (const [k, v] of Object.entries(value)) {
        if (!sensitiveKey(k) && !['__proto__', 'constructor', 'prototype'].includes(k)) out[k] = clean(v, depth + 1);
      }
      return out;
    }
    return value;
  }
  function categoryValue(v) {
    return (typeof v === 'string' || typeof v === 'number') && /^[\w.-]{1,80}$/.test(String(v)) ? String(v) : null;
  }
  function context(body, url) {
    const out = { shopid: SHOP, muluid: null, submuluid: null };
    function take(get) {
      for (const k of ['shopid', 'muluid', 'submuluid']) out[k] = categoryValue(get(k)) ?? out[k];
    }
    try {
      take(k => new URL(url).searchParams.get(k));
      if (typeof body === 'string' && body.length < 2_000_000) {
        if (/^\s*\{/.test(body)) { const parsed = JSON.parse(body); take(k => parsed[k]); }
        else { const parsed = new URLSearchParams(body); take(k => parsed.get(k)); }
      } else if ((typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
                 (typeof FormData !== 'undefined' && body instanceof FormData)) take(k => body.get(k));
    } catch { /* Unknown bodies are left untouched; never dump them. */ }
    return out;
  }
  function target(url, method) {
    try { const u = new URL(url, 'https://app.yollgo.com/');
      return String(method || 'GET').toUpperCase() === 'POST' &&
        u.origin === 'https://ssl.freex.es' && u.pathname === `/api/articulos/${SHOP}`;
    } catch { return false; }
  }
  function lists(json) {
    const found = [];
    function walk(x, depth) {
      if (!x || typeof x !== 'object' || depth > 6) return;
      if (Array.isArray(x.articulo_lists)) found.push(x.articulo_lists);
      for (const [k, v] of Object.entries(x)) if (k !== 'articulo_lists' && !sensitiveKey(k)) walk(v, depth + 1);
    }
    walk(json, 0);
    return found.length === 1 ? found[0] : null;
  }
  function merge(old, row, source, time) {
    const raw = clean(row), artId = categoryValue(raw.artId);
    if (!artId) return null;
    const sources = old ? [...old.sources] : [];
    const s = { shopid: SHOP, muluid: source.muluid, submuluid: source.submuluid,
      productMulUID: categoryValue(raw.mulUID), firstSeen: time, lastSeen: time };
    const existing = sources.find(x => x.muluid === s.muluid && x.submuluid === s.submuluid && x.productMulUID === s.productMulUID);
    if (existing) existing.lastSeen = time; else sources.push(s);
    const out = { artId, raw, sources, firstSeen: old?.firstSeen || time, lastSeen: time,
      images: old?.images || [], imageStatus: old?.imageStatus || 'pending' };
    for (const k of FIELDS) out[k] = raw[k] ?? null;
    out.artId = artId;
    return out;
  }
  function cell(v) {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[\s\uFEFF]*[=+@-]/u.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(rows) {
    const keys = [...FIELDS, 'imageStatus', 'images', 'sources', 'firstSeen', 'lastSeen', 'raw'];
    return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n');
  }
  function imageURLs(raw) {
    const result = new Set();
    function walk(value, imageContext = false, depth = 0) {
      if (depth > 12 || value == null) return;
      if (typeof value === 'string' && imageContext && /^https?:\/\//i.test(value)) {
        const url = safeURL(value); if (url) result.add(url);
      } else if (Array.isArray(value)) value.forEach(v => walk(v, imageContext, depth + 1));
      else if (typeof value === 'object') for (const [k, v] of Object.entries(value))
        walk(v, imageContext || /image|photo|imagen|picture|foto|img|thumb/i.test(k), depth + 1);
    }
    walk(raw); return result;
  }
  function hashInURL(hash, url) {
    if (typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(hash)) return false;
    try { return decodeURIComponent(new URL(url).pathname).split('/').some(p => p === hash || p.replace(/\.[a-zA-Z0-9]{2,6}$/, '') === hash); }
    catch { return false; }
  }
  function matchImages(rows, observed, explicit, time) {
    const candidates = new Map(), hashOwners = new Map(), tokenURLs = new Map();
    const ids = new Set(rows.map(r => r.artId));
    for (const url of observed) {
      try {
        for (const part of decodeURIComponent(new URL(url).pathname).split('/')) {
          for (const token of new Set([part, part.replace(/\.[a-zA-Z0-9]{2,6}$/, '')])) {
            if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) continue;
            if (!tokenURLs.has(token)) tokenURLs.set(token, new Set()); tokenURLs.get(token).add(url);
          }
        }
      } catch { /* malformed URL is not evidence */ }
    }
    function add(id, url, evidence) {
      if (!observed.has(url) || !safeURL(url)) return;
      if (!candidates.has(url)) candidates.set(url, new Map());
      candidates.get(url).set(id, evidence);
    }
    for (const row of rows) {
      for (const img of row.images || []) add(row.artId, img.url, img.evidence);
      for (const url of imageURLs(row.raw)) add(row.artId, url, 'response-url+observed-resource');
      if (typeof row.imageHash === 'string') {
        if (!hashOwners.has(row.imageHash)) hashOwners.set(row.imageHash, []);
        hashOwners.get(row.imageHash).push(row.artId);
      }
    }
    for (const [hash, owners] of hashOwners)
      for (const url of tokenURLs.get(hash) || [])
        for (const id of owners) add(id, url, 'unique-hash-token+observed-resource');
    for (const [id, urls] of explicit) if (ids.has(id)) for (const url of urls) add(id, url, 'explicit-dom-artId+loaded-image');
    const byID = new Map();
    for (const [url, owners] of candidates) if (owners.size === 1) {
      const [id, evidence] = owners.entries().next().value;
      if (!byID.has(id)) byID.set(id, []); byID.get(id).push({ url, evidence });
    }
    const changed = [];
    for (const row of rows) {
      const images = [];
      for (const { url, evidence } of byID.get(row.artId) || []) {
        const old = row.images?.find(i => i.url === url);
        images.push({ url, evidence, observedAt: old?.observedAt || time,
          // Original resolution cannot be established from a thumbnail URL alone.
          resolution: 'observed-resource-original-resolution-unverified' });
      }
      // Previously verified links remain valid across refresh, unless new conflicting evidence appears.
      for (const old of row.images || []) if (!observed.has(old.url) && safeURL(old.url)) {
        if (old.evidence === 'unique-hash-token+observed-resource' &&
            (hashOwners.get(row.imageHash)?.length !== 1 || !hashInURL(row.imageHash, old.url))) continue;
        images.push(old);
      }
      images.sort((a, b) => a.url.localeCompare(b.url));
      if (JSON.stringify(images) !== JSON.stringify(row.images || []))
        changed.push({ ...row, images, imageStatus: images.length ? 'matched' : 'pending' });
    }
    return changed;
  }
  const core = { SHOP, FIELDS, sensitiveKey, safeURL, clean, context, target, lists, merge, csv, imageURLs, hashInURL, matchImages };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') { module.exports = core; return; }
  if (window.top !== window.self || window[Symbol.for('yollgo.collector.installed')]) return;
  window[Symbol.for('yollgo.collector.installed')] = true;

  const state = { rows: new Map(), paused: false, duplicates: 0, captures: 0, skipped: 0,
    category: '等待商品响应', status: '初始化本地存储', error: '', owner: false, epoch: 0 };
  let db, root, queue = Promise.resolve(), requestSeq = 0, displaySeq = 0, booted = false;
  let collapsed = false, imageTimer, scanning = false, downloadStop = false, downloading = false;
  const observedImages = new Set();
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  function report(message) { state.status = message; render(); }
  function failure() { state.error = '本地操作失败。请导出备份，检查浏览器存储空间或刷新重试。'; render(); }
  function enqueue(task) {
    queue = queue.then(() => ready).then(task).catch(failure);
    return queue;
  }
  function ticket(url, body) {
    const source = context(body, url);
    return { source, epoch: state.epoch, eligible: !state.paused && source.shopid === SHOP, seq: ++requestSeq };
  }
  function valid(t) { return state.owner && !state.error && !state.paused && t.eligible && t.epoch === state.epoch; }
  function receive(json, t) {
    if (!valid(t) && booted) return;
    const data = lists(json);
    if (!data) { enqueue(() => { if (valid(t)) report('响应未找到唯一 articulo_lists 数组'); }); return; }
    // Keep only sanitized product rows, never retain the response envelope.
    const total = data.length;
    const rows = data.map(r => r && typeof r === 'object' && !Array.isArray(r) ? clean(r) : null).filter(Boolean);
    enqueue(async () => {
      if (!valid(t)) return;
      const changed = new Map(); let duplicates = 0, skipped = total - rows.length;
      const time = new Date().toISOString();
      for (const row of rows) {
        const id = categoryValue(row.artId), old = changed.get(id) || state.rows.get(id);
        const next = merge(old, row, t.source, time);
        if (!next) { skipped++; continue; }
        if (old) duplicates++;
        changed.set(next.artId, next);
      }
      await save([...changed.values()], { paused: state.paused,
        duplicates: state.duplicates + duplicates, captures: state.captures + 1, skipped: state.skipped + skipped });
      for (const [id, row] of changed) state.rows.set(id, row);
      state.duplicates += duplicates; state.captures++; state.skipped += skipped;
      if (t.seq >= displaySeq) { displaySeq = t.seq;
        state.category = `${t.source.muluid ?? '未知'} / ${t.source.submuluid ?? '未知'}`; }
      report(`已保存本次 ${changed.size} 件商品`);
      scheduleImages();
    });
  }
  // Forward original arguments and this exactly; never read request/response headers.
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    let t = null;
    try {
      const input = args[0], init = args[1];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (target(url, init?.method || input?.method)) t = ticket(url, init?.body);
      // A Request object's stream is not cloned/read: category falls back to product mulUID.
    } catch { /* Observer failures cannot alter the website call. */ }
    const promise = Reflect.apply(nativeFetch, this, args);
    if (t) promise.then(response => {
      try { if (response.ok && (!booted || valid(t))) response.clone().json().then(json => receive(json, t)).catch(() => report('商品响应非 JSON 或无法读取')); }
      catch { /* clone failure is isolated */ }
    }, () => {}).catch(() => {});
    return promise;
  };
  const nativeOpen = XMLHttpRequest.prototype.open, nativeSend = XMLHttpRequest.prototype.send;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    const result = Reflect.apply(nativeOpen, this, args);
    xhrInfo.set(this, target(args[1], args[0]) ? { url: String(args[1]) } : null);
    return result;
  };
  XMLHttpRequest.prototype.send = function (...args) {
    let listener;
    try {
      const info = xhrInfo.get(this);
      if (info) {
        const t = ticket(info.url, args[0]);
        listener = () => {
          if (this.status < 200 || this.status >= 300 || (booted && !valid(t))) return;
          try {
            if (this.responseType === 'json') receive(this.response, t);
            else if (this.responseType === '' || this.responseType === 'text') receive(JSON.parse(this.responseText), t);
          } catch { report('商品 XHR 响应非 JSON 或无法读取'); }
        };
        this.addEventListener('load', listener, { once: true });
        this.addEventListener('loadend', () => this.removeEventListener('load', listener), { once: true });
      }
    } catch { /* Observer failures cannot alter the website call. */ }
    try { return Reflect.apply(nativeSend, this, args); }
    catch (e) { if (listener) this.removeEventListener('load', listener); throw e; }
  };
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('yollgo-passive-6085-v1', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('products', { keyPath: 'artId' }); req.result.createObjectStore('meta'); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('storage'));
      req.onblocked = () => report('存储升级被其他标签页阻塞，请关闭旧采集页面');
    });
  }
  function read(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store), req = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      tx.oncomplete = () => resolve(req.result); tx.onerror = tx.onabort = () => reject(new Error('storage'));
    });
  }
  function save(rows, meta, clear = false) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['products', 'meta'], 'readwrite'), store = tx.objectStore('products');
      if (clear) store.clear();
      for (const row of rows) store.put(row);
      tx.objectStore('meta').put(meta, 'state');
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('storage'));
    });
  }
  function snapshot() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['products', 'meta']);
      const products = tx.objectStore('products').getAll(), stats = tx.objectStore('meta').get('state');
      tx.oncomplete = () => resolve({ products: products.result, stats: stats.result });
      tx.onerror = tx.onabort = () => reject(new Error('storage'));
    });
  }
  function meta() { return { paused: state.paused, duplicates: state.duplicates, captures: state.captures, skipped: state.skipped }; }
  function observeImage(value) {
    const url = safeURL(value, location.href);
    if (url && observedImages.size < 6000) observedImages.add(url);
  }
  function scheduleImages() {
    if (!imageTimer) imageTimer = setTimeout(() => { imageTimer = null; scanImages(); }, 1000);
  }
  function scanImages() {
    if (!state.owner || state.paused || state.error || scanning) return;
    scanning = true;
    const t = { epoch: state.epoch, eligible: true }, explicit = new Map();
    for (const entry of performance.getEntriesByType('resource')) if (entry.initiatorType === 'img') observeImage(entry.name);
    for (const img of document.images) {
      if (!img.complete || !img.naturalWidth) continue;
      const url = safeURL(img.currentSrc || img.src, location.href); if (!url) continue;
      observeImage(url);
      for (const attr of IMAGE_ID_ATTRIBUTES) {
        const card = img.closest(`[${attr}]`); if (!card) continue;
        if (card !== img && card.querySelectorAll('img').length !== 1) continue;
        const id = categoryValue(card.getAttribute(attr)); if (!id) continue;
        if (!explicit.has(id)) explicit.set(id, new Set()); explicit.get(id).add(url);
      }
    }
    enqueue(async () => {
      if (!valid(t)) return;
      const changed = matchImages([...state.rows.values()], observedImages, explicit, new Date().toISOString());
      if (!changed.length) return;
      await save(changed, meta());
      for (const row of changed) state.rows.set(row.artId, row);
      render();
    }).finally(() => { scanning = false; });
  }
  function pauseResume() {
    if (!state.owner || state.error) return;
    state.epoch++; state.paused = !state.paused;
    const paused = state.paused;
    if (paused) downloadStop = true;
    render();
    enqueue(async () => { await save([], meta()); report(paused ? '采集已暂停；在途响应将忽略' : '已恢复；请手动切换类目以产生新响应'); if (!paused) scheduleImages(); });
  }
  function clearData() {
    if (!state.owner || downloading || !confirm('清空本脚本的全部商品与进度？建议先导出备份。网站业务数据不受影响。')) return;
    state.epoch++; state.paused = true; downloadStop = true; render();
    enqueue(async () => {
      await save([], { paused: true, duplicates: 0, captures: 0, skipped: 0 }, true);
      state.rows.clear(); observedImages.clear(); state.duplicates = state.captures = state.skipped = 0;
      state.category = '等待商品响应'; state.error = ''; report('本地数据已清空；点击恢复后重新采集');
    });
  }
  async function restoreBackup(file) {
    if (!file || !state.owner || downloading) return;
    if (file.size > 100 * 1024 * 1024) { report('备份超过 100 MB，未导入'); return; }
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch { report('备份不是有效 JSON，未导入'); return; }
    if (backup.schema !== 'yollgo-collector/v1' || String(backup.shopid) !== SHOP || !Array.isArray(backup.products)) {
      report('备份版本或店铺不匹配，未导入'); return;
    }
    if (!confirm(`将合并 ${backup.products.length} 条备份记录。导入的图片链接会重新等待网页证据验证。继续？`)) return;
    state.epoch++; state.paused = true; render();
    enqueue(async () => {
      const changed = new Map(); let skipped = 0;
      for (const input of backup.products) {
        const raw = clean(input?.raw); const id = categoryValue(raw?.artId);
        if (!raw || !id || id !== String(input.artId)) { skipped++; continue; }
        const old = changed.get(id) || state.rows.get(id);
        const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
        const row = merge(old, raw, {}, date(input.lastSeen));
        row.firstSeen = old?.firstSeen || date(input.firstSeen);
        // Imported arbitrary URLs/evidence are untrusted; only live observations can match them.
        if (!old) { row.images = []; row.imageStatus = 'pending'; }
        row.sources = old ? [...old.sources] : [];
        for (const s of Array.isArray(input.sources) ? input.sources : []) {
          if (String(s?.shopid) !== SHOP) continue;
          const source = { shopid: SHOP, muluid: categoryValue(s.muluid), submuluid: categoryValue(s.submuluid),
            productMulUID: categoryValue(s.productMulUID), firstSeen: date(s.firstSeen), lastSeen: date(s.lastSeen) };
          if (!row.sources.some(x => x.muluid === source.muluid && x.submuluid === source.submuluid && x.productMulUID === source.productMulUID)) row.sources.push(source);
        }
        changed.set(id, row);
      }
      const nextMeta = meta();
      if (!state.rows.size && backup.stats && typeof backup.stats === 'object') {
        for (const key of ['duplicates', 'captures', 'skipped']) {
          const value = backup.stats[key]; if (Number.isSafeInteger(value) && value >= 0) nextMeta[key] = value;
        }
      }
      await save([...changed.values()], nextMeta);
      Object.assign(state, nextMeta);
      for (const [id, row] of changed) state.rows.set(id, row);
      report(`备份已合并 ${changed.size} 件，跳过 ${skipped} 条；当前已暂停`);
    });
  }
  async function downloadImages() {
    if (!state.owner || downloading || !root.querySelector('[data-authorized]').checked) {
      report('请先勾选已获得图片使用与下载授权'); return;
    }
    await queue;
    const jobs = new Map();
    for (const row of state.rows.values()) for (const img of row.images) if (safeURL(img.url)) {
      if (!jobs.has(img.url)) jobs.set(img.url, { id: row.artId, url: img.url });
    }
    if (!jobs.size) { report('还没有可靠匹配的图片；请浏览商品、滚动加载后重新匹配'); return; }
    if (!confirm(`将下载 ${jobs.size} 个已匹配的网页图片资源（不保证源站最高分辨率）。不发送认证信息，跨域限制可能导致失败。继续？`)) return;
    downloading = true; downloadStop = false; let ok = 0, failed = 0;
    render();
    try {
      for (const job of jobs.values()) {
        if (downloadStop) break;
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await Reflect.apply(nativeFetch, window, [job.url, { method: 'GET',
            credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal }]);
          if (!response.ok) throw new Error('image');
          const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };
          if (!extensions[type]) throw new Error('image type');
          const blob = await response.blob(); if (!blob.size || blob.size > 50 * 1024 * 1024) throw new Error('image size');
          if (downloadStop) break;
          download(blob, `${job.id}-${ok + 1}.${extensions[type]}`); ok++;
        } catch { failed++; }
        finally { clearTimeout(timeout); }
        report(`图片下载交给浏览器 ${ok} / ${jobs.size}，失败 ${failed}`);
        await new Promise(r => setTimeout(r, 750));
      }
    } finally { downloading = false; report(`图片下载${downloadStop ? '已停止' : '已结束'}：交给浏览器 ${ok}，失败 ${failed}。请检查下载目录。`); render(); }
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.setAttribute('data-tap-disabled', 'true');
    a.href = url; a.download = filename; a.style.display = 'none'; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function exportFile(format, backup = false) {
    await queue; const { products, stats } = await snapshot();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const data = format === 'csv' ? csv(products) : JSON.stringify({ schema: 'yollgo-collector/v1',
      shopid: SHOP, exportedAt: new Date().toISOString(), ...(backup ? { stats } : {}), products }, null, 2);
    download(new Blob([data], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }),
      `yollgo-${SHOP}-${backup ? 'backup-' : ''}${stamp}.${format}`);
    report(`已交给浏览器导出 ${products.length} 件商品，请确认下载文件`);
  }
  function render() {
    if (!root) return;
    root.querySelector('[data-summary]').textContent = `商品 ${state.rows.size} · 重复命中 ${state.duplicates} · 响应 ${state.captures}`;
    root.querySelector('[data-category]').textContent = `最近捕获类目：${state.category}`;
    root.querySelector('[data-status]').textContent = state.error || `${state.paused ? '已暂停 · ' : ''}${state.status}`;
    const matched = [...state.rows.values()].filter(r => r.images.length).length;
    root.querySelector('[data-images]').textContent = `图片已匹配 ${matched} · 待匹配 ${state.rows.size - matched} · 无 artId 等跳过 ${state.skipped}`;
    root.querySelector('[data-pause]').textContent = state.paused ? '恢复采集' : '暂停采集';
    for (const b of root.querySelectorAll('[data-owner]')) b.disabled = !state.owner || (b.hasAttribute('data-needs-store') && !!state.error);
    root.querySelector('[data-clear]').disabled = !state.owner || downloading;
    root.querySelector('[data-restore]').disabled = !state.owner || downloading || !!state.error;
    root.querySelector('[data-download]').disabled = !state.owner || downloading || !root.querySelector('[data-authorized]').checked;
    root.querySelector('[data-stop]').disabled = !downloading;
    root.querySelector('[data-content]').hidden = collapsed;
    root.querySelector('[data-collapse]').textContent = collapsed ? '展开面板' : '收起面板';
    root.querySelector('[data-collapse]').setAttribute('aria-expanded', String(!collapsed));
    const cats = new Map();
    for (const row of state.rows.values()) for (const s of row.sources) {
      const key = `${s.muluid ?? s.productMulUID ?? '未知'} / ${s.submuluid ?? '未知'}`;
      if (!cats.has(key)) cats.set(key, new Set()); cats.get(key).add(row.artId);
    }
    const list = root.querySelector('[data-categories]'); list.replaceChildren();
    for (const [key, ids] of [...cats].sort()) {
      const li = document.createElement('li'); li.textContent = `${key}：${ids.size} 件`; list.append(li);
    }
  }
  function mount() {
    const host = document.createElement('div'); host.id = 'yollgo-collector-panel';
    // Ionic 1 captures document clicks. Shadow DOM retargets the button to this host,
    // so Ionic must allow native clicks on the host and its descendants.
    host.setAttribute('data-tap-disabled', 'true');
    document.body.append(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;bottom:max(12px,env(safe-area-inset-bottom));right:12px;z-index:2147483646;font:14px/1.5 system-ui;color:#16263b;color-scheme:light}
      *{box-sizing:border-box}[hidden]{display:none!important}section{background:#fff;border:1px solid #bac9d9;border-radius:12px;padding:16px;width:356px;max-width:calc(100vw - 24px);max-height:85vh;overflow:auto;box-shadow:0 8px 32px #18304a33}
      header{display:flex;align-items:center;justify-content:space-between;gap:8px}h2{font-size:16px;margin:0}p{margin:8px 0}.hint{font-size:12px;color:#415770}ul{padding-left:22px;max-height:140px;overflow:auto}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}button{font:inherit;min-height:44px;padding:8px;border:1px solid #73879e;border-radius:6px;background:#f3f7fb;color:#16263b;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
      [data-pause]{background:#154eb2;color:white;border-color:#154eb2}[data-clear]{color:#a12020}label{display:flex;align-items:center;gap:8px;min-height:44px}input[type=checkbox]{width:18px;height:18px;flex-shrink:0}summary{cursor:pointer;min-height:44px;padding-top:12px}[data-status]{background:#eef4fc;padding:8px;border-radius:6px;overflow-wrap:anywhere}
      </style><section aria-label="Yollgo 商品采集">
      <header><h2>Yollgo 商品采集</h2><button data-collapse aria-expanded="true">收起面板</button></header>
      <div data-content><p data-category></p><p data-summary></p><p data-images></p><p data-status role="status" aria-atomic="true"></p>
      <div class="actions"><button data-owner data-needs-store data-pause>暂停采集</button><button data-owner data-needs-store data-scan>重新匹配图片</button><button data-json>导出 JSON</button><button data-csv>导出 CSV</button><button data-backup>导出备份</button><button data-owner data-needs-store data-restore>恢复备份</button></div>
      <input type="file" data-file accept=".json,application/json" hidden>
      <details><summary>已捕获的类目</summary><ul data-categories></ul></details>
      <details><summary>图片下载与数据管理</summary><p class="hint">只下载已匹配的真实资源，不放大、不推测原图路径。最高分辨率尚未验证。跨域失败会跳过。</p>
      <label><input type="checkbox" data-authorized>我已获得这些图片的使用与下载授权</label>
      <div class="actions"><button data-download disabled>下载匹配图片</button><button data-stop disabled>停止下载</button><button data-owner data-clear>清空本地数据</button></div></details>
      <p class="hint">仅记录本店网页实际返回的商品。请手动切换类目、翻页并滚动；重复命中是累计次数。只读标签页请刷新查看最新计数。</p></div></section>`;
    root.querySelector('[data-json]').onclick = () => exportFile('json').catch(failure);
    root.querySelector('[data-csv]').onclick = () => exportFile('csv').catch(failure);
    root.querySelector('[data-backup]').onclick = () => exportFile('json', true).catch(failure);
    root.querySelector('[data-pause]').onclick = pauseResume;
    root.querySelector('[data-clear]').onclick = clearData;
    root.querySelector('[data-scan]').onclick = () => { scanImages(); report('正在检查已加载图片与明确商品证据'); };
    root.querySelector('[data-collapse]').onclick = () => { collapsed = !collapsed; render(); };
    root.querySelector('[data-authorized]').onchange = render;
    root.querySelector('[data-download]').onclick = () => downloadImages().catch(failure);
    root.querySelector('[data-stop]').onclick = () => { downloadStop = true; report('正在停止图片下载'); };
    root.querySelector('[data-restore]').onclick = () => root.querySelector('[data-file]').click();
    root.querySelector('[data-file]').onchange = e => { restoreBackup(e.target.files[0]).catch(failure); e.target.value = ''; };
    const observer = new MutationObserver(scheduleImages);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', ...IMAGE_ID_ATTRIBUTES] });
    document.addEventListener('load', e => { if (e.target instanceof HTMLImageElement) scheduleImages(); }, true);
    try { const resources = new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.initiatorType === 'img') observeImage(e.name); scheduleImages(); });
      resources.observe({ type: 'resource', buffered: true }); } catch { /* DOM load observation remains available. */ }
    scheduleImages();
    render();
  }
  async function init() {
    try {
      db = await openDB(); db.onversionchange = () => { db.close(); state.owner = false; report('存储已更新，请刷新'); };
      if (navigator.locks) await new Promise(resolve => {
        navigator.locks.request('yollgo-collector-6085-owner', { ifAvailable: true }, async lock => {
          state.owner = !!lock; resolve(); if (lock) await new Promise(() => {});
        }).catch(() => { state.owner = false; resolve(); });
      });
      const [rows, saved] = await Promise.all([read('products'), read('meta', 'state')]);
      state.rows = new Map(rows.map(r => [r.artId, r]));
      if (saved) Object.assign(state, { paused: !!saved.paused, duplicates: saved.duplicates || 0,
        captures: saved.captures || 0, skipped: saved.skipped || 0 });
      report(state.owner ? '监听已就绪，请手动打开商品类目' : '只读：另一个标签页正在采集，或浏览器不支持 Web Locks');
    } catch { failure(); }
    finally { booted = true; resolveReady(); }
  }
  init();
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
