// Node interaction regression tests, not browser acceptance tests.
// Execute the real domain/UI functions; no DOM, network, Host storage or dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const domainSource = readFileSync(new URL('./domain.js', import.meta.url), 'utf8')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
const uiSource = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const text = node => node == null || typeof node === 'boolean' ? ''
  : typeof node !== 'object' ? String(node) : (node.children || []).map(text).join('');
function all(node, predicate) {
  if (node == null || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))];
}
function one(nodes, description) {
  assert.equal(nodes.length, 1, `Expected one ${description}; found ${nodes.length}`);
  return nodes[0];
}

// State belongs to component identities, never to field names or fixed hook indices.
// Events drive setters; renders run dependency-aware effects after committing trees.
function renderer() {
  const frames = new Map();
  let current, root, tree, dirty = true, effects = [];
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && typeof x !== 'boolean') };
    },
    useState(initial) {
      const frame = current, index = frame.cursor++;
      if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [frame.hooks[index], value => {
        const next = typeof value === 'function' ? value(frame.hooks[index]) : value;
        if (!Object.is(next, frame.hooks[index])) { frame.hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const frame = current, index = frame.cursor++;
      return frame.hooks[index] ??= { current: initial };
    },
    useEffect(callback, dependencies) {
      const frame = current, index = frame.cursor++, old = frame.hooks[index];
      if (!old || !dependencies || dependencies.some((value, i) => !Object.is(value, old.dependencies?.[i]))) {
        const effect = { dependencies, cleanup: old?.cleanup };
        frame.hooks[index] = effect;
        effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
      }
    },
    useSyncExternalStore(subscribe, snapshot) {
      const [value, setValue] = React.useState(snapshot);
      React.useEffect(() => subscribe(() => setValue(snapshot())), [subscribe, snapshot]);
      return value;
    },
  };
  function expand(node, path = 'root') {
    if (node == null || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const frame = frames.get(path) || { hooks: [], cursor: 0 };
      frames.set(path, frame); frame.cursor = 0;
      const parent = current; current = frame;
      const result = node.type({ ...node.props, children: node.children });
      current = parent;
      return expand(result, `${path}/result`);
    }
    return { ...node, children: node.children.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) };
  }
  return {
    React,
    get tree() { return tree; },
    mount(component) { root = React.createElement(component); },
    async flush() {
      for (let turns = 0; turns < 30; turns++) {
        if (dirty) {
          dirty = false; tree = expand(root);
          const pending = effects; effects = []; pending.forEach(effect => effect());
        }
        // Drain API promises and their continuation/setState chains without timers.
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty && !effects.length) return;
      }
      assert.fail('UI failed to settle within 30 renders');
    },
    dispose() { for (const frame of frames.values()) for (const hook of frame.hooks) hook?.cleanup?.(); },
  };
}

