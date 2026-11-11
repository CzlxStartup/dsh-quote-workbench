import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteWorkbench, sanitizeQuoteRecords } from './service.js';
import { defaults, samples } from './domain.js';
function fixture() {
  let data = { revision: 0, factories: [], freights: [], history: [] };
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
test('an unavailable parsing model tells the user where to change it', async () => {
  let data = { revision: 0, factories: [], freights: [], history: [], settings: { provider: 'test-provider', model: 'test-model' } };
  const llm = fakeLlm('', { prepareCall: async () => { throw Error('no adapter'); } });
  const service = new QuoteWorkbench({ get: () => structuredClone(data), set: async value => { data = structuredClone(value); } }, llm, () => null);
  await assert.rejects(service.execute({ action: 'parse', raw: 'x' }), /解析模型不可用.*设置/);
});
