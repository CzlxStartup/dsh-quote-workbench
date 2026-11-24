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
    reset() { frames.clear(); tree = undefined; root = undefined; effects = []; dirty = true; },
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
  return { id, name: `Quote ${id}`, cas: '67-68-5', price: 14000, currency: 'RMB', unit: '吨',
    rebate: 13, incoterm: 'FOB', port: 'Qingdao', factory: '测试工厂', quoteDate: '2026-11-01',
    validity: '2026-12-01', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...overrides };
}
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (value, days) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
async function mount(t, seed = {}, parseResponses = [], storedSession = null) {
  const driver = renderer(), requests = [], downloads = [], sessionValues = storedSession || new Map();
  const memory = { revision: 7, factories: [], products: [], history: [], freights: [], ...copy(seed) };
  class FakeBlob {
    constructor(parts, options = {}) { this.parts = parts; this.type = options.type || ''; }
  }
  const sandbox = vm.createContext({
    AbortController, console, Blob: FakeBlob, atob,
    URL: { createObjectURL: () => 'blob:quote-test', revokeObjectURL: () => {} },
    setTimeout: () => {},
    document: { createElement: () => ({ href: '', download: '', click() { downloads.push(this.download); } }) },
    window: { confirm: () => true },
    sessionStorage: {
      getItem: key => sessionValues.has(key) ? sessionValues.get(key) : null,
      setItem: (key, value) => { sessionValues.set(key, String(value)); },
      removeItem: key => { sessionValues.delete(key); },
    },
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
      else if (input.action === 'quotation') {
        assert.ok(Array.isArray(input.items) && input.items.length, 'quotation must include item values');
        value = { filename: 'Quotation_Test.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: 'ZmFrZS14bHN4' };
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
  const createApp = () => sandbox.testUI(driver.React, { locale: { subscribe: () => () => {}, getSnapshot: () => 'zh-CN' } }, s => s, '').App;
  let App = createApp();
  driver.mount(App); await driver.flush(); t.after(() => driver.dispose());
  const api = {
    memory, requests, calculate: sandbox.testCalculate,
    get downloads() { return downloads; },
    get tree() { return driver.tree; },
    async remount() { driver.reset(); driver.mount(App); await driver.flush(); },
    async reload() { App = createApp(); driver.reset(); driver.mount(App); await driver.flush(); },
    async flush() { await driver.flush(); },
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
    async toggle(label) {
      const control = one(all(driver.tree, n => n.type === 'input' && n.props.type === 'checkbox' && n.props['aria-label'] === label), `checkbox ${label}`);
      await control.props.onChange({ target: { checked: !control.props.checked } }); await driver.flush();
    },
    options(label) { return all(api.field(label), n => n.type === 'option').map(n => n.props.value).filter(Boolean); },
  };
  return api;
}

test('history selection merges same-customer products with their factory sources', async t => {
  const base = { qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7, sea: 100, seaMax: 300, local: 0, tax: 13, rebate: 13, transport: 0, credit: 0, interest: 0, months: 0, customerTerm: 'CIF', place: 'Oslo' };
  const result = { base: 2, landed: 2.1, profit: 1, margin: 1, rmb: 1, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, {
    factories: [
      factory('f1', { name: 'MCP 22%', cas: '67-68-5', purity: '22% P', packing: '25 kg / bag', validity: '2026-11-20', delivery: 'November 2026' }),
      factory('f2', { name: 'Urea 46%', cas: '57-13-6', purity: '46% N', packing: '50 kg / bag', validity: '2026-11-25', delivery: 'December 2026' }),
    ],
    history: [
      { id: 'h1', mode: 'rmb', date: '2026-11-01T00:00:00Z', values: { ...base, product: 'MCP 22%', cas: '67-68-5', customer: 'ACME', creditMonths: 3, creditPayment: 'L/C' }, result },
      { id: 'h2', mode: 'rmb', date: '2026-11-02T00:00:00Z', values: { ...base, product: 'Urea 46%', cas: '57-13-6', customer: 'ACME' }, result },
    ],
  });
  await ui.click('核算记录');
  assert.equal(ui.button('合并输出报价单').props.disabled, true);
  await ui.toggle('选择 MCP 22%');
  await ui.toggle('选择 Urea 46%');
  assert.match(text(ui.tree), /已选 2 条 · ACME/);
  assert.equal(ui.button('合并输出报价单').props.disabled, false);
  await ui.click('合并输出报价单');
  const request = one(ui.requests.filter(row => row.action === 'quotation'), 'quotation request');
  assert.equal(request.items.length, 2);
  assert.equal(request.includeCosting, true);
  assert.deepEqual(request.items.map(item => item.factoryId), ['f1', 'f2']);
  assert.equal(request.items[0].values.customer, 'ACME');
  assert.equal(request.items[0].values.product, 'MCP 22%');
  assert.equal(request.items[1].values.product, 'Urea 46%');
  assert.deepEqual(ui.downloads, ['Quotation_Test.xlsx']);
  assert.equal(ui.memory.revision, 7);
});

test('calculation exports an editable quotation with the active factory source', async t => {
  const ui = await mount(t, { factories: [factory('rmb')] });
  await ui.click('报价核算');
  assert.equal(ui.button('输出报价单').props.disabled, true);
  await ui.click('载入 Excel 样例');
  assert.equal(ui.button('输出报价单').props.disabled, true);
  await ui.change('ETD（预计开船日）', 'Mid November 2026');
  await ui.change('选取工厂报价', 'rmb');
  assert.equal(ui.button('输出报价单').props.disabled, false);
  assert.match(ui.button('输出报价单').props.className, /qw-export-button/);
  assert.match(text(ui.tree), /生成英文 Quotation 和内部 Costing 工作表/);
  await ui.click('输出报价单');
  const request = one(ui.requests.filter(row => row.action === 'quotation'), 'quotation request');
  assert.equal(request.mode, undefined);
  assert.equal(request.includeCosting, true);
  assert.equal(request.items.length, 1);
  assert.equal(request.items[0].mode, 'rmb');
  assert.equal(request.items[0].factoryId, 'rmb');
  assert.equal(request.items[0].values.product, 'Quote rmb');
  assert.equal(request.items[0].values.qty, 20000);
  assert.equal(request.items[0].values.sell, 2.33);
  assert.equal(request.items[0].values.etd, 'Mid November 2026');
  assert.deepEqual(ui.downloads, ['Quotation_Test.xlsx']);
  assert.match(text(ui.tree), /已生成 Quotation_Test\.xlsx/);
  assert.equal(ui.memory.revision, 7, 'exporting must not write records');
});

test('customer-only export can be selected and excludes Costing', async t => {
  const ui = await mount(t, { factories: [factory('rmb')] });
  await ui.click('报价核算');
  await ui.click('载入 Excel 样例');
  await ui.change('选取工厂报价', 'rmb');
  await ui.toggle('包含成本数据');
  assert.equal(ui.button('输出报价单').props.disabled, false);
  await ui.click('输出报价单');
  const request = one(ui.requests.filter(row => row.action === 'quotation'), 'quotation request');
  assert.equal(request.includeCosting, false);
  assert.equal(request.items.length, 1);
  assert.deepEqual(ui.downloads, ['Quotation_Test.xlsx']);
  assert.match(text(ui.tree), /仅含客户 Quotation 页/);
});

test('ETD is free text restricted to English characters, digits and punctuation', async t => {
  const ui = await mount(t);
  await ui.click('报价核算');
  await ui.change('ETD（预计开船日）', 'Mid Nov 2026');
  assert.equal(ui.field('ETD（预计开船日）').props.value, 'Mid Nov 2026');
  assert.equal(ui.field('ETD（预计开船日）').props.type, 'text');
  await ui.change('ETD（预计开船日）', '11月');
  assert.equal(ui.field('ETD（预计开船日）').props['aria-invalid'], true);
  assert.ok(all(ui.tree, n => n.type === 'span' && text(n) === 'ETD 只能输入英文字符、数字和标点').length);
});

test('factory source options filter currency, usable units/prices and normalized CAS; mode changes clear selection', async t => {
  const ui = await mount(t, { factories: [factory('rmb'), factory('usd', { currency: 'USD' }),
    factory('other-cas', { cas: '64-17-5' }), factory('unknown-unit', { unit: '待确认' }),
    factory('zero', { price: 0 }), factory('negative', { price: -1 }), factory('missing', { price: null })] });
  await ui.click('报价核算');
  assert.deepEqual(ui.options('选取工厂报价'), ['rmb', 'other-cas']);
  await ui.change('CAS 号', ' 67 – 68 – 5 ');
  assert.deepEqual(ui.options('选取工厂报价'), ['rmb']);
  await ui.change('选取工厂报价', 'rmb');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('工厂').props.value, '测试工厂');
  assert.equal(ui.field('工厂').props.disabled, true);
  const costSection = one(all(ui.tree, n => n.type === 'div' && n.props.className === 'qw-section' && n.children.some(child => child?.type === 'h3' && text(child) === '02 / 工厂与运输成本')), 'cost section');
  assert.equal(all(costSection, n => n.type === 'label').map(text)[0], '工厂');
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('选取工厂报价').props.value, '');
  assert.equal(ui.button('带入成本').props.disabled, true);
  await ui.click('美元采购');
  assert.deepEqual(ui.options('选取工厂报价'), ['usd']);
  await ui.change('选取工厂报价', 'usd');
  await ui.click('自有工厂倒推');
  assert.equal(all(ui.tree, n => n.type === 'h3' && text(n) === '01 / 选取工厂报价').length, 0, 'reverse mode hides the factory selection');
  assert.equal(all(ui.tree, n => n.type === 'select' && n.props['aria-label'] === '选取工厂报价').length, 0);
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n).includes('采购单价')).length, 0);
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n).includes('买汇 / 成本汇率')).length, 0);
  assert.equal(ui.field('收汇汇率 RMB/USD').props.value, 6.75);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, '');
  assert.equal(ui.field('最高国际运费 USD/票').props.value, '');
  assert.equal(ui.field('增值税率 %').props.value, 13);
  assert.equal(ui.field('退税率 %').props.value, '');
});

