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
  assert.equal((await service.execute({ action: 'export' })).revision, 1);
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
  const records = sanitizeQuoteRecords('说明文字\n[{"name":"A","price":2.5,"unit":"公斤","extra":"drop"},{"name":"B","price":null,"rebate":"13"}]\n结束', '原文');
  assert.equal(records.length, 2);
  assert.equal('extra' in records[0], false);
  assert.equal(records[0].raw, '原文');
  assert.equal(records[1].price, null);
  assert.equal(records[1].rebate, 13);
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

test('product CAS duplicates include factory and history catalog entries', async () => {
  for (const initial of [
    { factories: [{ ...quote, cas: '67-68-5' }] },
    { history: [{ values: { product: 'DMSO', cas: '67-68-5' } }] },
  ]) {
    const service = fixture(initial);
    await assert.rejects(service.execute({ action: 'add', kind: 'products', revision: 0, record: { name: 'alias', cas: '67–68–5' } }), /已在目录/);
    assert.equal((await service.execute({ action: 'list' })).revision, 0);
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

test('AI prompt requests CAS and quote date and sanitizes them without losing validity text', async () => {
  let prompt;
  const llm = fakeLlm('', { prepareCall: async () => ({ config: {}, stream: async function* (input) {
    prompt = input.system;
    yield { type: 'text-delta', text: JSON.stringify([{ name: 'DMSO', cas: ' 67 – 68 – 5 ', quoteDate: '2026/11/12', validity: '三天内有效', extra: 'drop' }]) };
  } }) });
  const service = new QuoteWorkbench({ get: () => ({ revision: 0, factories: [], freights: [], history: [] }) }, llm, () => ({ provider: 'test-provider', model: 'test-model' }));
  const parsed = await service.execute({ action: 'parse', raw: 'DMSO CAS 67-68-5 报价日期2026年11月12日' });
  assert.match(prompt, /cas：CAS/);
  assert.match(prompt, /quoteDate：报价日期/);
  assert.equal(parsed.records[0].cas, '67-68-5');
  assert.equal(parsed.records[0].quoteDate, '2026-11-12');
  assert.equal(parsed.records[0].validity, '三天内有效');
  assert.equal('extra' in parsed.records[0], false);
  const blank = sanitizeQuoteRecords('[{}]', '原文')[0];
  assert.equal(blank.cas, '');
  assert.equal(blank.quoteDate, '');
  assert.deepEqual((await service.execute({ action: 'schema' })).productFields.map(field => field[0]), ['name', 'cas']);
});

test('an unavailable parsing model tells the user where to change it', async () => {
  let data = { revision: 0, factories: [], freights: [], history: [], settings: { provider: 'test-provider', model: 'test-model' } };
  const llm = fakeLlm('', { prepareCall: async () => { throw Error('no adapter'); } });
  const service = new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, llm, () => null);
  await assert.rejects(service.execute({ action: 'parse', raw: 'x' }), /解析模型不可用.*设置/);
});
