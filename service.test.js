import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteWorkbench, sanitizeQuoteRecords } from './service.js';
import { defaults, samples } from './domain.js';
function fixture(initial = {}) {
  let data = { revision: 0, factories: [], freights: [], history: [], ...initial };
  return new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } });
}
const quote = { name: 'DPG', price: 14000, currency: 'RMB', unit: '吨', rebate: 13 };
test('writes persist, delete by stable id, and reject stale concurrent updates', async () => {
  const service = fixture();
  const results = await Promise.allSettled([service.execute({ action: 'add', kind: 'factories', record: quote, revision: 0 }), service.execute({ action: 'add', kind: 'factories', record: quote, revision: 0 })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  const db = await service.execute({ action: 'list' }); assert.equal(db.factories.length, 1); assert.equal(db.revision, 1);
  const next = await service.execute({ action: 'delete', kind: 'factories', id: db.factories[0].id, revision: 1 }); assert.equal(next.factories.length, 0);
});
test('failed import keeps existing data and valid legacy import receives fresh identifiers', async () => {
  const service = fixture();
  await service.execute({ action: 'add', kind: 'factories', record: quote, revision: 0 });
  await assert.rejects(service.execute({ action: 'import', revision: 1, data: { factories: [], freights: [{}], history: [] } }));
  assert.equal((await service.execute({ action: 'list' })).factories.length, 1);
  const db = await service.execute({ action: 'import', revision: 1, data: { factories: [quote], freights: [], history: [] } });
  assert.equal(db.revision, 2); assert.ok(db.factories[0].id);
});
test('saved history is recomputed and read-only actions do not change revision', async () => {
  const service = fixture();
  const values = { ...defaults, ...samples.rmb, seaMax: 6000 };
  const preview = await service.execute({ action: 'calculate', mode: 'rmb', values });
  const db = await service.execute({ action: 'add', kind: 'history', revision: 0, record: { mode: 'rmb', values, result: { profit: 1e9 } } });
  assert.deepEqual(db.history[0].result, preview.result); assert.deepEqual(db.history[0].highFreightResult, preview.highFreightResult);
  const usdValues = { ...defaults, ...samples.usd, seaMax: 3500, credit: 0.441 };
  const usdPreview = await service.execute({ action: 'calculate', mode: 'usd', values: usdValues });
  assert.ok(usdPreview.highFreightResult);
  const next = await service.execute({ action: 'add', kind: 'history', revision: 1, record: { mode: 'usd', values: usdValues } });
  assert.deepEqual(next.history[0].result, usdPreview.result); assert.deepEqual(next.history[0].highFreightResult, usdPreview.highFreightResult);
  const ownValues = { ...defaults, ...samples.own, seaMax: 300 };
  const ownPreview = await service.execute({ action: 'calculate', mode: 'own', values: ownValues });
  assert.ok(ownPreview.highFreightResult, 'own-factory reverse mode keeps a max-freight result');
  const ownNext = await service.execute({ action: 'add', kind: 'history', revision: 2, record: { mode: 'own', values: ownValues } });
  assert.deepEqual(ownNext.history[0].result, ownPreview.result);
  assert.deepEqual(ownNext.history[0].highFreightResult, ownPreview.highFreightResult);
  const original = ownNext.history[0];
  const edited = await service.execute({ action: 'update', kind: 'history', id: original.id, revision: 3, record: { mode: 'own', values: { ...ownValues, sell: ownValues.sell + 1 } } });
  assert.equal(edited.history[0].id, original.id);
  assert.equal(edited.history[0].values.sell, ownValues.sell + 1);
  assert.equal(edited.history[0].date, original.date);
  assert.notDeepEqual(edited.history[0].result, original.result);
  assert.equal(edited.revision, 4);
  assert.equal((await service.execute({ action: 'export' })).revision, 4);
});
test('persistence failure returns an error without claiming a successful change', async () => {
  const data = { revision: 0, factories: [], freights: [], history: [] };
  const service = new QuoteWorkbench({ get: () => data, set: async () => { throw Error('disk failure'); } });
  await assert.rejects(service.execute({ action: 'add', kind: 'factories', record: quote, revision: 0 }), /disk failure/);
  assert.equal(data.factories.length, 0);
});

function fakeLlm(output, overrides = {}) {
  const provider = overrides.provider ?? 'test-provider';
  const model = overrides.model ?? 'test-model';
  return {
    listProviders: overrides.listProviders ?? (async () => [{ id: provider, name: 'Test provider' }]),
    listModels: overrides.listModels ?? (async () => [{ id: model, name: 'Test model' }]),
    prepareCall: overrides.prepareCall ?? (async () => ({
      config: { provider, model, maxTokens: 2000 },
      stream: async function* () {
        yield { type: 'text-delta', text: output };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    })),
  };
}
function seeded(settings = null) {
  let data = { revision: 0, factories: [], freights: [], history: [], settings };
  return new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, fakeLlm('[]'), () => null);
}
test('parsing uses the configured model and returns sanitized quotes', async () => {
  let data = { revision: 0, factories: [], freights: [], history: [], settings: { provider: 'test-provider', model: 'test-model' } };
  const output = '```json\n[{"name":"DPG","price":"1,390","currency":"usd","unit":"吨","incoterm":"fob","details":"1390美金青岛 22t/20GP"}]\n```';
  const service = new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, fakeLlm(output), () => null);
  const result = await service.execute({ action: 'parse', raw: '1390美金青岛，22t/20GP' });
  assert.equal(result.model, 'test-provider/test-model');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].price, 1390);
  assert.equal(result.records[0].currency, 'USD');
  assert.equal(result.records[0].incoterm, 'FOB');
  assert.equal(result.records[0].raw, '1390美金青岛 22t/20GP');
});
test('parsing without any configured or default model explains where to set it', async () => {
  const service = seeded(null);
  await assert.rejects(service.execute({ action: 'parse', raw: '1390美金青岛' }), /设置 → 报价工作台/);
});
test('saving settings validates the provider and persists the selection', async () => {
  const service = seeded(null);
  const saved = await service.execute({ action: 'saveSettings', revision: 0, settings: { provider: 'test-provider', model: 'test-model' } });
  assert.equal(saved.settings.provider, 'test-provider');
  assert.equal(saved.revision, 1);
  const read = await service.execute({ action: 'settings' });
  assert.equal(read.settings.model, 'test-model');
  assert.equal(read.effective.label, 'test-provider/test-model');
  await assert.rejects(service.execute({ action: 'saveSettings', revision: 1, settings: { provider: 'missing', model: 'm' } }), /提供方当前不可用/);
  await assert.rejects(service.execute({ action: 'saveSettings', revision: 1, settings: { provider: 'test-provider', model: '' } }), /同时选择/);
  const fallback = await service.execute({ action: 'saveSettings', revision: 1, settings: null });
  assert.equal(fallback.settings, null);
});
test('sanitizer drops unknown fields, tolerates summaries and keeps multiple quotes', async () => {
  const records = sanitizeQuoteRecords('说明文字\n[{"name":"A","price":2.5,"unit":"公斤","purity":" 99.5% ","quality":"水分≤0.5%，重金属≤10ppm","hazard":" 3类 UN1993 ","extra":"drop"},{"name":"B","price":null,"rebate":"13","tax":"9"},{"name":"C","price":null,"details":"DPG class 9 UN3082"},{"name":"D","price":null,"details":"DPG class 9 UN3082","hazard":"UN3082"},{"name":"E","price":null,"details":"DPG class 3","hazard":"class 3 UN3082"}]\n结束', '原文');
  assert.equal(records.length, 5);
  assert.equal('extra' in records[0], false);
  assert.equal(records[0].purity, '99.5%');
  assert.equal(records[0].quality, '水分≤0.5%，重金属≤10ppm');
  assert.equal(records[0].hazard, '3类 UN1993');
  assert.equal(records[0].raw, '原文');
  assert.equal(records[1].price, null);
  assert.equal(records[1].rebate, 13);
  assert.equal(records[1].tax, 9);
  assert.equal(records[2].hazard, 'class 9 UN3082', 'class/UN in details fill an omitted hazard');
  assert.equal(records[3].hazard, 'class 9 UN3082', 'a model that keeps only UN must not drop class');
  assert.equal(records[4].hazard, 'class 3 UN3082', 'a model reading wins over a different detail reading');
  assert.throws(() => sanitizeQuoteRecords('没有 JSON', '原文'), /没有返回/);
});
test('model failures surface the provider message', async () => {
  let data = { revision: 0, factories: [], freights: [], history: [], settings: { provider: 'test-provider', model: 'test-model' } };
  const llm = fakeLlm('', { prepareCall: async () => ({ config: {}, stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: '配额不足' } } }; } }) });
  const service = new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, llm, () => null);
  await assert.rejects(service.execute({ action: 'parse', raw: 'x' }), /配额不足/);
});
test('products persist, normalize CAS, reject duplicates and delete by id', async () => {
  const service = fixture();
  assert.deepEqual((await service.execute({ action: 'export' })).products, []);
  const db = await service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: ' DMSO ', cas: ' 67 – 68 – 5 ', extra: 'ignored' } });
  assert.deepEqual(db.products[0], { name: 'DMSO', cas: '67-68-5', id: db.products[0].id });
  assert.ok(db.products[0].id);
  await assert.rejects(service.execute({ action: 'add', kind: 'products', revision: 1, record: { name: 'alias', cas: '67-68-5' } }), /已在目录/);
  await assert.rejects(service.execute({ action: 'add', kind: 'products', revision: 1, record: { name: 'bad', cas: 'invalid' } }));
  const deleted = await service.execute({ action: 'delete', kind: 'products', id: db.products[0].id, revision: 1 });
  assert.deepEqual(deleted.products, []);
  assert.equal(deleted.revision, 2);
});