test('RMB/USD calc page groups factory quote, factory costs, customer offer and rates', async t => {
  const ui = await mount(t);
  await ui.click('报价核算');
  const sections = () => all(ui.tree, n => n.type === 'div' && n.props.className === 'qw-section');
  const headings = () => all(ui.tree, n => n.type === 'h3').map(text);
  const labels = node => all(node, n => n.type === 'label').map(text);
  const hasLabel = (node, name) => labels(node).some(value => value.startsWith(name));
  assert.deepEqual(headings(), ['01 / 选取工厂报价', '02 / 工厂与运输成本', '03 / 对客户报价', '04 / 其他费率、资金占用情况']);
  assert.deepEqual(labels(sections()[0]), ['产品 / 规格', 'CAS 号', '增值税率 %', '退税率 %'], 'VAT and rebate follow product/CAS in the factory section');
  assert.equal(labels(sections()[1]).includes('数量 kg'), true, 'quantity belongs with factory and freight costs');
  assert.equal(labels(sections()[1]).includes('含税采购单价 RMB/kg'), true);
  assert.equal(labels(sections()[1]).includes('收汇汇率 RMB/USD'), true, 'FX moves into the factory cost section');
  assert.equal(labels(sections()[2]).includes('CAS 号'), false, 'customer offer must not repeat product/CAS');
  assert.equal(labels(sections()[2]).includes('数量 kg'), false, 'customer offer must not repeat quantity');
  assert.equal(hasLabel(sections()[2], '报价国家 / 地区'), true, 'quote country belongs to the customer offer');
  assert.equal(labels(sections()[3]).includes('收汇汇率 RMB/USD'), false, 'last section holds other rates and capital occupation only');
  assert.equal(labels(sections()[3]).includes('资金占用月数'), true);
  await ui.click('自有工厂倒推');
  assert.deepEqual(headings(), ['01 / 产品与报价', '02 / 成本与参数']);
});

test('confirmed CAS fills product, VAT and rebate from saved history and clears stale auto rates', async t => {
  const values = { product: '历史产品', cas: '67-68-5', tax: 9, rebate: 5, qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7,
    sea: 100, local: 0, transport: 0, credit: 0, interest: 0, months: 0 };
  const result = { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, { history: [{ id: 'bound', mode: 'rmb', date: '2026-11-01T00:00:00Z', values, result }] });
  await ui.click('报价核算');
  await ui.change('CAS 号', '67-68-5');
  assert.equal(ui.field('产品 / 规格').props.value, '历史产品');
  assert.equal(ui.field('增值税率 %').props.value, 9);
  assert.equal(ui.field('退税率 %').props.value, 5);
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('产品 / 规格').props.value, '', 'a CAS without history clears the auto product name');
  assert.equal(ui.field('增值税率 %').props.value, 13, 'stale auto VAT returns to the default');
  assert.equal(ui.field('退税率 %').props.value, '', 'stale auto rebate returns to the default');
});

test('saving a calculation remembers its VAT and rebate for the CAS', async t => {
  const ui = await mount(t);
  await ui.click('报价核算');
  await ui.change('产品 / 规格', 'NewProduct');
  await ui.change('CAS 号', '75-07-0');
  await ui.change('数量 kg', 20000);
  await ui.change('对客单价 USD/kg', 2.33);
  await ui.change('含税采购单价 RMB/kg', 14);
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('最低国际运费 USD/票', 5000);
  await ui.change('最高国际运费 USD/票', 5000);
  await ui.change('国内费用总额 RMB/票', 2000);
  await ui.change('信用保险费率 %', 0.441);
  await ui.change('增值税率 %', 12);
  await ui.change('退税率 %', 7);
  assert.equal(ui.button('保存本次核算').props.disabled, false);
  await ui.click('保存本次核算');
  assert.equal(ui.memory.history.length, 1);
  assert.equal(ui.field('产品 / 规格').props.value, '');
  assert.equal(ui.field('数量 kg').props.value, '');
  assert.equal(ui.button('保存本次核算').props.disabled, true);
  assert.match(text(ui.tree), /已保存，核算页面已清空/);

  await ui.click('载入 Excel 样例');
  assert.equal(ui.field('增值税率 %').props.value, 13, 'the sample resets the rates');
  assert.equal(ui.field('退税率 %').props.value, 13);
  await ui.change('CAS 号', '75-07-0');
  assert.equal(ui.field('产品 / 规格').props.value, 'NewProduct');
  assert.equal(ui.field('增值税率 %').props.value, 12);
  assert.equal(ui.field('退税率 %').props.value, 7);

  await ui.click('产品目录');
  assert.match(text(ui.article('NewProduct')), /增值税率 12% · 退税率 7%/);
});

test('CAS rate binding uses the newest saved calculation', async t => {
  const make = (product, tax, rebate, id, date) => ({ id, mode: 'rmb', date,
    values: { product, cas: '67-68-5', tax, rebate, qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7, sea: 100, local: 0, transport: 0, credit: 0, interest: 0, months: 0 },
    result: { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 } });
  const ui = await mount(t, { history: [
    make('新税率产品', 10, 5, 'newer', '2026-11-02T00:00:00Z'),
    make('旧税率产品', 12, 7, 'older', '2026-11-01T00:00:00Z'),
  ] });
  await ui.click('报价核算');
  await ui.change('CAS 号', '67-68-5');
  assert.equal(ui.field('产品 / 规格').props.value, '新税率产品');
  assert.equal(ui.field('增值税率 %').props.value, 10);
  assert.equal(ui.field('退税率 %').props.value, 5);
});

test('factory quote form puts VAT before rebate and fills both from the CAS binding', async t => {
  const values = { product: '绑定产品', cas: '67-68-5', tax: 9, rebate: 5 };
  const ui = await mount(t, { history: [{ id: 'bind', mode: 'rmb', date: '2026-11-01T00:00:00Z', values, result: {} }] });
  await ui.click('工厂报价');
  const labels = all(ui.tree, n => n.type === 'label').map(text);
  assert.ok(labels.includes('增值税率 %'));
  assert.ok(labels.indexOf('增值税率 %') < labels.indexOf('退税率 %（不退税填 0）'), 'VAT precedes rebate');
  await ui.change('CAS 号', '67-68-5');
  assert.equal(ui.field('产品').props.value, '绑定产品');
  assert.equal(ui.field('增值税率 %').props.value, 9);
  assert.equal(ui.field('退税率 %（不退税填 0）').props.value, 5);
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('增值税率 %').props.value, '', 'stale auto VAT clears for a new CAS');
  assert.equal(ui.field('退税率 %（不退税填 0）').props.value, '');
});

test('factory draft survives leaving and re-entering within five minutes', async t => {
  const ui = await mount(t);
  await ui.click('工厂报价');
  await ui.change('产品', '草稿产品');
  await ui.change('增值税率 %', 9);
  await ui.change('退税率 %（不退税填 0）', 7);
  await ui.change('原始报价 / Excel 表格', '草稿原文');
  await ui.remount();
  assert.equal(ui.field('产品').props.value, '草稿产品');
  assert.equal(ui.field('增值税率 %').props.value, 9);
  assert.equal(ui.field('退税率 %（不退税填 0）').props.value, 7);
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, '草稿原文');
});

test('freight and product drafts survive leaving and re-entering within five minutes', async t => {
  const ui = await mount(t);
  await ui.click('货代报价');
  await ui.change('货代名称', '草稿货代');
  await ui.change('起运地', '草稿起运地');
  await ui.change('目的地', '草稿目的地');
  await ui.change('运输方式', '海运拼箱');
  await ui.change('询价数量', 25);
  await ui.change('是否抛货', '是');
  await ui.change('体积（CBM）', 4);
  await ui.click('产品目录');
  await ui.change('产品名称', '草稿产品');
  await ui.change('CAS 号', '67-68-5');
  await ui.change('搜索产品名称或 CAS', '草稿');
  await ui.remount();
  assert.equal(ui.button('产品目录').props['aria-current'], 'page', 'last page restores with the draft');
  assert.equal(ui.field('产品名称').props.value, '草稿产品');
  assert.equal(ui.field('CAS 号').props.value, '67-68-5');
  assert.equal(ui.field('搜索产品名称或 CAS').props.value, '草稿');
  await ui.click('货代报价');
  assert.equal(ui.field('货代名称').props.value, '草稿货代');
  assert.equal(ui.field('起运地').props.value, '草稿起运地');
  assert.equal(ui.field('目的地').props.value, '草稿目的地');
  assert.equal(ui.field('运输方式').props.value, '海运拼箱');
  assert.equal(ui.field('询价数量').props.value, 25);
  assert.equal(ui.field('是否抛货').props.value, '是');
  assert.equal(ui.field('体积（CBM）').props.value, 4);
});

