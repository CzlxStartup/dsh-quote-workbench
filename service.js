import { randomUUID } from 'node:crypto';
import { basic, costs, params, factoryFields, freightFields, validateDatabase, validateRecord, validateCalculation, calculate, lookupCreditRate, averageFreights, normalizeCas, normalizeFactoryDate, catalogProducts } from './domain.js';

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF'];
const SESSION_ID = `dsh-quote-workbench-${randomUUID()}`;
const SYSTEM_PROMPT = `你是报价工作台的报价提取器。用户会粘贴工厂报价，可能是自由文本，也可能是从 Excel 复制来的制表符表格。请把它提取为 JSON 数组，每个报价一条记录。
只输出 JSON 数组本身，不要解释，不要 Markdown 代码块。

每条记录的字段：
- name：产品 / 规格（含含量、包装等关键描述）；没有就留空字符串
- cas：CAS 号，仅提取原文明确给出的编号，格式如 67-68-5；没有留空，不要根据产品名称推测
- quoteDate：报价日期，尽量规范为 YYYY-MM-DD；没有留空，不要用当前日期补填
- factory：工厂名称；没有留空
- details：这一条报价的完整原文明细，保留原文
- quantity：数量口径（如 22t/20GP、1000kg）；没有留空
- validity：报价有效期；没有留空
- price：报价单价，纯数字；有多个价格、价格区间或标题行时填 null
- currency："USD" 或 "RMB"
- rebate：退税率百分数 0–100；明确不退税填 0；未提到填 null
- unit："吨" 或 "公斤"；无法判断填 "待确认"
- incoterm："EXW"、"FCA"、"FOB"、"CFR"、"CIF"、"其他" 或 "待确认"
- port：交货地点或港口；没有留空
- loading：装柜量 / 柜型；没有留空
- packing：包装方式；没有留空
- delivery：交货期，尽量含年份；原文没有年份就保留原文
- warehouse：进仓费承担方，"我方" 或 "工厂"
- portfee：港杂费承担方，"我方" 或 "工厂"

规则：
- 文本里有多个产品、多行报价或多段报价时，拆成多条记录。
- 单价后跟"美金/美元/USD/$"记 USD；跟"元/人民币/RMB"记 RMB；没写币种时根据上下文判断，默认 RMB。
- "每吨 / MT / t / 吨"记吨；"每公斤 / kg / 公斤"记公斤；都判断不了填"待确认"。
- 不要臆造价格、工厂、日期和费用承担方；不确定的字段用空字符串、null 或"待确认"。
- 金额只保留数字，不要货币符号和千分位。
- 如果粘贴的内容看起来不是报价，返回 []。`;

function buildParsePrompt(raw, now = new Date()) {
  return `现在时间：${now.toISOString()}（${now.toLocaleString('zh-CN')}）。
请提取下面内容里的工厂报价：

<raw>
${raw}
</raw>`;
}

/** 从模型输出里取出 JSON，容忍代码块或前后说明文字。 */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw Error('模型没有返回可用的 JSON，请重试或换一个模型');
  return JSON.parse(body.slice(start, end + 1));
}