test('product updates preserve identity, edit rate overrides and reject CAS duplicates', async () => {
  const service = fixture();
  let db = await service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'DMSO', cas: '67-68-5' } });
  const id = db.products[0].id;
  db = await service.execute({ action: 'update', kind: 'products', id, revision: 1, record: { name: '二甲基亚砜', tax: 9, rebate: 4 } });
  assert.deepEqual(db.products[0], { name: '二甲基亚砜', cas: '67-68-5', tax: 9, rebate: 4, id });
  db = await service.execute({ action: 'add', kind: 'products', revision: 2, record: { name: '乙醇', cas: '64-17-5' } });
  await assert.rejects(service.execute({ action: 'update', kind: 'products', id, revision: 3, record: { cas: '64-17-5' } }), /已在目录/);
  db = await service.execute({ action: 'update', kind: 'products', id, revision: 3, record: { tax: null, rebate: null } });
  assert.equal('tax' in db.products[0], false);
  assert.equal('rebate' in db.products[0], false);
  assert.equal((await service.execute({ action: 'list' })).products.length, 2);
  assert.equal(db.products[0].id, id);
});

test('product cargo hazard is trimmed, cleared by blank and rejected when not text', async () => {
  const service = fixture();
  let db = await service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'DMSO', cas: '67-68-5', hazard: ' Class 9 UN3082 ' } });
  assert.equal(db.products[0].hazard, 'Class 9 UN3082');
  db = await service.execute({ action: 'update', kind: 'products', id: db.products[0].id, revision: 1, record: { hazard: '' } });
  assert.equal('hazard' in db.products[0], false);
  await assert.rejects(service.execute({ action: 'add', kind: 'products', revision: 2, record: { name: 'Bad', cas: '64-17-5', hazard: {} } }), /货物危险性须为文本/);
});