test('history filter and selection drafts survive leaving and re-entering within five minutes', async t => {
  const row = (id, product) => ({ id, mode: 'rmb', date: '2026-11-01T00:00:00Z',
    values: { product, customer: '客户甲', cas: '67-68-5', qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7, sea: 100, local: 0, tax: 13, rebate: 13, transport: 0, credit: 0, interest: 0, months: 0, customerTerm: '待确认' },
    result: { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 } });
  const ui = await mount(t, { history: [row('a', '历史甲'), row('b', '历史乙')] });
  await ui.click('核算记录');
  await ui.change('按 CAS 筛选核算记录', '67-68');
  await ui.change('按客户名称筛选核算记录', '客户甲');
  await ui.click('全选当前结果');
  await ui.remount();
  assert.equal(ui.button('核算记录').props['aria-current'], 'page');
  assert.equal(ui.field('按 CAS 筛选核算记录').props.value, '67-68');
  assert.equal(ui.field('按客户名称筛选核算记录').props.value, '客户甲');
  const checks = all(ui.tree, node => node.type === 'input' && String(node.props['aria-label'] || '').startsWith('选择 '));
  assert.equal(checks.length, 2);
  assert.ok(checks.every(node => node.props.checked), 'selected history records restore');
});

test('drafts older than five minutes are discarded for every page', async t => {
  const key = 'quote-workbench.drafts.v2';
  const stored = new Map([[key, JSON.stringify({
    savedAt: Date.now() - 6 * 60 * 1000,
    tab: 'products',
    factory: { form: { product: '过期草稿', tax: 9, rebate: 7 }, raw: '旧原文', pending: [], index: 0, editing: null },
    freight: { agent: '旧货代', origin: '旧起运地', destination: '旧目的地' },
    product: { name: 'OldProduct', cas: '67-68-5', tax: 9, rebate: 7 },
    catalogSearch: '旧搜索',
    historyFilter: { cas: '67-68', customer: '旧客户' },
    selected: ['a'],
    selectedHistory: ['a'],
    historySource: 'a',
  })]]);
  const ui = await mount(t, {}, [], stored);
  assert.equal(ui.button('工厂报价').props['aria-current'], 'page', 'expired tab falls back to the first page');
  assert.equal(ui.field('产品').props.value, '');
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, '');
  await ui.click('货代报价');
  assert.equal(ui.field('货代名称').props.value, '');
  assert.equal(ui.field('起运地').props.value, '');
  assert.equal(ui.field('目的地').props.value, '');
  await ui.click('产品目录');
  assert.equal(ui.field('产品名称').props.value, '');
  assert.equal(ui.field('CAS 号').props.value, '');
  assert.equal(ui.field('搜索产品名称或 CAS').props.value, '');
  await ui.click('核算记录');
  assert.equal(ui.field('按 CAS 筛选核算记录').props.value, '');
  assert.equal(ui.field('按客户名称筛选核算记录').props.value, '');
  assert.equal(all(ui.tree, node => node.type === 'input' && node.props.checked && node.props['aria-label'] !== '包含成本数据').length, 0);
  await ui.click('报价核算');
  assert.equal(ui.field('数量 kg').props.value, '');
});

test('structured text blocks Chinese except the factory name', async t => {
  const ui = await mount(t);
  await ui.click('工厂报价');
  await ui.change('产品', '中文产品');
  assert.equal(ui.field('产品').props['aria-invalid'], true);
  assert.ok(all(ui.tree, n => n.props.className === 'qw-field-error' && text(n) === '不能包含中文').length >= 1);
  await ui.change('工厂', '中文工厂');
  assert.equal(ui.field('工厂').props['aria-invalid'], undefined, 'factory names may contain Chinese');
  await ui.change('原始报价 / Excel 表格', '中文原文');
  await ui.change('其他关键质量指标', '中文质量');
  assert.equal(ui.field('其他关键质量指标').props['aria-invalid'], undefined, 'long text fields are exempt');
  await ui.change('报价单价', 100);
  await ui.change('币种', 'RMB');
  await ui.change('计价单位', '公斤');
  await ui.change('退税率 %（不退税填 0）', 0);
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 0, 'Chinese in a structured field blocks saving');
  assert.match(text(one(all(ui.tree, n => n.props.role === 'alert'), 'error')), /不能包含中文/);
  await ui.change('产品', 'EnglishProduct');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].factory, '中文工厂');
  assert.equal(ui.memory.factories[0].raw, '中文原文');

  await ui.click('报价核算');
  await ui.change('产品 / 规格', '中文产品');
  assert.equal(ui.field('产品 / 规格').props['aria-invalid'], true);
  await ui.change('CAS 号', '67-68-5');
  assert.equal(ui.field('CAS 号').props['aria-invalid'], undefined);
});

test('factory quantity accepts Arabic digits only and blocks other characters', async t => {
  const ui = await mount(t);
  await ui.click('工厂报价');
  await ui.change('数量', '22');
  assert.equal(ui.field('数量').props['aria-invalid'], undefined);
  await ui.change('数量', '22t');
  assert.equal(ui.field('数量').props['aria-invalid'], true);
  assert.ok(all(ui.tree, n => n.props.className === 'qw-field-error' && text(n) === '数量只能填写阿拉伯数字').length >= 1);
  await ui.change('产品', 'ProductQ');
  await ui.change('报价单价', 100);
  await ui.change('币种', 'RMB');
  await ui.change('计价单位', '公斤');
  await ui.change('退税率 %（不退税填 0）', 0);
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 0, 'non-digit quantity blocks saving');
  assert.match(text(one(all(ui.tree, n => n.props.role === 'alert'), 'error')), /数量只能填写阿拉伯数字/);
  await ui.change('数量', '20');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].quantity, '20');
});

test('own-factory reverse page uses receipt FX, min/max freight, VAT and rebate for its range', async t => {
  const ui = await mount(t);
  await ui.click('报价核算'); await ui.click('自有工厂倒推');
  await ui.change('产品 / 规格', 'DCP');
  await ui.change('数量 kg', 1000);
  await ui.change('对客单价 USD/kg', 27.5);
  await ui.change('最低国际运费 USD/票', 100);
  await ui.change('最高国际运费 USD/票', 300);
  await ui.change('国内费用总额 RMB/票', 2000);
  await ui.change('信用保险费率 %', 0.422);
  await ui.change('退税率 %', 13);
  const price = () => {
    const results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
    const match = results.match(/人民币含税倒推价 RMB\/kg([\d,.]+)/);
    assert.ok(match, 'reverse price must be shown');
    return Number(match[1].replaceAll(',', ''));
  };
  const withRebate = price();
  let results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /人民币含税倒推价 RMB\/kg[\d,]+\.\d+ ～ [\d,]+\.\d+/);
  assert.match(results, /美元不含税倒推价 USD\/kg[\d,]+\.\d+ ～ [\d,]+\.\d+/);
  assert.doesNotMatch(results, /C&F 成本/);
  assert.equal(ui.button('保存本次核算').props.disabled, false);
  await ui.change('退税率 %', 0);
  assert.ok(price() < withRebate, 'a lower rebate rate lowers the affordable tax-inclusive reverse price');
  await ui.change('最高国际运费 USD/票', 50);
  results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /最高国际运费不能低于最低国际运费/);
  assert.equal(ui.button('保存本次核算').props.disabled, true);
});

test('legacy own history copies its purchase FX into receipt FX and seeds min/max freight', async t => {
  const values = { product: '旧倒推', cas: '67-68-5', qty: 1000, sell: 27.5, sea: 100, local: 2000, fx: 7,
    receive: 6.75, tax: 13, transport: .03, credit: 0, interest: 3.6, months: 3 };
  const result = { unit: 1, rmb: 1, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, { history: [{ id: 'own', mode: 'own', date: '2026-11-01T00:00:00Z', values, result }] });
  await ui.click('核算记录');
  assert.match(text(ui.article('旧倒推')), /人民币含税倒推价 RMB\/kg: 1\.00/);
  await ui.click('编辑', ui.article('旧倒推'));
  assert.equal(ui.field('收汇汇率 RMB/USD').props.value, 7);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 100);
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 100);
  assert.equal(ui.field('退税率 %').props.value, 0);
  assert.equal(ui.memory.history[0].values.receive, 6.75, 'copy must not mutate stored history');
  assert.equal(ui.memory.history[0].values.seaMax, undefined);
});

test('selecting a factory quote auto-fills cost fields, converts tonnes, preserves customer Incoterm, place and current purchase mode', async t => {
  const ui = await mount(t, { factories: [factory('rmb'), factory('usd', { currency: 'USD', price: 2100 })] });
  await ui.click('报价核算'); await ui.change('Incoterm', 'CIF'); await ui.change('交货地点 / 港口', 'Oslo');
  await ui.change('选取工厂报价', 'rmb');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('产品 / 规格').props.value, 'Quote rmb');
  assert.equal(ui.field('CAS 号').props.value, '67-68-5');
  assert.equal(ui.field('交货地点 / 港口').props.value, 'Oslo', 'factory port must not overwrite the customer place');
  assert.equal(ui.field('退税率 %').props.value, 13);
  assert.equal(ui.field('Incoterm').props.value, 'CIF');
  assert.equal(ui.button('人民币采购').props['aria-pressed'], true);
  const status = text(one(all(ui.tree, n => n.props.role === 'status'), 'status'));
  assert.match(status, /已自动填入工厂报价/);
  assert.match(status, /请补充交货地点、运费和汇率/);
  await ui.click('带入成本');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('交货地点 / 港口').props.value, 'Oslo');
  assert.equal(ui.field('Incoterm').props.value, 'CIF');
  assert.equal(ui.button('人民币采购').props['aria-pressed'], true);
  assert.equal(ui.field('退税率 %').props.value, 13);
  await ui.click('工厂报价'); await ui.click('带入核算', ui.article('Quote rmb'));
  assert.equal(ui.field('交货地点 / 港口').props.value, 'Oslo', 'bring-in from the factory list must keep the place too');
  await ui.click('工厂报价'); await ui.click('带入核算', ui.article('Quote usd'));
  assert.equal(ui.button('美元采购').props['aria-pressed'], true);
  assert.equal(ui.field('采购单价 USD/kg').props.value, 2.1);
  assert.equal(ui.field('Incoterm').props.value, 'CIF');
});

