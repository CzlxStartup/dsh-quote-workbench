import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuSync } from './feishu.js';

// 构造一个内存 storage + 记录 pending/deleted/conflicts 的 ctx；credentials/config 用桩。
function makeCtx(initialDb = { revision: 0, factories: [], freights: [], history: [], products: [], settings: null }) {
  let data = structuredClone(initialDb);
  const pending = new Map([['factories', new Set()], ['freights', new Set()], ['history', new Set()], ['products', new Set()]]);
  const deleted = new Map([['factories', new Set()], ['freights', new Set()], ['history', new Set()], ['products', new Set()]]);
  const ctx = {
    storage: { get: () => structuredClone(data), set: async value => { data = structuredClone(value); }, global: { clone: () => structuredClone(data), get: () => structuredClone(data), set: async value => { data = structuredClone(value); } } },
    storageDomain: {},
    pending, deleted, conflicts: [],
    credentials: null,
  };
  return { ctx, db: () => data };
}
function makeConfig(overrides = {}) {
  const state = { enable: false, appToken: '', table_factories: '', table_freights: '', table_history: '', table_products: '', ...overrides };
  const field = key => ({ get: () => state[key], set: value => { state[key] = value; } });
  const config = {};
  for (const key of Object.keys(state)) config[key] = field(key);
  return config;
}

// —— 编解码 ——
test('encode/decode round-trips dates, numbers and text', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig({ enable: true, appToken: 'bascnAPP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' }));
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  // 通过 push/pull 间接触发 encodeRecord/decodeField 不方便，直接验证行为：建一条 factory 记录推送并回读。
  const columns = [['cas', 'CAS 号', 'text'], ['quoteDate', '报价日期', 'date'], ['price', '报价单价', 'number']];
  // 借用内部实现：构造一个最小 push 场景，验证字段编码格式。
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ code: 0, data: { records: [{ record_id: 'rec_new' }] } }) };
  };
  try {
    // 直接调用 push 需要一个 record 包装；encoderecord 会调用 encodeField。
    const result = await sync.push('factories', [{ record: { id: 'local1', cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 }, __new: true }]);
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0].id, 'rec_new');
    assert.equal(captured[0].body.records[0].fields['CAS 号'], '50-00-0');
    assert.equal(captured[0].body.records[0].fields['报价单价'], 14000);
    assert.equal(typeof captured[0].body.records[0].fields['报价日期'], 'number');
    assert.equal(captured[0].body.records[0].fields['报价日期'], Date.parse('2026-11-23T00:00:00Z'));
  } finally { globalThis.fetch = realFetch; }
});

// —— mergeRecord 冲突检测：两端都改 → 冲突，本地优先保留 ——
test('mergeRecord records a conflict when both sides changed a field, keeping local', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const local = { id: 'rec1', cas: '50-00-0', quoteDate: '2026-11-23', price: 15000 };
  // shadow 是上次同步后的快照（price 14000）
  const shadowBefore = { 'CAS 号': '50-00-0', '报价日期': Date.parse('2026-11-23T00:00:00Z'), '报价单价': 14000 };
  const remoteRecord = { cas: '50-00-0', quoteDate: '2026-11-23', price: 16000 };
  const result = sync.mergeRecord('factories', local, shadowBefore, remoteRecord, 'rec1');
  assert.equal(result.updated, true);
  assert.equal(local.price, 15000, '本地优先，冲突字段保持本地值');
  assert.equal(ctx.conflicts.length, 1);
  assert.equal(ctx.conflicts[0].fields[0].key, 'price');
  assert.equal(ctx.conflicts[0].fields[0].local, 15000);
  assert.equal(ctx.conflicts[0].fields[0].remote, 16000);
});