function factory(id, overrides = {}) {
  return { id, name: `报价 ${id}`, cas: '67-68-5', price: 14000, currency: 'RMB', unit: '吨',
    rebate: 13, incoterm: 'FOB', port: '青岛', factory: '测试工厂', quoteDate: '2026-11-01',
    validity: '2026-12-01', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...overrides };
}
async function mount(t, seed = {}, parseResponses = []) {
  const driver = renderer(), requests = [];
  const memory = { revision: 7, factories: [], products: [], history: [], freights: [], ...copy(seed) };
  const sandbox = vm.createContext({
    AbortController, console,
    window: { confirm: () => true },
    fetch: async (url, options) => {
      assert.equal(url, '/api/quote-workbench');
      assert.equal(options.method, 'POST');
      const input = JSON.parse(options.body); requests.push(input);
      let value;
      if (input.action === 'list') value = memory;
      else if (input.action === 'settings') value = { effective: null };
      else if (input.action === 'parse') {
        assert.ok(parseResponses.length, 'AI parse must have an explicit fixture response');
        value = parseResponses.shift();
      }
      else if (['update', 'add', 'delete'].includes(input.action)) {
        if (input.revision !== memory.revision) return { ok: false, status: 409, json: async () => ({ error: '记录已更新，请刷新后重试。' }) };
        const rows = memory[input.kind];
        if (input.action === 'update') {
          const row = rows.find(row => row.id === input.id);
          assert.ok(row, 'update must target an existing record');
          Object.assign(row, input.record, { id: row.id, createdAt: row.createdAt, updatedAt: '2026-11-12T00:00:00Z' });
        } else if (input.action === 'add') rows.push({ ...input.record, id: `new-${memory.revision}` });
        else memory[input.kind] = rows.filter(row => row.id !== input.id);
        memory.revision++; value = memory;
      } else throw Error(`Unexpected API action: ${input.action}`);
      const response = copy(value);
      return { ok: true, json: async () => ({ value: response }) };
    },
  });
  vm.runInContext(`${domainSource}\n${uiSource}\n;globalThis.testUI = createUI; globalThis.testCalculate = calculate;`, sandbox, { filename: 'quote-workbench-ui.vm.js' });
  const { App } = sandbox.testUI(driver.React, { locale: { subscribe: () => () => {}, getSnapshot: () => 'zh-CN' } }, s => s, '');
  driver.mount(App); await driver.flush(); t.after(() => driver.dispose());
  const api = {
    memory, requests, calculate: sandbox.testCalculate,
    get tree() { return driver.tree; },
    button(label, scope = driver.tree) { return one(all(scope, n => n.type === 'button' && text(n) === label), `button ${label}`); },
    field(label) {
      const aria = all(driver.tree, n => ['input', 'select', 'textarea'].includes(n.type) && n.props['aria-label'] === label);
      if (aria.length) return one(aria, `control ${label}`);
      const wrapper = one(all(driver.tree, n => n.type === 'label' && n.children.some(c => c?.type === 'span' && text(c) === label)), `label ${label}`);
      return one(all(wrapper, n => ['input', 'select', 'textarea'].includes(n.type)), `field ${label}`);
    },
    article(name) { return one(all(driver.tree, n => n.type === 'article' && all(n, child => child.type === 'h3' && text(child).startsWith(name)).length), `article ${name}`); },
    async click(label, scope) {
      const control = api.button(label, scope); assert.ok(!control.props.disabled, `${label} must be enabled`);
      await control.props.onClick(); await driver.flush();
    },
    async change(label, value) {
      const control = api.field(label); assert.ok(!control.props.disabled, `${label} must be enabled`);
      if (control.type === 'select') assert.ok(all(control, n => n.type === 'option' && n.props.value === value).length, `select ${label} must offer ${value}`);
      await control.props.onChange({ target: { value: String(value) } }); await driver.flush();
    },
    options(label) { return all(api.field(label), n => n.type === 'option').map(n => n.props.value).filter(Boolean); },
  };
  return api;
}

test('factory source options filter currency, usable units/prices and normalized CAS; mode changes clear selection', async t => {
  const ui = await mount(t, { factories: [factory('rmb'), factory('usd', { currency: 'USD' }),
    factory('other-cas', { cas: '64-17-5' }), factory('unknown-unit', { unit: '待确认' }),
    factory('zero', { price: 0 }), factory('negative', { price: -1 }), factory('missing', { price: null })] });
  await ui.click('报价核算');
  assert.deepEqual(ui.options('选取工厂报价'), ['rmb', 'other-cas']);
  await ui.change('CAS 号', ' 67 – 68 – 5 ');
  assert.deepEqual(ui.options('选取工厂报价'), ['rmb']);
  await ui.change('选取工厂报价', 'rmb');
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('选取工厂报价').props.value, '');
  assert.equal(ui.button('带入成本').props.disabled, true);
  await ui.click('美元采购');
  assert.deepEqual(ui.options('选取工厂报价'), ['usd']);
  await ui.change('选取工厂报价', 'usd');
  await ui.click('自有工厂倒推');
  assert.deepEqual(ui.options('选取工厂报价'), []);
  assert.equal(ui.field('选取工厂报价').props.value, '');
  assert.equal(ui.button('带入成本').props.disabled, true);
});