test('auto-filled factory fields produce a calculation once quantity, freight and FX are available', async t => {
  const ui = await mount(t, { factories: [factory('rmb')] });
  await ui.click('报价核算');
  await ui.change('数量 kg', 20000);
  await ui.change('对客单价 USD/kg', 2.33);
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('最低国际运费 USD/票', 5000);
  await ui.change('最高国际运费 USD/票', 7000);
  await ui.change('国内费用总额 RMB/票', 2000);
  await ui.change('信用保险费率 %', 0.441);
  await ui.change('选取工厂报价', 'rmb');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('数量 kg').props.value, 20000);
  assert.equal(ui.button('保存本次核算').props.disabled, false);
  const results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /C&F 成本 USD\/kg2\.1225 ～ 2\.2225/);
  assert.match(results, /预计利润 USD[\d,]+\.\d+ ～ [\d,]+\.\d+/);
  assert.match(results, /采购成本利润率[\d,]+\.\d+% ～ [\d,]+\.\d+%/);
  assert.doesNotMatch(results, /会显示区间/);
});

test('C&F cost appears from cost inputs without selling price, credit rate or max freight', async t => {
  const ui = await mount(t, { factories: [factory('rmb', { quantity: '20t' })] });
  await ui.click('报价核算');
  await ui.change('选取工厂报价', 'rmb');
  assert.equal(ui.field('数量 kg').props.value, 20000, '20t from the factory quote becomes 20000 kg');
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('最低国际运费 USD/票', 5000);
  await ui.change('国内费用总额 RMB/票', 2000);
  assert.equal(ui.field('最高国际运费 USD/票').props.value, '');
  let results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /C&F 成本 USD\/kg/);
  assert.match(results, /2\.1225/);
  assert.doesNotMatch(results, /请补全/);
  assert.match(results, /填写高于最低运费的「最高国际运费」后/);
  await ui.change('最高国际运费 USD/票', 7000);
  results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /2\.1225 ～ 2\.2225/);
  assert.doesNotMatch(results, /填写高于最低运费的「最高国际运费」后/);
});

test('USD factory quote shows min/max freight, hides VAT and shows C&F cost before selling and credit inputs', async t => {
  const ui = await mount(t, { factories: [factory('usd', { currency: 'USD', price: 2100, quantity: '20t' })] });
  await ui.click('报价核算'); await ui.click('美元采购');
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n).includes('增值税率 %')).length, 0);
  await ui.change('买汇 / 成本汇率 RMB/USD', 6.85);
  await ui.change('最低国际运费 USD/票', 2900);
  await ui.change('国内费用总额 RMB/票', 8000);
  await ui.change('选取工厂报价', 'usd');
  assert.equal(ui.field('采购单价 USD/kg').props.value, 2.1);
  assert.equal(ui.field('数量 kg').props.value, 20000);
  assert.equal(ui.field('工厂').props.value, '测试工厂');
  assert.equal(ui.field('工厂').props.disabled, true);
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 2900, 'max freight follows the minimum when the quote is applied');
  let results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /C&F 成本 USD\/kg/);
  assert.match(results, /2\.3034/);
  await ui.change('最高国际运费 USD/票', 3500);
  results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /2\.3034 ～ 2\.3334/);
});

test('USD purchase uses min and max freight for profit and margin ranges', async t => {
  const ui = await mount(t, { factories: [factory('usd', { currency: 'USD', price: 2100, quantity: '20t' })] });
  await ui.click('报价核算'); await ui.click('美元采购');
  await ui.change('买汇 / 成本汇率 RMB/USD', 6.85);
  await ui.change('收汇汇率 RMB/USD', 6.75);
  await ui.change('最低国际运费 USD/票', 2900);
  await ui.change('最高国际运费 USD/票', 3500);
  await ui.change('国内费用总额 RMB/票', 8000);
  await ui.change('对客单价 USD/kg', 24.5);
  await ui.change('信用保险费率 %', 0.441);
  await ui.change('选取工厂报价', 'usd');
  assert.equal(ui.button('保存本次核算').props.disabled, false);
  const results = text(one(all(ui.tree, n => n.props.className === 'qw-results-body'), 'results body'));
  assert.match(results, /预计利润 USD[\d,]+\.\d+ ～ [\d,]+\.\d+/);
  assert.match(results, /采购成本利润率[\d,]+\.\d+% ～ [\d,]+\.\d+%/);
  assert.match(results, /人民币利润 RMB[\d,]+\.\d+ ～ [\d,]+\.\d+/);
});

test('each purchase mode keeps its own calculation draft', async t => {
  const ui = await mount(t, { factories: [factory('rmb'), factory('usd', { currency: 'USD', price: 2100 })] });
  await ui.click('报价核算');
  await ui.change('数量 kg', 20000);
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('最低国际运费 USD/票', 5000);
  await ui.change('国内费用总额 RMB/票', 2000);
  await ui.change('选取工厂报价', 'rmb');

  await ui.click('美元采购');
  assert.equal(ui.field('数量 kg').props.value, '');
  assert.equal(ui.field('选取工厂报价').props.value, '');
  await ui.change('数量 kg', 8000);
  await ui.change('买汇 / 成本汇率 RMB/USD', 6.85);
  await ui.change('最低国际运费 USD/票', 2900);
  await ui.change('国内费用总额 RMB/票', 8000);
  await ui.change('选取工厂报价', 'usd');
  assert.equal(ui.field('采购单价 USD/kg').props.value, 2.1);

  await ui.click('人民币采购');
  assert.equal(ui.field('数量 kg').props.value, 20000);
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('收汇汇率 RMB/USD').props.value, 6.67);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 5000);
  assert.equal(ui.field('选取工厂报价').props.value, 'rmb');

  await ui.click('美元采购');
  assert.equal(ui.field('数量 kg').props.value, 8000);
  assert.equal(ui.field('采购单价 USD/kg').props.value, 2.1);
  assert.equal(ui.field('买汇 / 成本汇率 RMB/USD').props.value, 6.85);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 2900);
  assert.equal(ui.field('选取工厂报价').props.value, 'usd');
});

test('calculation draft survives leaving and re-entering the workbench', async t => {
  const ui = await mount(t, { factories: [factory('rmb')] });
  await ui.click('报价核算');
  await ui.change('数量 kg', 20000);
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('最低国际运费 USD/票', 5000);
  await ui.change('国内费用总额 RMB/票', 2000);
  await ui.change('选取工厂报价', 'rmb');
  await ui.remount();
  await ui.click('报价核算');
  assert.equal(ui.field('数量 kg').props.value, 20000);
  assert.equal(ui.field('收汇汇率 RMB/USD').props.value, 6.67);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 5000);
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('选取工厂报价').props.value, 'rmb');
});

test('calculation draft survives a page reload through session storage', async t => {
  const ui = await mount(t, { factories: [factory('rmb')] });
  await ui.click('报价核算');
  await ui.change('数量 kg', 20000);
  await ui.change('收汇汇率 RMB/USD', 6.67);
  await ui.change('选取工厂报价', 'rmb');
  await ui.reload();
  await ui.click('报价核算');
  assert.equal(ui.field('数量 kg').props.value, 20000);
  assert.equal(ui.field('收汇汇率 RMB/USD').props.value, 6.67);
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, 14);
  assert.equal(ui.field('选取工厂报价').props.value, 'rmb');
});

test('capital months defaults to the payment term and manual values stay', async t => {
  const ui = await mount(t);
  await ui.click('报价核算');
  assert.equal(ui.field('资金占用月数').props.value, 3);
  await ui.change('账期（月）', 2);
  assert.equal(ui.field('资金占用月数').props.value, 2);
  await ui.change('资金占用月数', 5);
  await ui.change('账期（月）', 4);
  assert.equal(ui.field('资金占用月数').props.value, 5, 'manual months must not follow a later term change');
  await ui.click('美元采购');
  await ui.change('账期（月）', 1.5);
  assert.equal(ui.field('资金占用月数').props.value, 1.5, 'each mode defaults to its own term before a manual edit');
});

test('copied history keeps a months value that differed from its term', async t => {
  const values = { product: '历史月数', cas: '67-68-5', qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7, sea: 100, local: 0,
    tax: 13, rebate: 13, transport: 0, credit: 0, interest: 3.6, months: 5, creditMonths: 2, customerTerm: '待确认' };
  const result = { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, { history: [{ id: 'five', mode: 'rmb', date: '2026-11-01T00:00:00Z', values, result }] });
  await ui.click('核算记录');
  await ui.click('编辑', ui.article('历史月数'));
  assert.equal(ui.field('账期（月）').props.value, 2);
  assert.equal(ui.field('资金占用月数').props.value, 5);
  await ui.change('账期（月）', 3);
  assert.equal(ui.field('资金占用月数').props.value, 5, 'a stored months value different from the term is treated as custom');
});