test('product CAS duplicates include factory and history catalog entries', async () => {
  for (const initial of [
    { factories: [{ ...quote, cas: '67-68-5' }] },
    { history: [{ values: { product: 'DMSO', cas: '67-68-5' } }] },
  ]) {
    const service = fixture(initial);
    await assert.rejects(service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'alias', cas: '67–68–5' } }), /已在目录/);
    assert.equal((await service.execute({ action: 'list' })).revision, 0);
    const db = await service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'alias', cas: '67–68–5' }, override: true });
    assert.equal(db.products[0].name, 'alias');
    assert.equal(db.products[0].cas, '67-68-5');
    const edited = await service.execute({ action: 'update', kind: 'products', id: db.products[0].id, revision: 1, record: { name: 'alias edited' } });
    assert.equal(edited.products[0].name, 'alias edited');
  }
});

test('backup round trip includes products and old backups reset products to empty', async () => {
  const service = fixture();
  await service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'DMSO', cas: '67-68-5' } });
  const backup = await service.execute({ action: 'export' });
  const imported = await service.execute({ action: 'import', revision: 1, data: backup });
  assert.equal(imported.products[0].cas, '67-68-5');
  assert.notEqual(imported.products[0].id, backup.products[0].id);
  await assert.rejects(service.execute({ action: 'import', revision: 2, data: { ...backup, products: [{}] } }));
  assert.equal((await service.execute({ action: 'list' })).products.length, 1);
  const legacy = await service.execute({ action: 'import', revision: 2, data: { factories: [], freights: [], history: [] } });
  assert.deepEqual(legacy.products, []);
});