const plainText = (value, max = 500) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
};
const noteNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const number = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? number : null;
  }
  return null;
};
function detectUnit(text) {
  if (/吨|\bMT\b|\d+\s*t\s*\//i.test(text)) return '吨';
  if (/公斤|千克|\bkg\b|\/\s*kg/i.test(text)) return '公斤';
  return '待确认';
}
function detectCurrency(text) {
  return /USD|美金|美元|\$/i.test(text) ? 'USD' : 'RMB';
}

/** 模型输出不可信：只保留白名单字段并做类型收敛。 */
export function sanitizeQuoteRecords(output, raw) {
  const parsed = extractJson(output);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : null;
  if (!list) throw Error('模型没有返回报价数组，请重试或换一个模型');
  return list.filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => {
    const details = plainText(row.details ?? row.raw, 4000) || raw;
    const price = noteNumber(row.price);
    const rebate = noteNumber(row.rebate);
    const currencyText = plainText(row.currency, 10).toUpperCase();
    const incotermText = plainText(row.incoterm, 10).toUpperCase();
    return {
      name: plainText(row.name),
      cas: normalizeCas(plainText(row.cas)),
      quoteDate: normalizeFactoryDate(plainText(row.quoteDate, 100)),
      factory: plainText(row.factory),
      details,
      quantity: plainText(row.quantity),
      validity: plainText(row.validity),
      price: price !== null && price > 0 ? price : null,
      currency: currencyText === 'USD' || currencyText === 'RMB' ? currencyText : detectCurrency(details),
      rebate: rebate !== null && rebate >= 0 && rebate <= 100 ? rebate : null,
      unit: ['吨', '公斤'].includes(row.unit) ? row.unit : detectUnit(details),
      incoterm: INCOTERMS.includes(incotermText) ? incotermText : /其他/.test(plainText(row.incoterm, 10)) ? '其他' : '待确认',
      port: plainText(row.port),
      loading: plainText(row.loading),
      packing: plainText(row.packing),
      delivery: plainText(row.delivery),
      warehouse: row.warehouse === '工厂' ? '工厂' : '我方',
      portfee: row.portfee === '工厂' ? '工厂' : '我方',
      raw: details,
    };
  });
}