test('active page survives leaving and re-entering the workbench', async t => {
  const ui = await mount(t);
  await ui.click('货代报价');
  assert.ok(ui.button('保存货代报价'));
  await ui.remount();
  assert.ok(ui.button('保存货代报价'), 'remount must restore the last page');
  assert.equal(ui.button('货代报价').props['aria-current'], 'page');
  await ui.click('核算记录');
  await ui.reload();
  assert.equal(ui.button('核算记录').props['aria-current'], 'page', 'reload must restore the last page');
  assert.equal(ui.button('货代报价').props['aria-current'], undefined);
});

test('freight form splits origin/destination and swaps container type for inquiry quantity by mode', async t => {
  const ui = await mount(t);
  await ui.click('货代报价');
  assert.ok(ui.field('起运地'));
  assert.ok(ui.field('目的地'));
  assert.equal(ui.field('柜型').props.value, '20GP');
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '询价数量').length, 0);
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '询价单位').length, 0);
  await ui.change('货代名称', 'AgentA');
  await ui.change('起运地', 'Shanghai');
  await ui.change('目的地', 'Hamburg');
  await ui.change('柜型', '40HQ');
  await ui.change('有效期', '2026-12-01');
  await ui.change('国际运费 USD/票', 1000);
  await ui.change('国内费用 RMB/票', 500);
  await ui.click('保存货代报价');
  const fcl = ui.memory.freights.find(row => row.agent === 'AgentA');
  assert.deepEqual(
    { origin: fcl.origin, destination: fcl.destination, transportMode: fcl.transportMode, containerType: fcl.containerType, sea: fcl.sea, local: fcl.local },
    { origin: 'Shanghai', destination: 'Hamburg', transportMode: '海运整柜', containerType: '40HQ', sea: 1000, local: 500 });
  assert.equal(fcl.route, undefined);
  assert.equal(fcl.basis, undefined);
  assert.equal(fcl.quantity, undefined);
  const fclText = text(one(all(ui.tree, n => n.type === 'article' && text(n).includes('AgentA')), 'freight record'));
  assert.match(fclText, /起运地：Shanghai/);
  assert.match(fclText, /目的地：Hamburg/);
  assert.match(fclText, /柜型：40HQ/);
  await ui.change('运输方式', '海运拼箱');
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '柜型').length, 0);
  assert.equal(ui.field('询价单位').props.value, '公斤', 'LCL inquiry unit defaults to weight');
  assert.equal(ui.field('是否抛货').props.value, '否');
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '体积（CBM）').length, 0);
  await ui.change('是否抛货', '是');
  assert.ok(ui.field('体积（CBM）'));
  await ui.change('货代名称', 'AgentB');
  await ui.change('起运地', 'Ningbo');
  await ui.change('目的地', 'LosAngeles');
  await ui.change('询价数量', 2.5);
  await ui.change('体积（CBM）', 3);
  await ui.change('有效期', '2026-12-02');
  await ui.change('国际运费 USD/票', 300);
  await ui.change('国内费用 RMB/票', 200);
  await ui.click('保存货代报价');
  const lcl = ui.memory.freights.find(row => row.agent === 'AgentB');
  assert.equal(lcl.transportMode, '海运拼箱');
  assert.equal(lcl.quantity, 2.5);
  assert.equal(lcl.quantityUnit, '公斤');
  assert.equal(lcl.bulky, '是');
  assert.equal(lcl.volume, 3);
  assert.equal(lcl.containerType, undefined);
  assert.equal(lcl.route, undefined);
  const lclText = text(one(all(ui.tree, n => n.type === 'article' && text(n).includes('AgentB')), 'freight record'));
  assert.match(lclText, /起运地：Ningbo/);
  assert.match(lclText, /目的地：LosAngeles/);
  assert.match(lclText, /询价：2\.5 公斤 · 抛货 3 CBM/);
  await ui.change('运输方式', '空运');
  assert.equal(ui.field('询价单位').props.value, '公斤');
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '柜型').length, 0);
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '是否抛货').length, 0);
  assert.equal(all(ui.tree, n => n.type === 'label' && text(n) === '体积（CBM）').length, 0);
});

test('legacy freight records still display a split route and their original basis', async t => {
  const legacy = { id: 'legacy', agent: '旧货代', route: '上海 → 汉堡', transportMode: '海运整柜', basis: '20GP / 全包', valid: '2026-12-01', sea: 1000, local: 500 };
  const ui = await mount(t, { freights: [legacy] });
  await ui.click('货代报价');
  const row = text(one(all(ui.tree, n => n.type === 'article' && text(n).includes('旧货代')), 'legacy freight'));
  assert.match(row, /起运地：上海/);
  assert.match(row, /目的地：汉堡/);
  assert.match(row, /柜型：20GP \/ 全包/);
});

test('factory quote stores and displays purity, quality and cargo hazard', async t => {
  const ui = await mount(t);
  await ui.click('工厂报价');
  await ui.change('产品', 'TestProduct');
  await ui.change('含量 / 纯度', '99.5%');
  await ui.change('其他关键质量指标', '水分≤0.5%；重金属≤10ppm');
  await ui.change('货物危险性', 'Class 3 UN1993');
  await ui.change('报价单价', 100);
  await ui.change('币种', 'RMB');
  await ui.change('计价单位', '公斤');
  await ui.change('退税率 %（不退税填 0）', 13);
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories[0].purity, '99.5%');
  assert.equal(ui.memory.factories[0].quality, '水分≤0.5%；重金属≤10ppm');
  assert.equal(ui.memory.factories[0].hazard, 'Class 3 UN1993');
  const row = text(ui.article('TestProduct'));
  assert.match(row, /含量 \/ 纯度：99\.5%/);
  assert.match(row, /其他关键质量指标：水分≤0\.5%；重金属≤10ppm/);
  assert.match(row, /货物危险性：Class 3 UN1993/);
  await ui.click('编辑', ui.article('TestProduct'));
  assert.equal(ui.field('含量 / 纯度').props.value, '99.5%');
  assert.equal(ui.field('其他关键质量指标').props.value, '水分≤0.5%；重金属≤10ppm');
  assert.equal(ui.field('货物危险性').props.value, 'Class 3 UN1993');
});

test('calculation product search ranks name matches and only applies a recommendation when chosen', async t => {
  const ui = await mount(t, { products: [
    { name: 'Propylene Glycol', cas: '57-55-6', tax: 13, rebate: 9 },
    { name: 'Propylene Glycol USP', cas: '25322-69-4' },
    { name: 'Ethylene Glycol', cas: '107-21-1' },
  ] });
  await ui.click('报价核算');
  const field = () => ui.field('产品 / 规格');
  const options = () => all(ui.tree, n => n.props.role === 'option' && n.props.id?.startsWith('qw-product-suggestion-'));
  const key = async value => {
    field().props.onKeyDown({ key: value, preventDefault() {}, stopPropagation() {} });
    await ui.flush();
  };
  await ui.change('产品 / 规格', 'Ｇｌｙｃｏｌ');
  assert.equal(options().length, 3, 'search normalizes width and matches inside a name');
  await ui.change('产品 / 规格', 'propylene glycol');
  assert.match(text(options()[0]), /CAS 57-55-6/);
  await ui.change('产品 / 规格', 'Propylene Gylcol');
  assert.equal(options().length, 1);
  assert.match(text(options()[0]), /CAS 57-55-6 · 相似/);
  await key('Enter');
  assert.equal(ui.field('CAS 号').props.value, '');
  await key('ArrowDown');
  assert.equal(field().props['aria-activedescendant'], options()[0].props.id);
  await key('Enter');
  assert.equal(field().props.value, 'Propylene Glycol');
  assert.equal(ui.field('CAS 号').props.value, '57-55-6');
  assert.equal(ui.field('退税率 %').props.value, 9);
  await ui.change('含税采购单价 RMB/kg', '14');
  await ui.change('产品 / 规格', 'Ethylene');
  assert.equal(ui.field('CAS 号').props.value, '57-55-6');
  options()[0].props.onClick(); await ui.flush();
  assert.equal(ui.field('CAS 号').props.value, '107-21-1');
  assert.equal(ui.field('含税采购单价 RMB/kg').props.value, '');
  assert.equal(ui.field('退税率 %').props.value, '');
  await ui.click('自有工厂倒推');
  await ui.change('产品 / 规格', 'Custom New Product');
  assert.equal(options().length, 0);
  assert.match(text(ui.tree), /可继续手动输入/);
  await key('Escape');
  assert.equal(field().props.value, 'Custom New Product');
  assert.equal(field().props['aria-expanded'], false);
});

test('quote country combobox opens and lists matching countries while typing', async t => {
  const ui = await mount(t);
  await ui.click('报价核算');
  const field = () => ui.field('报价国家 / 地区');
  const countries = () => all(ui.tree, n => typeof n.props.className === 'string' && n.props.className.startsWith('qw-country-option')).map(text);
  assert.equal(field().props.value, '');
  field().props.onFocus({ target: { select() {} } });
  await ui.flush();
  assert.ok(countries().length > 100, 'focus opens the country list without clicking a select');
  await ui.change('报价国家 / 地区', '美国');
  assert.equal(countries().length, 1);
  assert.ok(countries()[0].includes('USA') && countries()[0].includes('美国'));
  await ui.change('报价国家 / 地区', 'united');
  assert.ok(countries().some(value => value.includes('USA')));
  assert.ok(countries().some(value => value.includes('GBR')));
  await ui.change('报价国家 / 地区', 'gbr');
  assert.equal(countries().length, 1);
  assert.ok(countries()[0].includes('GBR'));
  await ui.change('报价国家 / 地区', 'zzzz');
  assert.deepEqual(countries(), []);
  await ui.change('报价国家 / 地区', '日本');
  assert.equal(countries().length, 1);
  const option = all(ui.tree, n => typeof n.props.className === 'string' && n.props.className.startsWith('qw-country-option'))[0];
  option.props.onMouseDown({ preventDefault() {}, stopPropagation() {} });
  await ui.flush();
  assert.ok(field().props.value.includes('日本'));
  assert.ok(field().props.value.includes('JPN'));
});