test('factory updates preserve identity and creation time with revision protection', async () => {
  const service = fixture();
  const added = await service.execute({ action: 'add', kind: 'factories', revision: 0, record: { ...quote, createdAt: 'fake', updatedAt: 'fake' } });
  const original = added.factories[0];
  assert.ok(Number.isFinite(Date.parse(original.createdAt)));
  assert.equal(original.updatedAt, undefined);
  const attempts = await Promise.allSettled([
    service.execute({ action: 'update', kind: 'factories', id: original.id, revision: 1, record: { price: 15000, id: 'forged', createdAt: 'forged', updatedAt: 'forged' } }),
    service.execute({ action: 'update', kind: 'factories', id: original.id, revision: 1, record: { price: 16000 } }),
  ]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  const db = await service.execute({ action: 'list' });
  assert.equal(db.revision, 2);
  assert.equal(db.factories.length, 1);
  assert.equal(db.factories[0].id, original.id);
  assert.equal(db.factories[0].createdAt, original.createdAt);
  assert.equal(db.factories[0].price, 15000);
  assert.ok(Number.isFinite(Date.parse(db.factories[0].updatedAt)));
  for (const input of [
    { kind: 'products', id: original.id, record: {} },
    { kind: 'factories', id: 'missing', record: {} },
    { kind: 'factories', id: original.id, record: { price: -1 } },
    { kind: 'factories', id: original.id, record: null },
  ]) await assert.rejects(service.execute({ action: 'update', revision: 2, ...input }));
  assert.deepEqual(await service.execute({ action: 'list' }), db);
});

test('updating a legacy factory does not invent its creation timestamp', async () => {
  const service = fixture({ factories: [{ ...quote, id: 'legacy' }] });
  const db = await service.execute({ action: 'update', kind: 'factories', id: 'legacy', revision: 0, record: { factory: 'Factory', createdAt: 'forged' } });
  assert.equal('createdAt' in db.factories[0], false);
  assert.ok(db.factories[0].updatedAt);
});

test('quotation returns an editable XLSX without changing records', async () => {
  const service = fixture({ factories: [{ ...quote, id: 'factory-1', factory: '示例工厂', port: '青岛', incoterm: 'FOB' }] });
  const values = { ...defaults, ...samples.rmb, seaMax: 6000, customerTerm: 'CIF', place: 'Hamburg' };
  const file = await service.execute({ action: 'quotation', mode: 'rmb', values, factoryId: 'factory-1' });
  assert.match(file.filename, /^Quotation_20IBC of DPG_\d{8}\.xlsx$/);
  assert.match(file.quoteNo, /^SA-[A-Z0-9]{2,3}-\d{8}$/);
  assert.equal(file.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(file.size > 3000);
  const buffer = Buffer.from(file.base64, 'base64');
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const customerOnly = await service.execute({ action: 'quotation', mode: 'rmb', values, factoryId: 'factory-1', includeCosting: false });
  assert.ok(customerOnly.size < file.size);
  assert.equal((await service.execute({ action: 'list' })).revision, 0);
  await assert.rejects(service.execute({ action: 'quotation', mode: 'rmb', values: { ...values, product: '' } }), /产品名称/);
  await assert.rejects(service.execute({ action: 'quotation', mode: 'rmb', values, factoryId: 'missing' }), /缺少对应工厂报价/);
  await assert.rejects(service.execute({ action: 'quotation', mode: 'rmb', values: { ...values, seaMax: 1 } }), /核算数据不完整/);
});

test('quotation combines multiple products for one customer and snapshots their factories', async () => {
  const service = fixture({
    factories: [
      { ...quote, id: 'f1', name: 'MCP 22%', cas: '67-68-5', purity: '22% P', packing: '25 kg / bag', validity: '2026-11-20' },
      { ...quote, id: 'f2', name: 'Urea 46%', cas: '57-13-6', purity: '46% N', packing: '50 kg / bag', validity: '2026-11-25' },
    ],
  });
  const first = { ...defaults, ...samples.rmb, product: 'MCP 22%', customer: 'ACME', creditMonths: 3, creditPayment: 'L/C', customerTerm: 'CIF', place: 'Oslo', seaMax: 6000 };
  const second = { ...first, product: 'Urea 46%', sell: 0.72 };
  const file = await service.execute({
    action: 'quotation',
    items: [
      { mode: 'rmb', values: first, factoryId: 'f1' },
      { mode: 'rmb', values: second, factoryId: 'f2' },
    ],
  });
  assert.match(file.filename, /_2items_/);
  assert.match(file.quoteNo, /^SA-AC-\d{8}$/);
  assert.ok(file.size > 5000);
  const saved = await service.execute({ action: 'add', kind: 'history', revision: 0, record: { mode: 'rmb', values: first, factoryId: 'f1' } });
  assert.equal(saved.history[0].factorySnapshot.id, 'f1');
  assert.equal(saved.history[0].factorySnapshot.purity, '22% P');
  await assert.rejects(service.execute({ action: 'quotation', items: [{ mode: 'rmb', values: first, factoryId: 'f1' }, { mode: 'rmb', values: { ...second, customer: 'OTHER' }, factoryId: 'f2' }] }), /同一客户/);
});

test('history preserves legacy term without overwriting customerTerm', async () => {
  const service = fixture();
  const values = { ...defaults, ...samples.rmb, seaMax: 6000, term: 'EXW', customerTerm: 'CIF' };
  const saved = await service.execute({ action: 'add', kind: 'history', revision: 0, record: { mode: 'rmb', values } });
  assert.equal(saved.history[0].values.term, 'EXW');
  assert.equal(saved.history[0].values.customerTerm, 'CIF');
  const backup = structuredClone(saved);
  delete backup.history[0].values.customerTerm;
  const imported = await service.execute({ action: 'import', revision: 1, data: backup });
  assert.equal(imported.history[0].values.term, 'EXW');
  assert.equal(imported.history[0].values.customerTerm, undefined);
});

test('AI prompt requests English translation, CAS and quote date and sanitizes them without losing validity text', async () => {
  let prompt, userPrompt;
  const llm = fakeLlm('', { prepareCall: async () => ({ config: {}, stream: async function* (input) {
    prompt = input.system;
    userPrompt = input.messages?.[0]?.content?.[0]?.text;
    yield { type: 'text-delta', text: JSON.stringify([{ name: 'DMSO', cas: ' 67 – 68 – 5 ', quoteDate: '2026/11/12', validity: '三天内有效', extra: 'drop' }]) };
  } }) });
  const service = new QuoteWorkbench({ get: () => ({ revision: 0, factories: [], freights: [], history: [] }) }, llm, () => ({ provider: 'test-provider', model: 'test-model' }));
  const parsed = await service.execute({ action: 'parse', raw: 'DMSO CAS 67-68-5 报价日期2026年11月12日' });
  assert.match(prompt, /先完整翻译，再识别和填写/);
  assert.match(prompt, /所有自由文本字段一律输出英语/);
  assert.match(prompt, /非危险品.*non-hazardous/);
  assert.match(userPrompt, /完整翻译成英语/);
  assert.match(prompt, /cas：CAS/);
  assert.match(prompt, /purity：含量 \/ 纯度/);
  assert.match(prompt, /quality：其他关键质量指标/);
  assert.match(prompt, /hazard：货物危险性/);
  assert.match(prompt, /class 9 UN3082/);
  assert.match(prompt, /class 和 UN 同时出现时两段都要保留/);
  assert.match(prompt, /tax：增值税率/);
  assert.match(prompt, /quoteDate：报价日期/);
  assert.equal(parsed.records[0].cas, '67-68-5');
  assert.equal(parsed.records[0].quoteDate, '2026-11-12');
  assert.equal(parsed.records[0].validity, '三天内有效');
  assert.equal('extra' in parsed.records[0], false);
  const blank = sanitizeQuoteRecords('[{}]', '原文')[0];
  assert.equal(blank.cas, '');
  assert.equal(blank.quoteDate, '');
  assert.equal(blank.purity, '');
  assert.equal(blank.quality, '');
  assert.equal(blank.hazard, '');
  assert.deepEqual((await service.execute({ action: 'schema' })).productFields.map(field => field[0]), ['name', 'cas', 'hazard', 'tax', 'rebate']);
});

test('an unavailable parsing model tells the user where to change it', async () => {
  let data = { revision: 0, factories: [], freights: [], history: [], settings: { provider: 'test-provider', model: 'test-model' } };
  const llm = fakeLlm('', { prepareCall: async () => { throw Error('no adapter'); } });
  const service = new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, llm, () => null);
  await assert.rejects(service.execute({ action: 'parse', raw: 'x' }), /解析模型不可用.*设置/);
});