test('bringing factory cost converts tonnes, preserves customer Incoterm and current purchase mode', async t => {
  const ui = await mount(t, { factories: [factory('rmb'), factory('usd', { currency: 'USD', price: 2100 })] });
  await ui.click('报价核算'); await ui.change('Incoterm', 'CIF');
  await ui.change('选取工厂报价', 'rmb'); await ui.click('带入成本');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('Incoterm').props.value, 'CIF');
  assert.equal(ui.button('人民币采购').props['aria-pressed'], true);
  assert.equal(ui.field('退税率 %').props.value, 13);
  await ui.click('工厂报价'); await ui.click('带入核算', ui.article('报价 usd'));
  assert.equal(ui.button('美元采购').props['aria-pressed'], true);
  assert.equal(ui.field('采购单价 USD/kg').props.value, 2.1);
  assert.equal(ui.field('Incoterm').props.value, 'CIF');
});

test('editing a saved factory uses update and revision, preserves legacy dates/raw and does not append', async t => {
  const original = factory('existing', { validity: '报价后一周', quoteDate: '2026/11/01', raw: '原始报价明细', details: '报价详细说明' });
  const ui = await mount(t, { factories: [original] });
  await ui.click('编辑', ui.article(original.name));
  assert.equal(ui.field('报价日期').props.value, '2026-11-01');
  assert.equal(ui.field('报价有效期').props.value, '');
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, original.raw);
  await ui.change('报价单价', '15000'); await ui.click('保存修改');
  const updates = ui.requests.filter(r => r.action === 'update');
  assert.equal(updates.length, 1); assert.equal(updates[0].id, original.id);
  assert.equal(updates[0].revision, 7); assert.equal(updates[0].kind, 'factories');
  assert.equal(updates[0].record.price, 15000); assert.equal(updates[0].record.validity, original.validity);
  assert.equal(updates[0].record.raw, original.raw);
  assert.equal(ui.requests.some(r => r.action === 'add'), false);
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].createdAt, original.createdAt);
  assert.ok(ui.button('确认并保存报价'));
});

test('cancel editing causes no mutation; stale revision shows error and retains editable values', async t => {
  const ui = await mount(t, { factories: [factory('existing')] });
  await ui.click('编辑', ui.article('报价 existing')); await ui.change('报价单价', '16000');
  await ui.click('取消编辑');
  assert.equal(ui.requests.filter(r => ['update', 'add', 'delete'].includes(r.action)).length, 0);
  await ui.click('编辑', ui.article('报价 existing')); await ui.change('报价单价', '17000');
  ui.memory.revision++; // Another client changes the server snapshot, in memory only.
  await ui.click('保存修改');
  assert.equal(ui.memory.factories[0].price, 14000);
  assert.equal(ui.field('报价单价').props.value, 17000);
  assert.equal(text(one(all(ui.tree, n => n.props.role === 'alert'), 'conflict alert')), '记录已更新，请刷新后重试。');
  assert.ok(ui.button('保存修改'));
});