test('editing a saved factory uses update and revision, preserves legacy dates/raw and does not append', async t => {
  const original = factory('existing', { validity: '报价后一周', quoteDate: '2026/11/01', raw: '原始报价明细', details: '报价详细说明' });
  const ui = await mount(t, { factories: [original] });
  await ui.click('编辑', ui.article(original.name));
  assert.equal(ui.field('报价日期').props.value, '2026-11-01');
  assert.equal(ui.field('报价有效期').props.value, '');
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, original.raw);
  await ui.change('报价单价', '15000'); await ui.click('覆盖原报价');
  const updates = ui.requests.filter(r => r.action === 'update');
  assert.equal(updates.length, 1); assert.equal(updates[0].id, original.id);
  assert.equal(updates[0].revision, 7); assert.equal(updates[0].kind, 'factories');
  assert.equal(updates[0].record.price, 15000); assert.equal(updates[0].record.validity, original.validity);
  assert.equal(updates[0].record.raw, original.raw);
  assert.equal(ui.requests.some(r => r.action === 'add'), false);
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].createdAt, original.createdAt);
  assert.ok(ui.button('确认并保存报价'));
  assert.match(text(one(all(ui.tree, n => n.props.role === 'status'), 'status')), /已覆盖原报价/);
});

test('editing a saved factory offers save-as-new without overwriting the original', async t => {
  const original = factory('existing', { name: 'OriginalQuote', price: 14000 });
  const ui = await mount(t, { factories: [original] });
  await ui.click('编辑', ui.article('OriginalQuote'));
  assert.ok(ui.button('覆盖原报价'));
  assert.ok(ui.button('另存为新报价'));
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '确认并保存报价').length, 0, 'edit mode offers explicit overwrite or copy instead of one save button');
  await ui.change('产品', 'CopiedQuote');
  await ui.change('报价单价', '15500');
  await ui.click('另存为新报价');
  assert.equal(ui.requests.filter(r => r.action === 'update').length, 0, 'save-as-new must not overwrite the original');
  const add = one(ui.requests.filter(r => r.action === 'add'), 'add request');
  assert.equal(add.kind, 'factories');
  assert.equal(add.record.name, 'CopiedQuote');
  assert.equal(add.record.price, 15500);
  assert.equal(ui.memory.factories.length, 2);
  const kept = ui.memory.factories.find(row => row.id === original.id);
  assert.equal(kept.name, 'OriginalQuote');
  assert.equal(kept.price, 14000);
  assert.equal(ui.field('产品').props.value, '', 'the editor resets after saving a copy');
  assert.ok(ui.button('确认并保存报价'));
  assert.match(text(one(all(ui.tree, n => n.props.role === 'status'), 'status')), /已另存为新的报价/);
});

test('factory row copy opens a new draft and preserves legacy dates and raw text', async t => {
  const original = factory('existing', { quoteDate: 'November 2026', validity: '报价后一周', raw: '原始报价' });
  const ui = await mount(t, { factories: [original] });
  await ui.click('编辑', ui.article(original.name));
  await ui.click('复制', ui.article(original.name));
  assert.match(text(ui.tree), /已复制到新报价草稿/);
  assert.equal(ui.memory.revision, 7);
  assert.equal(ui.field('产品').props.value, original.name);
  assert.equal(ui.field('原始报价 / Excel 表格').props.value, original.raw);
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '覆盖原报价').length, 0);
  await ui.remount();
  assert.equal(ui.field('报价日期').props.value, '');
  await ui.change('报价单价', 15500);
  await ui.click('确认并保存报价');
  assert.equal(ui.requests.some(r => r.action === 'update'), false);
  const { record } = one(ui.requests.filter(r => r.action === 'add'), 'factory copy add');
  assert.equal(record.id, undefined);
  assert.equal(record.createdAt, undefined);
  assert.equal(record.quoteDate, original.quoteDate);
  assert.equal(record.validity, original.validity);
  assert.equal(record.raw, original.raw);
  assert.equal(record.price, 15500);
  assert.deepEqual(ui.memory.factories[0], original);
});

test('factory quote defaults to today and an AI period becomes quote date plus that period', async t => {
  const today = localDate();
  const parsed = { records: [{ name: 'AIQuote', price: 1200, currency: 'RMB', unit: '吨', rebate: 0, validity: '30 days' }], model: 'test-model' };
  const ui = await mount(t, {}, [parsed]);
  await ui.click('工厂报价');
  assert.equal(ui.field('报价日期').props.value, today, 'a new quote starts on today and stays editable');
  await ui.change('原始报价 / Excel 表格', 'RMB 1200/ton, validity 30 days');
  await ui.click('AI 提取字段');
  assert.equal(ui.field('报价日期').props.value, today, 'a missing quote date keeps the default');
  assert.equal(ui.field('报价有效期').props.value, addDays(today, 30));
  assert.ok(all(ui.tree, n => n.type === 'p' && text(n).includes(`+ 30 天计算并填入 ${addDays(today, 30)}`)), 'the computed validity explains its formula');
  await ui.change('报价日期', '2026-11-17');
  assert.equal(ui.field('报价有效期').props.value, '2026-12-17', 'changing the quote date moves the derived validity');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories[0].quoteDate, '2026-11-17');
  assert.equal(ui.memory.factories[0].validity, '2026-12-17');
  assert.equal(ui.field('报价日期').props.value, today, 'the next blank quote defaults to today again');
});

test('editing the validity directly stops it from following the quote date', async t => {
  const parsed = { records: [{ name: 'ManualValidity', price: 1200, currency: 'RMB', unit: '吨', rebate: 0, quoteDate: '2026/11/17', validity: 'two weeks' }], model: 'test-model' };
  const ui = await mount(t, {}, [parsed]);
  await ui.click('工厂报价');
  await ui.change('原始报价 / Excel 表格', 'valid two weeks');
  await ui.click('AI 提取字段');
  assert.equal(ui.field('报价日期').props.value, '2026-11-17');
  assert.equal(ui.field('报价有效期').props.value, '2026-12-01');
  await ui.change('报价有效期', '2027-01-15');
  await ui.change('报价日期', '2026-12-20');
  assert.equal(ui.field('报价有效期').props.value, '2027-01-15', 'a manual validity is never overwritten');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories[0].quoteDate, '2026-12-20');
  assert.equal(ui.memory.factories[0].validity, '2027-01-15');
});

test('rule extraction converts a validity period column from the quote date', async t => {
  const ui = await mount(t);
  await ui.click('工厂报价');
  await ui.change('原始报价 / Excel 表格', '产品\t报价明细\t报价日期\t报价有效期\nProdA\tUSD 20/kg\t2026/11/17\t30 days');
  await ui.click('规则提取');
  assert.equal(ui.field('报价日期').props.value, '2026-11-17');
  assert.equal(ui.field('报价有效期').props.value, '2026-12-17');
});

test('cancel editing causes no mutation; stale revision shows error and retains editable values', async t => {
  const ui = await mount(t, { factories: [factory('existing')] });
  await ui.click('编辑', ui.article('Quote existing')); await ui.change('报价单价', '16000');
  await ui.click('取消编辑');
  assert.equal(ui.requests.filter(r => ['update', 'add', 'delete'].includes(r.action)).length, 0);
  await ui.click('编辑', ui.article('Quote existing')); await ui.change('报价单价', '17000');
  ui.memory.revision++; // Another client changes the server snapshot, in memory only.
  await ui.click('覆盖原报价');
  assert.equal(ui.memory.factories[0].price, 14000);
  assert.equal(ui.field('报价单价').props.value, 17000);
  assert.equal(text(one(all(ui.tree, n => n.props.role === 'alert'), 'conflict alert')), '记录已更新，请刷新后重试。');
  assert.ok(ui.button('覆盖原报价'));
  assert.ok(ui.button('另存为新报价'));
});

test('catalog save/search and bring-in drive both forms; CAS autofill clears only generated names', async t => {
  const ui = await mount(t);
  await ui.click('产品目录');
  await ui.change('产品名称', 'DMSO'); await ui.change('CAS 号', ' 67 – 68 – 5 ');
  await ui.click('保存产品');
  assert.equal(ui.memory.products[0].cas, '67-68-5');
  assert.equal(ui.requests.find(r => r.kind === 'products').revision, 7);
  await ui.change('搜索产品名称或 CAS', '67-68-5');
  await ui.click('带入核算', ui.article('DMSO'));
  assert.equal(ui.field('产品 / 规格').props.value, 'DMSO');
  assert.equal(ui.field('CAS 号').props.value, '67-68-5');
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('产品 / 规格').props.value, '');
  await ui.change('产品 / 规格', '手填规格'); await ui.change('CAS 号', '75-07-0');
  assert.equal(ui.field('产品 / 规格').props.value, '手填规格');
  await ui.change('CAS 号', ' 67–68–5 ');
  assert.equal(ui.field('产品 / 规格').props.value, 'DMSO');
  await ui.click('产品目录'); await ui.click('带入工厂', ui.article('DMSO'));
  assert.equal(ui.field('产品').props.value, 'DMSO');
  await ui.change('CAS 号', '64-17-5'); assert.equal(ui.field('产品').props.value, '');
  await ui.change('产品', '工厂手填规格'); await ui.change('CAS 号', '75-07-0');
  assert.equal(ui.field('产品').props.value, '工厂手填规格');
});