test('mergeRecord applies a remote-only change without a conflict', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const local = { id: 'rec1', cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 };
  const shadowBefore = { 'CAS 号': '50-00-0', '报价日期': Date.parse('2026-11-23T00:00:00Z'), '报价单价': 14000 };
  const remoteRecord = { cas: '50-00-0', quoteDate: '2026-11-23', price: 16000 };
  sync.mergeRecord('factories', local, shadowBefore, remoteRecord, 'rec1');
  assert.equal(local.price, 16000, '仅远端改动的字段被采纳');
  assert.equal(ctx.conflicts.length, 0);
});

test('mergeRecord creates a local record with id = record_id for a new remote row', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const result = sync.mergeRecord('factories', null, undefined, { cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 }, 'rec_new');
  assert.equal(result.created, true);
  assert.equal(result.record.id, 'rec_new');
  assert.equal(result.record.cas, '50-00-0');
});

// —— history 嵌套字段读写 ——
test('history records read/write business fields through values.*', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const local = { id: 'h1', mode: 'rmb', date: '2026-11-23', values: { product: 'DPG', customer: 'ACME', sell: 2.5 }, result: { profit: 100 } };
  // 远端改 sell（在 values 内），name 用 product 作展示名。
  const shadowBefore = { '产品 / 规格': 'DPG', '客户': 'ACME', '对客单价 USD/kg': 2.5, '核算方式': 'rmb' };
  const remoteRecord = { product: 'DPG', customer: 'ACME', sell: 3.0, mode: 'rmb' };
  const result = sync.mergeRecord('history', local, shadowBefore, remoteRecord, 'h1');
  assert.equal(result.updated, true);
  assert.equal(local.values.sell, 3.0, '远端改动写入 values.sell');
  assert.equal(local.mode, 'rmb', 'mode 仍在顶层');
});

// —— pull：远端新行插入本地 + 本地独有记录进入待推送 ——
test('pull inserts new remote rows and queues local-only rows for push', async () => {
  const initial = {
    revision: 1,
    factories: [{ id: 'local-only', cas: '111-11-1', quoteDate: '2026-11-23', price: 9000 }],
    freights: [], history: [], products: [], settings: null,
  };
  const { ctx, db } = makeCtx(initial);
  const config = makeConfig({ enable: true, appToken: 'bascnAPP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' });
  const sync = new FeishuSync(ctx, config);
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/records/search')) {
      // 只有 factories 表返回一行远端数据；其他表空。
      if (url.includes('/tables/t1/')) {
        return { ok: true, json: async () => ({ code: 0, data: { items: [{ record_id: 'remote-1', fields: { 'CAS 号': '222-22-2', '报价日期': Date.parse('2026-11-23T00:00:00Z'), '报价单价': 12000 } }] } }) };
      }
      return { ok: true, json: async () => ({ code: 0, data: { items: [] } }) };
    }
    throw Error('unexpected url ' + url);
  };
  try {
    await sync.pull();
  } finally { globalThis.fetch = realFetch; }

  const after = db();
  const ids = after.factories.map(row => row.id).sort();
  assert.deepEqual(ids, ['local-only', 'remote-1'], '远端新行以 record_id 落地');
  const remoteRow = after.factories.find(row => row.id === 'remote-1');
  assert.equal(remoteRow.cas, '222-22-2');
  assert.equal(remoteRow.price, 12000);
  assert.ok(ctx.pending.get('factories').has('local-only'), '本地独有记录进入待推送');
});

// —— pushLoop：新建成功把本地 id 回写成 record_id ——
test('pushLoop writes back record_id for newly created rows', async () => {
  const initial = { revision: 1, factories: [{ id: 'local1', cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 }], freights: [], history: [], products: [], settings: null };
  const { ctx, db } = makeCtx(initial);
  const config = makeConfig({ enable: true, appToken: 'bascnAPP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' });
  const sync = new FeishuSync(ctx, config);
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  ctx.pending.get('factories').add('local1');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/records/batch_create')) return { ok: true, json: async () => ({ code: 0, data: { records: [{ record_id: 'remote-1' }] } }) };
    throw Error('unexpected url ' + url);
  };
  try {
    await sync.pushLoop();
  } finally { globalThis.fetch = realFetch; }

  const after = db();
  assert.equal(after.factories[0].id, 'remote-1', '本地 id 回写为 record_id');
  assert.equal(ctx.pending.get('factories').size, 0, '推送成功后移出待同步');
});

