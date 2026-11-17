import { randomUUID } from 'node:crypto';
import { basic, costs, params, factoryFields, productFields, freightFields, validateDatabase, validateRecord, validateCalculation, calculate, lookupCreditRate, averageFreights, normalizeCas, normalizeFactoryDate, catalogProducts, extractHazard } from './domain.js';
import { buildQuotationWorkbook } from './xlsx.js';

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF'];
const SESSION_ID = `dsh-quote-workbench-${randomUUID()}`;
const SYSTEM_PROMPT = `你是报价工作台的报价提取器。用户会粘贴工厂报价，可能是自由文本，也可能是从 Excel 复制来的制表符表格。请把它提取为 JSON 数组，每个报价一条记录。
只输出 JSON 数组本身，不要解释，不要 Markdown 代码块。

翻译规则（必须先执行）：
- 先完整翻译，再识别和填写：把每条报价的全部文字先翻译成英语，然后基于英文完成产品归类、字段识别和带入。
- 除 unit、warehouse、portfee 这三个必须使用固定中文值的字段，以及 currency、incoterm 这两个固定英文枚举字段外，所有自由文本字段一律输出英语。
- 需要翻译的自由文本包括：name、purity 的说明文字、quality、hazard、factory、details、quantity、validity、port、loading、packing、delivery。
- 数字、百分比、CAS 号、UN 编号、日期、币种和 Incoterm 保持原值；不要改变数量、单价或单位换算关系。
- 不要在任何自由文本字段中保留中文原文，也不要把中文原文和英文译文同时写入。

每条记录的字段：
- name：产品名称 / 规格（英文；不含含量、纯度和包装）；没有就留空字符串
- purity：含量 / 纯度（英文描述，保留数字和符号，如 99.5%、≥99%）；没有留空，不要推测
- quality：其他关键质量指标（英文，如水分、杂质、重金属、外观、粒径等）；没有留空
- hazard：货物危险性（英文）。凡出现 "class 9 UN3082"、"Class 3"、"UN 1993" 这类格式（class/Class + 类别数字，UN + 四位数字），都填入本字段并保留格式；class 和 UN 同时出现时两段都要保留。"非危险品"译为 "non-hazardous"；没有留空，不要推测
- cas：CAS 号，仅提取原文明确给出的编号，格式如 67-68-5；没有留空，不要根据产品名称推测
- quoteDate：报价日期，尽量规范为 YYYY-MM-DD；没有留空，不要用当前日期补填
- factory：工厂名称（英文）；没有留空
- details：这一条报价的完整明细（英文翻译，保留数字、CAS、UN、日期、币种和 Incoterm）；没有留空
- quantity：数量口径（英文，如 22t/20GP、1000 kg）；没有留空
- validity：报价有效期（英文）。原文写的是期限（如 "30 days"、"two weeks"、"一个月"）就原样输出该期限，由工作台按报价日期加该期限计算；原文写的是具体日期就输出 YYYY-MM-DD；没有留空
- price：报价单价，纯数字；有多个价格、价格区间或标题行时填 null
- currency："USD" 或 "RMB"
- tax：增值税率百分数 0–100；明确写了增值税率才填；未提到填 null
- rebate：退税率百分数 0–100；明确不退税填 0；未提到填 null
- unit：固定用中文 "吨" 或 "公斤"；无法判断填 "待确认"（此字段不要翻译）
- incoterm："EXW"、"FCA"、"FOB"、"CFR"、"CIF"、"其他" 或 "待确认"
- port：交货地点或港口（英文，如 Qingdao、Shanghai）；没有留空
- loading：装柜量 / 柜型（英文或原格式，如 22t/20GP、20GP）；没有留空
- packing：包装方式（英文，如 unpalletized、25 kg bags）；没有留空
- delivery：交货期（英文，尽量含年份，如 December 2026）；没有留空
- warehouse：进仓费承担方，固定用中文 "我方" 或 "工厂"（此字段不要翻译）
- portfee：港杂费承担方，固定用中文 "我方" 或 "工厂"（此字段不要翻译）

规则：
- 文本里有多个产品、多行报价或多段报价时，拆成多条记录。
- 单价后跟"美金/美元/USD/$"记 USD；跟"元/人民币/RMB"记 RMB；没写币种时根据上下文判断，默认 RMB。
- "每吨 / MT / t / 吨"记吨；"每公斤 / kg / 公斤"记公斤；都判断不了填"待确认"。
- 报价有效期是 "30 days / 30 天 / 两周" 这类期限时保留期限原文，不要自行换算成日期。
- class 9 UN3082、class 3、UN 1993、UN3082 等均为货物危险性，写入 hazard；不要只保留 UN 编号而丢掉 class。
- 货物危险性只写入 hazard，不要重复写入 quality。
- 不要臆造价格、工厂、日期、含量/纯度、质量指标、货物危险性和费用承担方；不确定的字段用空字符串、null 或"待确认"。
- 金额只保留数字，不要货币符号和千分位。
- 如果粘贴的内容看起来不是报价，返回 []。`;