test('catalog includes saved quote products and prevents duplicate normalized CAS without writes', async t => {
  const ui = await mount(t, { factories: [factory('derived', { name: 'CatalogProduct' })] });
  await ui.click('产品目录');
  const derived = ui.article('CatalogProduct');
  assert.equal(all(derived, n => n.type === 'button' && text(n) === '删除').length, 0);
  await ui.change('产品名称', '重复产品'); await ui.change('CAS 号', '67 – 68 – 5'); await ui.click('保存产品');
  assert.equal(ui.requests.filter(r => r.action === 'add').length, 0);
  assert.ok(all(ui.tree, n => n.props.role === 'alert').length);
  await ui.change('搜索产品名称或 CAS', '不匹配');
  assert.equal(all(ui.tree, n => n.type === 'article').length, 0);
});

test('editing a catalog product updates name, CAS and rate overrides', async t => {
  const ui = await mount(t, { products: [{ id: 'manual', name: 'OldProduct', cas: '67-68-5' }] });
  await ui.click('产品目录');
  await ui.click('编辑', ui.article('OldProduct'));
  assert.equal(ui.field('产品名称').props.value, 'OldProduct');
  assert.equal(ui.field('CAS 号').props.value, '67-68-5');
  assert.equal(ui.field('增值税率 %').props.value, '');
  assert.equal(ui.field('退税率 %').props.value, '');
  await ui.change('产品名称', 'NewProduct');
  await ui.change('增值税率 %', 9);
  await ui.change('退税率 %', 4);
  await ui.click('保存修改');
  const update = ui.requests.find(r => r.action === 'update' && r.kind === 'products');
  assert.equal(update.id, 'manual');
  assert.equal(update.revision, 7);
  assert.equal(ui.memory.products[0].name, 'NewProduct');
  assert.equal(ui.memory.products[0].tax, 9);
  assert.equal(ui.memory.products[0].rebate, 4);
  assert.equal(ui.field('产品名称').props.value, '');
  assert.equal(ui.field('增值税率 %').props.value, '');
});

test('manual catalog product stores cargo hazard and the factory form autofills it by CAS', async t => {
  const ui = await mount(t);
  await ui.click('产品目录');
  await ui.change('产品名称', 'DMSO'); await ui.change('CAS 号', '67-68-5');
  await ui.change('货物危险性', ' Class 9 UN3082 ');
  await ui.click('保存产品');
  assert.equal(ui.memory.products[0].hazard, 'Class 9 UN3082');
  assert.match(text(ui.article('DMSO')), /货物危险性 Class 9 UN3082/);
  await ui.click('编辑', ui.article('DMSO'));
  assert.equal(ui.field('货物危险性').props.value, 'Class 9 UN3082');
  await ui.change('货物危险性', 'Class 8 UN1814');
  await ui.click('保存修改');
  assert.equal(ui.memory.products[0].hazard, 'Class 8 UN1814');
  await ui.click('编辑', ui.article('DMSO'));
  await ui.change('货物危险性', '');
  await ui.click('保存修改');
  assert.equal(ui.requests.filter(row => row.action === 'update' && row.kind === 'products').at(-1).record.hazard, '', 'clearing the field sends the empty value that removes the catalog override');
  assert.equal(ui.memory.products[0].hazard, '');
  await ui.click('工厂报价');
  await ui.change('CAS 号', ' 67 – 68 – 5 ');
  assert.equal(ui.field('货物危险性').props.value, '');
  await ui.change('货物危险性', 'Class 8 UN1814');
  assert.equal(ui.field('货物危险性').props.value, 'Class 8 UN1814');
});

test('bringing a catalog product into a factory quote carries its cargo hazard', async t => {
  const ui = await mount(t, { factories: [factory('derived', { name: 'CatalogProduct', hazard: 'Class 3 UN1993' })] });
  await ui.click('产品目录');
  assert.match(text(ui.article('CatalogProduct')), /货物危险性 Class 3 UN1993/);
  await ui.click('带入工厂', ui.article('CatalogProduct'));
  assert.equal(ui.field('产品').props.value, 'CatalogProduct');
  assert.equal(ui.field('货物危险性').props.value, 'Class 3 UN1993');
  await ui.change('CAS 号', '64-17-5');
  assert.equal(ui.field('货物危险性').props.value, '', 'a CAS without a catalog hazard clears the generated one');
  await ui.change('货物危险性', 'Class 8 UN1814');
  await ui.change('CAS 号', '7732-18-5');
  assert.equal(ui.field('货物危险性').props.value, 'Class 8 UN1814', 'a manually entered hazard is not cleared');
  await ui.change('CAS 号', '67 – 68 – 5');
  assert.equal(ui.field('货物危险性').props.value, 'Class 3 UN1993', 'a catalog CAS replaces it with the catalog hazard');
});

test('editing a quote-derived product stores a manual override and locks CAS', async t => {
  const ui = await mount(t, { factories: [factory('derived', { name: 'CatalogProduct' })] });
  await ui.click('产品目录');
  await ui.click('编辑', ui.article('CatalogProduct'));
  assert.equal(ui.field('CAS 号').props.disabled, true);
  assert.equal(ui.field('增值税率 %').props.value, '');
  await ui.change('产品名称', 'CatalogOverride');
  await ui.change('增值税率 %', 10);
  await ui.click('保存修改');
  const add = ui.requests.find(r => r.action === 'add' && r.kind === 'products');
  assert.equal(add.override, true);
  assert.equal(add.record.name, 'CatalogOverride');
  assert.equal(add.record.cas, '67-68-5');
  assert.equal(ui.memory.products[0].name, 'CatalogOverride');
  assert.ok(ui.article('CatalogOverride'));
  assert.equal(all(ui.article('CatalogOverride'), n => n.type === 'button' && text(n) === '删除').length, 1);
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
  await ui.change('产品', 'ManualQuote'); await ui.change('报价单价', '20');
  await ui.change('计价单位', '公斤'); await ui.change('退税率 %（不退税填 0）', '0');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 1);
  assert.equal(ui.memory.factories[0].name, 'ManualQuote');
  assert.equal(ui.memory.factories[0].raw, '无法识别的第二批内容');
  assert.equal(ui.field('产品').props.value, '');
});

test('class/UN hazard formats are extracted into the factory form by rule parsing', async t => {
  const ui = await mount(t);
  await ui.change('原始报价 / Excel 表格', 'DPG class 9 UN3082 USD 20/kg FOB 青岛');
  await ui.click('规则提取');
  assert.equal(ui.field('货物危险性').props.value, 'class 9 UN3082');
  await ui.change('原始报价 / Excel 表格', 'DCP class 3 USD 21/kg FOB 上海');
  await ui.click('规则提取');
  assert.equal(ui.field('货物危险性').props.value, 'class 3');
  await ui.change('原始报价 / Excel 表格', 'DMSO UN 1993 USD 22/kg FOB 宁波');
  await ui.click('规则提取');
  assert.equal(ui.field('货物危险性').props.value, 'UN 1993');
});

test('rule extraction advances multiple TSV records one save at a time with per-row raw and current revision', async t => {
  const ui = await mount(t, { factories: [factory('existing')] });
  await ui.click('编辑', ui.article('Quote existing'));
  const firstDetails = 'USD 1390/吨 FOB Qingdao';
  const secondDetails = 'USD 2.5/kg FCA Shanghai';
  const raw = `产品\tCAS 号\t报价明细\t报价日期\t报价有效期\t含量 / 纯度\t其他关键质量指标\t货物危险性\nProdA\t67-68-5\t${firstDetails}\t2026/11/01\t2026/12/01\t99.5%\t水分≤0.5%\tClass 3 UN1993\nProdB\t64-17-5\t${secondDetails}\t2026/11/02\t2026/12/02\t98%\t外观：白色粉末\tNonHazardous`;
  await ui.change('原始报价 / Excel 表格', raw); await ui.click('规则提取');
  assert.equal(ui.requests.filter(r => r.action === 'parse').length, 0, 'rule extraction must stay local');
  assert.equal(ui.field('产品').props.value, 'ProdA');
  assert.equal(ui.field('报价单价').props.value, 1390);
  assert.equal(ui.field('报价日期').props.value, '2026-11-01');
  assert.equal(ui.field('含量 / 纯度').props.value, '99.5%');
  assert.equal(ui.field('其他关键质量指标').props.value, '水分≤0.5%');
  assert.equal(ui.field('货物危险性').props.value, 'Class 3 UN1993');
  await ui.click('确认并保存报价');
  assert.equal(ui.memory.factories.length, 2);
  assert.equal(ui.field('产品').props.value, 'ProdB');
  assert.equal(ui.field('CAS 号').props.value, '64-17-5');
  assert.equal(ui.field('报价单价').props.value, 2.5);
  assert.equal(ui.field('计价单位').props.value, '公斤');
  assert.equal(ui.field('报价有效期').props.value, '2026-12-02');
  assert.equal(ui.field('含量 / 纯度').props.value, '98%');
  assert.equal(ui.field('其他关键质量指标').props.value, '外观：白色粉末');
  assert.equal(ui.field('货物危险性').props.value, 'NonHazardous');
  await ui.click('确认并保存报价');
  const saves = ui.requests.filter(r => r.action === 'add');
  assert.deepEqual(saves.map(r => r.revision), [7, 8]);
  assert.deepEqual(saves.map(r => r.record.name), ['ProdA', 'ProdB']);
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
  assert.match(text(rangeRow), /C&F 成本 USD\/kg: .* ～ /);
  await ui.click('编辑', rangeRow);
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 300);
  assert.equal(ui.field('退税率 %').props.value, 13);
  assert.equal(ui.field('Incoterm').props.value, '待确认');
  await ui.click('核算记录'); await ui.click('编辑', ui.article('旧单值记录'));
  assert.equal(ui.field('最高国际运费 USD/票').props.value, 100);
  assert.equal(ui.field('最低国际运费 USD/票').props.value, 100);
  assert.equal(ui.button('另存为新记录').props.disabled, false);
  assert.equal(ui.button('覆盖原记录').props.disabled, false);
  assert.equal(ui.memory.history[0].values.rebate, undefined, 'view/copy must not mutate stored history');
  assert.equal(ui.memory.history[1].values.seaMax, undefined);
});