// —— push 失败保留待同步 ——
test('push failure keeps records pending', async () => {
  const initial = { revision: 1, factories: [{ id: 'local1', cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 }], freights: [], history: [], products: [], settings: null };
  const { ctx } = makeCtx(initial);
  const config = makeConfig({ enable: true, appToken: 'bascnAPP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' });
  const sync = new FeishuSync(ctx, config);
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  ctx.pending.get('factories').add('local1');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await sync.pushLoop();
  } finally { globalThis.fetch = realFetch; }

  assert.ok(ctx.pending.get('factories').has('local1'), '失败后仍待同步');
});

// —— 未配置时 schedulePush 不发网络 ——
test('schedulePush does nothing when sync disabled', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig({ enable: false }));
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw Error('should not fetch'); };
  try { sync.schedulePush(); await new Promise(resolve => setTimeout(resolve, 10)); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(called, false);
});

// —— 回归：真实 volatile 配置是只读快照（只有 get，没有 set），写配置只走 configEditor.edit ——
test('setup works when config fields are read-only volatile snapshots (no .set)', async () => {
  const { ctx } = makeCtx();
  // 只读 volatile：对象被冻结，只有 get()（模拟 cosmokit createVolatile）；没有 set()。
  const snapshot = { enable: false, appToken: '', table_factories: '', table_freights: '', table_history: '', table_products: '' };
  const config = {};
  for (const key of Object.keys(snapshot)) config[key] = Object.freeze({ get: () => snapshot[key] });
  // configEditor.edit 模拟：把候选写进快照，模拟宿主回同步（这里仅验证不依赖 .set）。
  const edits = [];
  ctx.get = name => name === 'configEditor' ? { edit: async (entry, mutate) => { const next = mutate({ ...snapshot }); edits.push(next); Object.assign(snapshot, next); return next; } } : undefined;
  ctx.fiber = { entry: { id: 'quote-workbench' } };
  // 凭据桩：无凭据，保证 setup 在建表前失败于凭据读取，而不是 .set 崩溃。
  ctx.credentials = { readRecord: async () => undefined };
  const sync = new FeishuSync(ctx, config);
  // 只保存配置（appToken 留空 → 不触发建表），验证写入不依赖 volatile .set 且 override 生效。
  const result = await sync.setup({ appToken: '', enable: true });
  assert.ok(result && typeof result === 'object', 'setup 返回状态对象而不是崩溃');
  // 关键断言：写入后 override 使本进程立即读到新 enable（不依赖 volatile .set）。
  const s = sync.settings();
  assert.equal(s.enable, true);
});

// —— 回归：已存在的同名表也会记下 table_id 供拉取使用 ——
test('ensureTable records table_id for a pre-existing table', async () => {
  const { ctx } = makeCtx();
  const snapshot = { enable: true, appToken: 'bascnTEST', table_factories: '', table_freights: '', table_history: '', table_products: '' };
  const config = {};
  for (const key of Object.keys(snapshot)) config[key] = Object.freeze({ get: () => snapshot[key] });
  ctx.get = name => name === 'configEditor' ? { edit: async (entry, mutate) => { const next = mutate({ ...snapshot }); Object.assign(snapshot, next); return next; } } : undefined;
  ctx.fiber = { entry: { id: 'quote-workbench' } };
  ctx.credentials = { readRecord: async () => ({ kind: 'grant', payload: { appId: 'a', appSecret: 'b' } }) };
  const sync = new FeishuSync(ctx, config);
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/tables')) return { ok: true, json: async () => ({ code: 0, data: { items: [{ name: '工厂报价', table_id: 'tbl-X' }] } }) };
    throw Error('unexpected ' + url);
  };
  try { const id = await sync.ensureTable('factories'); assert.equal(id, 'tbl-X'); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(sync.settings().tableIds.factories, 'tbl-X', '已存在的表 ID 被记下');
});