export class QuoteWorkbench {
  constructor(storage, llm, defaultSelection) {
    this.storage = storage;
    this.llm = llm;
    this.defaultSelection = defaultSelection ?? (() => null);
    this.tail = Promise.resolve();
  }
  async execute(input, signal) {
    if (!input || typeof input !== 'object') throw Error('操作参数必须是对象');
    const write = ['add', 'update', 'delete', 'import', 'saveSettings'].includes(input.action);
    if (!write) return this.perform(input, signal);
    const task = this.tail.then(() => this.perform(input, signal));
    this.tail = task.catch(() => {});
    return task;
  }
  effective(settings) {
    const selection = settings ?? this.defaultSelection();
    if (!selection?.provider || !selection?.model) return null;
    return { provider: selection.provider, model: selection.model, label: `${selection.provider}/${selection.model}` };
  }
  async listModels(settings) {
    let providers = [];
    try { providers = await this.llm.listProviders(); } catch { providers = []; }
    const settled = await Promise.allSettled(providers.map(async provider => ({
      provider: provider.id,
      name: provider.name || provider.id,
      models: (await this.llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name || model.id })),
    })));
    return {
      providers: settled.filter(row => row.status === 'fulfilled').map(row => row.value).filter(provider => provider.models.length),
      defaultModel: this.defaultSelection() ?? null,
      effective: this.effective(settings),
    };
  }
  async callModel(selection, raw, signal) {
    let call;
    try {
      call = await this.llm.prepareCall({ provider: selection.provider, model: selection.model, maxTokens: 2000, temperature: 0 }, signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw Error('解析超时，请重试或换一个模型');
      throw Error(`解析模型不可用：${error?.message || error}。请在 设置 → 报价工作台 更换模型。`);
    }
    let text = '';
    try {
      for await (const chunk of call.stream({
        ...call.config,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildParsePrompt(raw) }] }],
        sessionId: SESSION_ID,
        signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw Error(chunk.reason.failure?.message || '模型调用失败');
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw Error('解析超时，请重试或换一个模型');
      throw error;
    }
    if (!text.trim()) throw Error('模型没有返回内容，请换一个模型重试');
    return text;
  }
  async parse(raw, settings, signal) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) throw Error('请先粘贴报价文本');
    if (text.length > 20000) throw Error('报价文本过长，请分批粘贴');
    const model = this.effective(settings);
    if (!model) throw Error('请先在 设置 → 报价工作台 选择解析模型');
    const records = sanitizeQuoteRecords(await this.callModel(model, text, signal), text);
    return { records, model: model.label };
  }
  async perform(input, signal) {
    const { action } = input;
    const stored = this.storage.get();
    const db = structuredClone(stored);
    if (db.settings === undefined) db.settings = null;
    if (db.products === undefined) db.products = [];
    if (action === 'schema') return { basic, costs, params, factoryFields, freightFields, productFields: [['name', '产品名称', 'text'], ['cas', 'CAS 号', 'text']], modes: ['rmb', 'usd', 'own'] };
    if (action === 'list' || action === 'export') return db;
    if (action === 'settings') return { settings: db.settings, revision: db.revision, effective: this.effective(db.settings) };
    if (action === 'models') return this.listModels(db.settings);
    if (action === 'parse') return this.parse(input.raw, db.settings, signal);
    if (action === 'credit') return { result: lookupCreditRate(input.country, input.months, input.payment) };
    if (action === 'average') return { result: averageFreights(input.rows, input.today) };
    if (action === 'calculate') {
      if (!validateCalculation(input.values, input.mode)) throw Error('核算数据不完整或超出有效范围');
      return { result: calculate(input.values, input.mode), highFreightResult: input.mode === 'rmb' ? calculate({ ...input.values, sea: input.values.seaMax }, input.mode) : null };
    }
    if (!['add', 'update', 'delete', 'import', 'saveSettings'].includes(action)) throw Error('未知操作');
    if (input.revision !== stored.revision) throw Error('记录已更新，请刷新后重试，避免覆盖其他窗口的修改');
    if (action === 'saveSettings') {
      const settings = input.settings == null ? null : {
        provider: plainText(input.settings.provider, 100),
        model: plainText(input.settings.model, 200),
      };
      if (settings && (!settings.provider || !settings.model)) throw Error('请同时选择模型提供方和模型');
      if (settings) {
        let providers = [];
        try { providers = await this.llm.listProviders(); } catch { providers = []; }
        if (!providers.some(provider => provider.id === settings.provider)) throw Error('所选模型提供方当前不可用，请刷新模型列表');
      }
      db.settings = settings;
      db.revision++;
      await this.storage.set(db);
      return { settings: db.settings, revision: db.revision, effective: this.effective(db.settings) };
    }
    if (action === 'import') {
      validateDatabase(input.data);
      for (const key of ['factories', 'freights', 'history', 'products']) db[key] = (input.data[key] ?? []).map(row => ({ ...row, id: randomUUID() }));
    } else {
      if (!['factories', 'freights', 'history', 'products'].includes(input.kind)) throw Error('请选择有效记录类型');
      if (action === 'update') {
        if (input.kind !== 'factories') throw Error('仅支持更新工厂报价');
        const index = db.factories.findIndex(row => row.id === input.id);
        if (index < 0) throw Error('记录不存在，请刷新');
        if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) throw Error('记录必须是有效对象。');
        const previous = db.factories[index];
        const next = { ...previous, ...structuredClone(input.record), id: previous.id, updatedAt: new Date().toISOString() };
        if (previous.createdAt === undefined) delete next.createdAt;
        else next.createdAt = previous.createdAt;
        if (next.cas !== undefined) next.cas = normalizeCas(next.cas);
        validateRecord('factories', next);
        db.factories[index] = next;
      } else if (action === 'delete') {
        const index = db[input.kind].findIndex(row => row.id === input.id);
        if (index < 0) throw Error('记录不存在，请刷新');
        db[input.kind].splice(index, 1);
      } else {
        let next = structuredClone(input.record);
        if (input.kind === 'history') {
          if (!validateCalculation(next?.values, next?.mode)) throw Error('核算数据不完整或超出有效范围');
          next = { ...next, result: calculate(next.values, next.mode), highFreightResult: next.mode === 'rmb' ? calculate({ ...next.values, sea: next.values.seaMax }, next.mode) : null, date: new Date().toISOString() };
        }
        if (input.kind === 'products' && next && typeof next === 'object' && !Array.isArray(next)) {
          next = { name: typeof next.name === 'string' ? next.name.trim() : next.name, cas: normalizeCas(next.cas) };
        }
        validateRecord(input.kind, next);
        if (input.kind === 'products' && catalogProducts(db).some(product => normalizeCas(product.cas) === next.cas)) throw Error('该 CAS 号已在目录中。');
        if (input.kind === 'factories') {
          next.createdAt = new Date().toISOString();
          delete next.updatedAt;
          if (next.cas !== undefined) next.cas = normalizeCas(next.cas);
        }
        const saved = { ...next, id: randomUUID() };
        if (input.kind === 'products') db.products.push(saved);
        else db[input.kind].unshift(saved);
      }
    }
    db.revision++;
    await this.storage.set(db);
    return db;
  }
}