test('history edit can overwrite the original record or save as a new record', async t => {
  const values = { product: 'EditableRecord', cas: '67-68-5', qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7,
    sea: 100, seaMax: 300, local: 0, tax: 13, transport: 0, credit: 0, interest: 0, months: 0 };
  const result = { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, { history: [{ id: 'original', mode: 'rmb', date: '2026-11-01T00:00:00Z', values, result }] });
  await ui.click('核算记录');
  await ui.click('编辑', ui.article('EditableRecord'));
  assert.ok(ui.button('另存为新记录'));
  assert.ok(ui.button('覆盖原记录'));
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '保存本次核算').length, 0);
  await ui.change('对客单价 USD/kg', 6);
  await ui.click('覆盖原记录');
  const update = ui.requests.find(r => r.action === 'update' && r.kind === 'history');
  assert.equal(update.id, 'original');
  assert.equal(update.revision, 7);
  assert.equal(update.record.values.sell, 6);
  assert.equal(ui.memory.history.length, 1);
  assert.equal(ui.memory.history[0].values.sell, 6);
  assert.match(text(ui.tree), /已覆盖原核算记录，核算页面已清空/);
  assert.equal(ui.field('产品 / 规格').props.value, '');
  assert.equal(ui.field('对客单价 USD/kg').props.value, '');
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '另存为新记录').length, 0);
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '覆盖原记录').length, 0);
  assert.equal(ui.button('保存本次核算').props.disabled, true);

  await ui.click('核算记录');
  await ui.click('编辑', ui.article('EditableRecord'));
  await ui.change('对客单价 USD/kg', 7);
  await ui.click('另存为新记录');
  const add = ui.requests.find(r => r.action === 'add' && r.kind === 'history');
  assert.equal(add.record.values.sell, 7);
  assert.equal(ui.memory.history.length, 2);
  assert.equal(ui.memory.history.at(-1).values.sell, 7);
  assert.match(text(ui.tree), /已另存为新的核算记录，核算页面已清空/);
  assert.equal(ui.field('产品 / 规格').props.value, '');
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '保存本次核算').length, 1);
});

test('history row copy clears the edit target and preserves the factory and calculation inputs', async t => {
  const source = factory('source', { cas: '67-68-5' });
  const values = { product: 'Original', cas: source.cas, customerTerm: 'CFR', qty: 1000, sell: 5, buy: 14, fx: 7,
    sea: 100, seaMax: 300, local: 0, tax: 13, rebate: 13, transport: 0, credit: 0, interest: 0, months: 2, creditMonths: 3 };
  const result = { base: 2, landed: 2.1, profit: 1000, margin: .1, rmb: 7000, insurance: 0, credit: 0, interest: 0 };
  const original = { id: 'original', mode: 'rmb', date: '2026-11-01T00:00:00Z', factoryId: source.id, values, result };
  const ui = await mount(t, { factories: [source], history: [original] });
  await ui.click('核算记录');
  await ui.click('编辑', ui.article('Original'));
  await ui.click('核算记录');
  await ui.click('复制', ui.article('Original'));
  assert.match(text(ui.tree), /已复制到新核算草稿/);
  assert.equal(ui.memory.revision, 7);
  assert.equal(all(ui.tree, n => n.type === 'button' && text(n) === '覆盖原记录').length, 0);
  await ui.change('对客单价 USD/kg', 6);
  await ui.click('保存本次核算');
  assert.equal(ui.requests.some(r => r.action === 'update'), false);
  const { record } = one(ui.requests.filter(r => r.action === 'add'), 'history copy add');
  assert.equal(record.factoryId, source.id);
  assert.equal(record.values.seaMax, values.seaMax);
  assert.equal(record.values.months, values.months);
  assert.equal(record.values.customerTerm, values.customerTerm);
  assert.equal(record.values.sell, 6);
  assert.deepEqual(ui.memory.history[0], original);
});

test('history page filters by CAS and customer keywords without touching stored records', async t => {
  const values = { qty: 1000, sell: 5, buy: 14, fx: 7, receive: 7, sea: 100, seaMax: 300, local: 0,
    tax: 13, transport: 0, credit: 0, interest: 0, months: 0, customerTerm: 'CFR' };
  const result = { base: 1, landed: 1, profit: 1, margin: 1, rmb: 1, insurance: 0, credit: 0, interest: 0 };
  const ui = await mount(t, { history: [
    { id: 'stim', mode: 'rmb', date: '2026-11-01T00:00:00Z', values: { ...values, product: 'DPG', cas: '67-68-5', customer: 'STIM' }, result },
    { id: 'king', mode: 'rmb', date: '2026-11-02T00:00:00Z', values: { ...values, product: 'DCP', cas: '64-17-5', customer: 'Kingchem' }, result },
  ] });
  const before = JSON.stringify(ui.memory.history);
  await ui.click('核算记录');
  const shown = () => all(ui.tree, n => n.type === 'article').map(text);
  const page = () => text(one(all(ui.tree, n => n.props.className === 'qw-body qw-single'), 'history body'));

  assert.equal(shown().length, 2);
  assert.match(text(ui.article('DPG')), /客户 STIM/);
  assert.equal(all(ui.tree, n => text(n) === '清除筛选').length, 0, 'the clear button only appears while filtering');
  assert.match(page(), /共 2 条记录/);

  await ui.change('按 CAS 筛选核算记录', '67-68');
  assert.equal(shown().length, 1);
  assert.ok(ui.article('DPG'));
  assert.match(page(), /显示 1 \/ 2 条记录/);
  await ui.change('按 CAS 筛选核算记录', '67685');
  assert.equal(shown().length, 1, 'CAS keywords ignore separators');
  await ui.change('按 CAS 筛选核算记录', '64-17');
  assert.equal(shown().length, 1);
  assert.ok(ui.article('DCP'));

  await ui.change('按客户名称筛选核算记录', 'stim');
  assert.equal(shown().length, 0, 'CAS and customer filters combine');
  assert.match(page(), /没有符合 CAS 或客户名称关键词的核算记录/);
  await ui.change('按 CAS 筛选核算记录', '');
  assert.equal(shown().length, 1);
  assert.ok(ui.article('DPG'));
  await ui.change('按客户名称筛选核算记录', 'CHEM');
  assert.equal(shown().length, 1);
  assert.ok(ui.article('DCP'));
  await ui.change('按客户名称筛选核算记录', 'zzz');
  assert.equal(shown().length, 0);

  await ui.click('清除筛选');
  assert.equal(shown().length, 2);
  assert.equal(ui.field('按 CAS 筛选核算记录').props.value, '');
  assert.equal(ui.field('按客户名称筛选核算记录').props.value, '');

  await ui.change('按客户名称筛选核算记录', 'stim');
  await ui.click('工厂报价');
  await ui.click('核算记录');
  assert.equal(ui.field('按客户名称筛选核算记录').props.value, 'stim', 'filters survive page switches');
  assert.equal(shown().length, 1);
  await ui.click('编辑', ui.article('DPG'));
  assert.equal(ui.field('客户').props.value, 'STIM');
  assert.equal(JSON.stringify(ui.memory.history), before, 'filtering and copying must not mutate saved records');
  assert.equal(ui.requests.filter(r => ['add', 'update', 'delete', 'import'].includes(r.action)).length, 0);
});

test('zoom controls scale the panel within limits and reset without touching records', async t => {
  const ui = await mount(t);
  const root = () => one(all(ui.tree, n => n.props.className === 'qw-root'), 'qw-root');
  assert.equal(root().props.style.zoom, '1');
  await ui.click('A+');
  assert.equal(root().props.style.zoom, '1.1');
  assert.ok(ui.button('110%'));
  await ui.click('A−');
  assert.equal(root().props.style.zoom, '1');
  await ui.click('A−'); await ui.click('A−'); await ui.click('A−');
  assert.equal(root().props.style.zoom, '0.75');
  assert.equal(ui.button('A−').props.disabled, true);
  await ui.click('75%');
  assert.equal(root().props.style.zoom, '1');
  for (let i = 0; i < 8; i++) if (!ui.button('A+').props.disabled) await ui.click('A+');
  assert.equal(root().props.style.zoom, '1.5');
  assert.equal(ui.button('A+').props.disabled, true);
  assert.equal(ui.requests.filter(r => ['add', 'update', 'delete', 'import'].includes(r.action)).length, 0);
});