function buildParsePrompt(raw, now = new Date()) {
  return `现在时间：${now.toISOString()}（${now.toLocaleString('zh-CN')}）。
请先把下面内容完整翻译成英语，再基于英文提取工厂报价；所有自由文本字段都用英语输出：

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
/** Product records keep optional VAT/rebate and cargo-hazard overrides; absent fields continue to follow the CAS binding. */
function productRecord(record, base = {}) {
  const next = { ...base };
  if (Object.hasOwn(record, 'name')) next.name = typeof record.name === 'string' ? record.name.trim() : record.name;
  if (Object.hasOwn(record, 'cas')) next.cas = normalizeCas(record.cas);
  if (Object.hasOwn(record, 'hazard')) {
    if (record.hazard !== null && record.hazard !== undefined && typeof record.hazard !== 'string') throw Error('货物危险性须为文本。');
    const hazard = typeof record.hazard === 'string' ? record.hazard.trim() : '';
    if (hazard) next.hazard = hazard;
    else delete next.hazard;
  }
  for (const key of ['tax', 'rebate']) {
    if (!Object.hasOwn(record, key)) continue;
    if (record[key] === null || record[key] === undefined || record[key] === '') delete next[key];
    else next[key] = Number(record[key]);
  }
  return next;
}
function detectUnit(text) {
  if (/吨|\bMT\b|\d+\s*t\s*\//i.test(text)) return '吨';
  if (/公斤|千克|\bkg\b|\/\s*kg/i.test(text)) return '公斤';
  return '待确认';
}
function detectCurrency(text) {
  return /USD|美金|美元|\$/i.test(text) ? 'USD' : 'RMB';
}
/** Keep both class and UN from a trusted per-record detail when the model dropped one of them. */
function hazardValue(modelHazard, details, trusted) {
  if (!trusted) return modelHazard;
  const source = extractHazard(details);
  const hasClass = value => /\bclass\b|\d+(?:\.\d+)?\s*类/i.test(value);
  const hasUn = value => /\bUN\s*(?:No\.?|Number|编号)?\s*[:：]?\s*(\d{4}|[xX]{4})\b/i.test(value);
  if (source && (!modelHazard || (!hasClass(modelHazard) && hasClass(source)) || (!hasUn(modelHazard) && hasUn(source)))) return source;
  return modelHazard || source;
}

/** 模型输出不可信：只保留白名单字段并做类型收敛。 */
export function sanitizeQuoteRecords(output, raw) {
  const parsed = extractJson(output);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : null;
  if (!list) throw Error('模型没有返回报价数组，请重试或换一个模型');
  return list.filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => {
    const detailText = plainText(row.details ?? row.raw, 4000);
    const details = detailText || raw;
    const price = noteNumber(row.price);
    const tax = noteNumber(row.tax);
    const rebate = noteNumber(row.rebate);
    const currencyText = plainText(row.currency, 10).toUpperCase();
    const incotermText = plainText(row.incoterm, 10).toUpperCase();
    return {
      name: plainText(row.name),
      purity: plainText(row.purity ?? row.content ?? row.assay, 100),
      quality: plainText(row.quality ?? row.qualityIndicators ?? row.indicators, 1000),
      hazard: hazardValue(plainText(row.hazard ?? row.danger ?? row.dangerousGoods ?? row.hazardClass, 300), details, Boolean(detailText)),
      cas: normalizeCas(plainText(row.cas)),
      quoteDate: normalizeFactoryDate(plainText(row.quoteDate, 100)),
      factory: plainText(row.factory),
      details,
      quantity: plainText(row.quantity),
      validity: plainText(row.validity),
      price: price !== null && price > 0 ? price : null,
      currency: currencyText === 'USD' || currencyText === 'RMB' ? currencyText : detectCurrency(details),
      tax: tax !== null && tax >= 0 && tax <= 100 ? tax : null,
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
    if (action === 'schema') return { basic, costs, params, factoryFields, freightFields, productFields, modes: ['rmb', 'usd', 'own'] };
    if (action === 'list' || action === 'export') return db;
    if (action === 'settings') return { settings: db.settings, revision: db.revision, effective: this.effective(db.settings) };
    if (action === 'models') return this.listModels(db.settings);
    if (action === 'parse') return this.parse(input.raw, db.settings, signal);
    if (action === 'credit') return { result: lookupCreditRate(input.country, input.months, input.payment) };
    if (action === 'average') return { result: averageFreights(input.rows, input.today) };
    if (action === 'calculate') {
      if (!validateCalculation(input.values, input.mode)) throw Error('核算数据不完整或超出有效范围');
      return { result: calculate(input.values, input.mode), highFreightResult: calculate({ ...input.values, sea: input.values.seaMax }, input.mode) };
    }
    if (action === 'quotation') {
      const rawItems = Array.isArray(input.items) && input.items.length
        ? input.items
        : [{ mode: input.mode, values: input.values, factoryId: input.factoryId, factory: input.factory }];
      const items = rawItems.map(item => {
        if (!validateCalculation(item?.values, item?.mode)) throw Error('核算数据不完整或超出有效范围');
        if (!item.values.product?.trim()) throw Error('请先填写产品名称再导出报价单');
        let factory = item.factoryId ? db.factories.find(row => row.id === item.factoryId) : null;
        if (!factory && item.factory && typeof item.factory === 'object' && !Array.isArray(item.factory)) factory = item.factory;
        if (!factory && item.mode !== 'own') throw Error('缺少对应工厂报价，请重新选择工厂报价后再输出');
        return {
          mode: item.mode,
          values: item.values,
          result: calculate(item.values, item.mode),
          highFreightResult: calculate({ ...item.values, sea: item.values.seaMax }, item.mode),
          factory: factory || null,
        };
      });
      const customer = String(items[0].values.customer ?? '').trim();
      if (items.length > 1 && (!customer || items.some(item => String(item.values.customer ?? '').trim().toLowerCase() !== customer.toLowerCase()))) {
        throw Error('合并报价需选择同一客户的核算记录');
      }
      const includeCosting = input.includeCosting !== false;
      const file = buildQuotationWorkbook({ items, includeCosting });
      return {
        filename: file.filename,
        quoteNo: file.quoteNo,
        mime: file.mime,
        size: file.buffer.length,
        base64: file.buffer.toString('base64'),
        generatedAt: file.generatedAt,
      };
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
        if (!['factories', 'products', 'history'].includes(input.kind)) throw Error('仅支持更新工厂报价、产品或核算记录');
        const rows = db[input.kind];
        const index = rows.findIndex(row => row.id === input.id);
        if (index < 0) throw Error('记录不存在，请刷新');
        if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) throw Error('记录必须是有效对象。');
        const previous = rows[index];
        if (input.kind === 'factories') {
          const next = { ...previous, ...structuredClone(input.record), id: previous.id, updatedAt: new Date().toISOString() };
          if (previous.createdAt === undefined) delete next.createdAt;
          else next.createdAt = previous.createdAt;
          if (next.cas !== undefined) next.cas = normalizeCas(next.cas);
          validateRecord('factories', next);
          rows[index] = next;
        } else if (input.kind === 'history') {
          const next = { ...previous, ...structuredClone(input.record), id: previous.id };
          if (!validateCalculation(next.values, next.mode)) throw Error('核算数据不完整或超出有效范围');
          const factoryId = typeof next.factoryId === 'string' ? next.factoryId : null;
          const source = factoryId ? db.factories.find(row => row.id === factoryId) : null;
          if (source) next.factorySnapshot = structuredClone(source);
          else { delete next.factoryId; delete next.factorySnapshot; }
          // Overwrite keeps the original record id and date; only the calculation and factory source change.
          next.result = calculate(next.values, next.mode);
          next.highFreightResult = calculate({ ...next.values, sea: next.values.seaMax }, next.mode);
          validateRecord('history', next);
          rows[index] = next;
        } else {
          const next = productRecord(input.record, previous);
          validateRecord('products', next);
          // Editing name/rates of an existing CAS is always allowed; a changed CAS must stay unique.
          if (next.cas !== normalizeCas(previous.cas) && catalogProducts({ ...db, products: db.products.filter(row => row.id !== next.id) }).some(row => normalizeCas(row.cas) === next.cas)) throw Error('该 CAS 号已在目录中。');
          rows[index] = next;
        }
      } else if (action === 'delete') {
        const index = db[input.kind].findIndex(row => row.id === input.id);
        if (index < 0) throw Error('记录不存在，请刷新');
        db[input.kind].splice(index, 1);
      } else {
        let next = structuredClone(input.record);
        if (input.kind === 'history') {
          if (!validateCalculation(next?.values, next?.mode)) throw Error('核算数据不完整或超出有效范围');
          const factoryId = typeof next.factoryId === 'string' ? next.factoryId : null;
          const source = factoryId ? db.factories.find(row => row.id === factoryId) : null;
          if (source) next.factorySnapshot = structuredClone(source);
          else delete next.factorySnapshot;
          next = { ...next, result: calculate(next.values, next.mode), highFreightResult: calculate({ ...next.values, sea: next.values.seaMax }, next.mode), date: new Date().toISOString() };
        }
        if (input.kind === 'products' && next && typeof next === 'object' && !Array.isArray(next)) {
          next = productRecord(next);
        }
        validateRecord(input.kind, next);
        if (input.kind === 'products') {
          const exists = catalogProducts(db).some(product => normalizeCas(product.cas) === next.cas);
          const manualExists = db.products.some(product => normalizeCas(product.cas) === next.cas);
          // Editing a quote-derived product stores a manual catalog override; a plain add still rejects duplicates.
          if (exists && !(input.override === true && !manualExists)) throw Error('该 CAS 号已在目录中。');
        }
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