test('catalog save/search and bring-in drive both forms; CAS autofill clears only generated names', async t => {
  const ui = await mount(t);
  await ui.click('产品目录');
  await ui.change('产品名称', '二甲基亚砜'); await ui.change('CAS 号', ' 67 – 68 – 5 ');
  await ui.click('保存产品');
  assert.equal(ui.memory.products[0].cas, '67-68-5');
  assert.equal(ui.requests.find(r => r.kind === 'products').revision, 7);
  await ui.change('搜索产品名称或 CAS', '67-68-5');
  await ui.click('带入核算', ui.article('二甲基亚砜'));
  assert.equal(ui.field('产品 / 规格').props.value, '二甲基亚砜');
  assert.equal(ui.field('CAS 号').props.value, '67-68-5');
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('产品 / 规格').props.value, '');
  await ui.change('产品 / 规格', '手填规格'); await ui.change('CAS 号', '75-07-0');
  assert.equal(ui.field('产品 / 规格').props.value, '手填规格');
  await ui.change('CAS 号', ' 67–68–5 ');
  assert.equal(ui.field('产品 / 规格').props.value, '二甲基亚砜');
  await ui.click('产品目录'); await ui.click('带入工厂', ui.article('二甲基亚砜'));
  assert.equal(ui.field('产品').props.value, '二甲基亚砜');
  await ui.change('CAS 号', '64-17-5'); assert.equal(ui.field('产品').props.value, '');
  await ui.change('产品', '工厂手填规格'); await ui.change('CAS 号', '75-07-0');
  assert.equal(ui.field('产品').props.value, '工厂手填规格');
});

test('catalog includes saved quote products and prevents duplicate normalized CAS without writes', async t => {
  const ui = await mount(t, { factories: [factory('derived', { name: '报价目录产品' })] });
  await ui.click('产品目录');
  const derived = ui.article('报价目录产品');
  assert.equal(all(derived, n => n.type === 'button' && text(n) === '删除').length, 0);
  await ui.change('产品名称', '重复产品'); await ui.change('CAS 号', '67 – 68 – 5'); await ui.click('保存产品');
  assert.equal(ui.requests.filter(r => r.action === 'add').length, 0);
  assert.ok(all(ui.tree, n => n.props.role === 'alert').length);
  await ui.change('搜索产品名称或 CAS', '不匹配');
  assert.equal(all(ui.tree, n => n.type === 'article').length, 0);
});

test('AI empty results clear the previous parsed form and pending queue without writing records', async t => {
  const parsed = factory('parsed', { name: 'AI待核对产品', validity: '收到订单后一周', raw: '第一条原文' });
  const ui = await mount(t, {}, [
    { records: [parsed, factory('queued', { name: '不应再出现的队列产品' })], model: 'test-model' },
    { records: [], model: 'test-model' },
  ]);
  await ui.change('原始报价 / Excel 表格', '第一批两条报价'); await ui.click('AI 提取字段');
  assert.equal(ui.field('产品').props.value, parsed.name);
  assert.equal(ui.field('报价有效期').props.value, '');
  assert.ok(all(ui.tree, n => n.type === 'p' && text(n).includes('原有效期：收到订单后一周')).length,
    'pending legacy validity must remain visible while its date input is blank');
  await ui.change('原始报价 / Excel 表格', '无法识别的第二批内容'); await ui.click('AI 提取字段');
  assert.equal(ui.field('产品').props.value, '');
  assert.equal(ui.field('报价单价').props.value, '');
  assert.equal(ui.field('CAS 号').props.value, '');
  assert.equal(ui.field('报价有效期').props.value, '');
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, '无法识别的第二批内容');
  assert.equal(all(ui.tree, n => n.type === 'span' && text(n) === '1 / 2').length, 0);
  assert.ok(all(ui.tree, n => n.props.role === 'status' && text(n).includes('没有从这段内容中识别到报价')).length);
  assert.equal(ui.requests.filter(r => ['add', 'update'].includes(r.action)).length, 0);
  // A subsequent manual save must not resurrect the previous pending second record.
  await ui.change('产品', '手填新报价'); await ui.change('报价单价', '20');
  await ui.change('计价单位', '公斤'); await ui.change('退税率 %（不退税填 0）', '0');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].name, '手填新报价');
  assert.equal(ui.memory.factories[0].raw, '无法识别的第二批内容');
  assert.equal(ui.field('产品').props.value, '');
});