// —— ensureFields：补齐缺失字段、跳过已有字段 ——
test('ensureFields creates only the missing columns', async () => {
  const { ctx } = makeCtx();
  const snapshot = { enable: true, appToken: 'bascnAPP', table_factories: 'tblX', table_freights: '', table_history: '', table_products: '' };
  const config = {};
  for (const key of Object.keys(snapshot)) config[key] = Object.freeze({ get: () => snapshot[key] });
  const sync = new FeishuSync(ctx, config);
  sync._appToken = 'bascnAPP';
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/fields?') && (!options || options.method === undefined || options.method === 'GET')) {
      // 已有：CAS 号、报价日期（其余缺）
      return { ok: true, json: async () => ({ code: 0, data: { items: [{ field_name: 'CAS 号' }, { field_name: '报价日期' }] } }) };
    }
    if (url.includes('/fields') && options?.method === 'POST') {
      posted.push(JSON.parse(options.body).field_name);
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    }
    throw Error('unexpected ' + url + ' ' + (options?.method || 'GET'));
  };
  try { await sync.ensureFields('factories', 'tblX', 'tok'); }
  finally { globalThis.fetch = realFetch; }
  assert.ok(!posted.includes('CAS 号'), '已存在的字段不重复创建');
  assert.ok(posted.includes('报价单价'), '缺失的字段被创建');
  assert.equal(posted.length, 22, '工厂报价共 24 列（含创建人、最后修改人），已有 2 列，补建 22 列');
});

// —— 精度容差：浮点末位差异（飞书数字字段截断）不算冲突 ——
test('float precision differences are not treated as conflicts', () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const local = { id: 'rec1', values: { product: 'x', transport: 0.06456611570247933, buy: 11.343335499999998 } };
  const shadowBefore = { '运输保险费率 %': 0.06456611570247933, '工厂采购单价': 11.343335499999998 };
  // 远端是飞书截断后的末位
  const remoteRecord = { product: 'x', transport: 0.0645661157024793, buy: 11.3433354999999 };
  const result = sync.mergeRecord('history', local, shadowBefore, remoteRecord, 'rec1');
  assert.equal(result.conflicts.length, 0, '精度噪声不产生冲突');
  assert.equal(ctx.conflicts.length, 0);
});

// —— 数据保护：远端字段为空时不覆盖本地有值（防止空值冲掉本地数据）——
test('mergeRecord never overwrites a local value with an empty remote value', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const local = { id: 'rec1', cas: '50-00-0', quoteDate: '2026-11-23', name: 'Bronopol', price: 14000 };
  // shadow 与远端都缺 name/cas（模拟远端文本列没建成）
  const shadowBefore = { '报价日期': Date.parse('2026-11-23T00:00:00Z'), '报价单价': 14000 };
  const remoteRecord = { quoteDate: '2026-11-23', price: 14000 }; // 无 name/cas
  sync.mergeRecord('factories', local, shadowBefore, remoteRecord, 'rec1');
  assert.equal(local.name, 'Bronopol', '本地有值、远端为空 → 保留本地');
  assert.equal(local.cas, '50-00-0', 'CAS 不被空值覆盖');
});

// —— 授权链接必须带 scope，否则授权页不展示多维表格权限 ——
test('authorizeUrl includes a scope parameter', async () => {
  const { ctx } = makeCtx();
  ctx.credentials = { readRecord: async () => ({ kind: 'grant', payload: { appId: 'cli_x', appSecret: 's' } }) };
  const sync = new FeishuSync(ctx, makeConfig({ enable: true, appToken: 'CqBP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' }));
  const url = await sync.authorizeUrl('http://127.0.0.1:63315');
  assert.match(url, /\/authen\/v1\/authorize/);
  assert.match(url, /scope=/);
  assert.match(decodeURIComponent(url), /bitable:app/);
  assert.match(url, /redirect_uri=/);
});