test('rule extraction advances multiple TSV records one save at a time with per-row raw and current revision', async t => {
  const ui = await mount(t, { factories: [factory('existing')] });
  await ui.click('编辑', ui.article('报价 existing'));
  const firstDetails = 'USD 1390/吨 FOB 青岛';
  const secondDetails = 'USD 2.5/kg FCA 上海';
  const raw = `产品\tCAS 号\t报价明细\t报价日期\t报价有效期\n产品甲\t67-68-5\t${firstDetails}\t2026/11/01\t2026/12/01\n产品乙\t64-17-5\t${secondDetails}\t2026/11/02\t2026/12/02`;
  await ui.change('原始报价 / Excel 表格', raw); await ui.click('规则提取');
  assert.equal(ui.requests.filter(r => r.action === 'parse').length, 0, 'rule extraction must stay local');
  assert.equal(ui.field('产品').props.value, '产品甲');
  assert.equal(ui.field('报价单价').props.value, 1390);
  assert.equal(ui.field('报价日期').props.value, '2026-11-01');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 2);
  assert.equal(ui.field('产品').props.value, '产品乙');
  assert.equal(ui.field('CAS 号').props.value, '64-17-5');
  assert.equal(ui.field('报价单价').props.value, 2.5);
  assert.equal(ui.field('计价单位').props.value, '公斤');
  assert.equal(ui.field('报价有效期').props.value, '2026-12-02');
  await ui.click('确认并保存报价');
  const saves = ui.requests.filter(r => r.action === 'add');
  assert.deepEqual(saves.map(r => r.revision), [7, 8]);
  assert.deepEqual(saves.map(r => r.record.name), ['产品甲', '产品乙']);
  assert.deepEqual(saves.map(r => r.record.raw), [firstDetails, secondDetails]);
  assert.equal(ui.requests.filter(r => r.action === 'update').length, 0, 'new parsing must leave edit mode');
  assert.equal(ui.memory.factories.length, 3);
  assert.equal(ui.memory.factories[0].price, 14000);
  assert.equal(ui.field('产品').props.value, '');
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, '');
});

test('old history reconstructs freight range and copy falls back to tax rebate and single sea amount', async t => {
  const values = { product: '旧记录', cas: '67-68-5', qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7,
    sea: 100, seaMax: 300, local: 0, tax: 13, transport: 0, credit: 0, interest: 0, months: 0 };
  // Independent fixture arithmetic: fully rebated RMB14/kg -> USD14/1.13/7/kg.
  const base = 14 / 1.13 / 7;
  const profit = 5000 - base * 1000 - 100;
  const result = { base, landed: base + .1, profit, margin: profit / (base * 1000), rmb: profit * 7, insurance: 0, credit: 0, interest: 0 };
  const singleValues = { ...values, product: '旧单值记录' }; delete singleValues.seaMax;
  const ui = await mount(t, { history: [
    { id: 'range', mode: 'rmb', date: '2026-11-01T00:00:00Z', values, result },
    { id: 'single', mode: 'rmb', date: '2026-11-01T00:00:00Z', values: singleValues, result },
  ] });
  await ui.click('核算记录');
  const rangeRow = ui.article('旧记录');
  const formatted = n => n.toLocaleString('zh-CN', { maximumFractionDigits: 4, minimumFractionDigits: 2 });
  assert.ok(text(rangeRow).includes(`${formatted(profit - 200)} ～ ${formatted(profit)}`), 'history must calculate high-freight fallback, not repeat the low result');
  await ui.click('查看 / 复制重算', rangeRow);
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 300);
  assert.equal(ui.field('退税率 %').props.value, 13);
  assert.equal(ui.field('Incoterm').props.value, '待确认');
  await ui.click('核算记录'); await ui.click('查看 / 复制重算', ui.article('旧单值记录'));
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 100);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 100);
  assert.equal(ui.button('保存本次核算').props.disabled, false);
  assert.equal(ui.memory.history[0].values.rebate, undefined, 'view/copy must not mutate stored history');
  assert.equal(ui.memory.history[1].values.seaMax, undefined);
});