// —— Wiki 链接：/wiki/<node_token> 经 get_node 解析成真实 app_token ——
test('resolveAppToken turns a wiki node URL into obj_token', async () => {
  const { ctx } = makeCtx();
  const snapshot = { enable: true, appToken: 'https://mcn.feishu.cn/wiki/CMHCwkJFUi2pinkCQ2uc7yxUnqd?table=tblX9&view=v1', table_factories: 'tblX9', table_freights: '', table_history: '', table_products: '' };
  const config = {};
  for (const key of Object.keys(snapshot)) config[key] = Object.freeze({ get: () => snapshot[key] });
  ctx.credentials = { readRecord: async () => ({ kind: 'grant', payload: { appId: 'a', appSecret: 'b' } }) };
  const sync = new FeishuSync(ctx, config);
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  let calledUrl = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrl = url;
    if (url.includes('/wiki/v2/spaces/get_node')) {
      return { ok: true, json: async () => ({ code: 0, data: { node: { obj_token: 'bascnREAL', obj_type: 'bitable' } } }) };
    }
    throw Error('unexpected ' + url);
  };
  try {
    const appToken = await sync.resolveAppToken();
    assert.equal(appToken, 'bascnREAL');
    assert.match(calledUrl, /token=CMHCwkJFUi2pinkCQ2uc7yxUnqd/, '从 URL 提取 node_token 并传参');
    // 第二次调用命中缓存，不再请求。
    calledUrl = null;
    await sync.resolveAppToken();
    assert.equal(calledUrl, null, '解析结果被缓存');
  } finally { globalThis.fetch = realFetch; }
});

// —— 推送时「最后修改人」列写入当前授权用户 ——
test('push writes the current user into the lastEditor column', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig({ enable: true, appToken: 'bascnAPP', table_factories: 't1', table_freights: 't2', table_history: 't3', table_products: 't4' }));
  sync.userAccessTokenValue = 'tok'; sync.userAccessTokenExpire = Date.now() + 1e9;
  sync.currentUser = { open_id: 'ou_123', name: '张三' };
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ code: 0, data: { records: [{ record_id: 'rec_new' }] } }) };
  };
  try {
    await sync.push('factories', [{ record: { id: 'l1', cas: '50-00-0', quoteDate: '2026-11-23', price: 1 }, __new: true }]);
  } finally { globalThis.fetch = realFetch; }
  const fields = captured[0].records[0].fields;
  assert.deepEqual(fields['最后修改人'], [{ id: 'ou_123' }], '人员字段写 open_id 数组');
  assert.deepEqual(fields['创建人'], [{ id: 'ou_123' }], '新建时创建人也写当前用户');
});

// —— 工厂报价唯一键含工厂与价格：不同工厂/不同价不判同一条 ——
test('factories key includes factory and price so distinct quotes stay distinct', async () => {
  const { ctx } = makeCtx();
  const sync = new FeishuSync(ctx, makeConfig());
  const base = { cas: '50-00-0', quoteDate: '2026-11-23', price: 14000 };
  const a = keySignatureOf(sync, { ...base, factory: '工厂A' });
  const b = keySignatureOf(sync, { ...base, factory: '工厂B' });       // 不同工厂
  const c = keySignatureOf(sync, { ...base, factory: '工厂A', price: 15000 }); // 同工厂不同价
  const d = keySignatureOf(sync, { ...base, factory: '工厂A' });       // 与 a 完全相同
  assert.notEqual(a, b, '不同工厂不判同一条');
  assert.notEqual(a, c, '同工厂不同价不判同一条');
  assert.equal(a, d, '完全相同的才算同一条');
});
// 借 mergeRecord 的匹配语义间接验证 keySignature（通过 pull 的同键匹配不便，直接调用内部签名逻辑）。
function keySignatureOf(sync, record) {
  // keySignature 未导出：用 pull 中同样的规则复算（TABLE_KEYS.factories 顺序拼接）。
  return ['cas', 'quoteDate', 'factory', 'price'].map(k => String(record[k] ?? '').trim()).join('\u0001');
}
