// Feishu Bitable sync for the quotation workbench.
//
// 诚实披露：以下细节来自方案文档列出的官方接口地址，但飞书开放平台文档是客户端渲染的
// 单页应用，web_fetch 两次返回 HTTP 200 空正文，无法在线核对；接口路径、批次负载格式
// 与字段类型枚举均按常见用法实现，需要实际联调验证（见 docs/feishu-sync-plan.md 第 48-54 行）：
//   - 批量读写 URL：/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create
//     及同目录的 batch_update / batch_delete / search（POST 分页查询）。
//   - 字段类型枚举：文本 1、数字 2、单选 3、日期 5、人员 11。建表按此值建列，如与线上枚举不符以实测为准。
//   - 日期字段负载为毫秒时间戳；人员字段负载为 [{id: open_id}] 数组。
//   - 用户授权（OAuth）：/open-apis/authen/v1/authorize（带 scope）→
//     /open-apis/authen/v1/oidc/access_token / refresh_access_token，user_info 取用户身份。
//   - 知识库节点解析：/open-apis/wiki/v2/spaces/get_node（仅在填 wiki 链接时需要）。
// 失败路径的约定：任何网络/凭据错误都抛出普通 Error，由调用方决定标记「待同步」，
// 绝不阻塞本地读写。
'use strict';

const TOKEN_HOST = 'https://open.feishu.cn';
const CREDENTIAL_KEY = 'quote-workbench/feishu';
// 当前授权用户的 user grant：{ open_id, name, refreshToken }
const USER_CREDENTIAL_KEY = 'quote-workbench/feishu-user';
// 用户身份需要的权限范围（空格分隔）。缺了这些，授权页不展示、令牌不带对应权限。
// bitable:app = 读写多维表格（表/字段/记录）；wiki:wiki:readonly = 解析知识库链接（可选）。
// 未验证：scope 具体 code 需与飞书后台开通的权限一致，若授权页仍缺项，按后台权限 code 调整。
const OAUTH_SCOPE = 'bitable:app wiki:wiki:readonly';

// —— 表与列定义（列名唯一、建表一次；沿用 domain.js 中的枚举原文） ——
const TABLE_KINDS = ['factories', 'freights', 'history', 'products'];
// 每张表的业务唯一键：用于把远端行匹配回本地记录（按 domain.js 校验规则选定的稳定字段）。
const TABLE_KEYS = {
  factories: ['cas', 'quoteDate', 'factory', 'price'],
  freights: ['agent', 'origin', 'destination', 'transportMode'],
  history: ['product', 'quoteCountry', 'customer'],
  products: ['cas'],
};
const TABLE_TITLES = {
  factories: '工厂报价',
  freights: '货代报价',
  history: '核算记录',
  products: '产品目录',
};
// 列定义：[本地字段, 列名, 类型, 可选枚举, 值来源]。
// 类型 'user' = 飞书人员字段（值 = [{id: open_id}]）。
// 值来源 'creator' = 推送时填入记录创建者（首次写入时设为当前用户，之后不变）；
//          'editor'  = 推送时填入当前授权用户（每次写入都更新）。
// enum 之外的值本地会拒绝，远端旧行同样拒绝。
const CREATOR_COLUMN = ['creator', '创建人', 'user', null, 'creator'];
const LAST_EDITOR_COLUMN = ['lastEditor', '最后修改人', 'user', null, 'editor'];
const TABLE_COLUMNS = {
  factories: [
    ['cas', 'CAS 号', 'text'], ['quoteDate', '报价日期', 'date'], ['name', '产品', 'text'],
    ['purity', '含量 / 纯度', 'text'], ['quality', '其他关键质量指标', 'text'],
    ['hazard', '货物危险性', 'text'], ['factory', '工厂', 'text'], ['details', '报价明细', 'text'],
    ['quantity', '数量', 'text'], ['validity', '报价有效期', 'date'], ['price', '报价单价', 'number'],
    ['currency', '币种', 'enum', ['USD', 'RMB']], ['tax', '增值税率 %', 'number'],
    ['rebate', '退税率 %', 'number'], ['unit', '计价单位', 'enum', ['待确认', '吨', '公斤']],
    ['incoterm', 'Incoterm', 'enum', ['待确认', 'EXW', 'FCA', 'FOB', 'CFR', 'CIF', '其他']],
    ['port', '交货地点', 'text'], ['loading', '装柜量 / 柜型', 'text'], ['packing', '包装方式', 'text'],
    ['delivery', '交货期', 'text'], ['warehouse', '进仓费承担方', 'enum', ['我方', '工厂']],
    ['portfee', '港杂费承担方', 'enum', ['我方', '工厂']],
    CREATOR_COLUMN, LAST_EDITOR_COLUMN,
  ],
  freights: [
    ['agent', '货代名称', 'text'], ['origin', '起运地', 'text'], ['destination', '目的地', 'text'],
    ['transportMode', '运输方式', 'enum', ['海运整柜', '海运拼箱', '空运']],
    ['containerType', '柜型', 'enum', ['20GP', '40GP', '40HQ', '45HQ']],
    ['quantity', '询价数量', 'number'], ['quantityUnit', '询价单位', 'enum', ['公斤', '吨', 'CBM', '票']],
    ['bulky', '是否抛货', 'enum', ['否', '是']], ['volume', '体积（CBM）', 'number'],
    ['valid', '有效期', 'date'], ['sea', '国际运费 USD/票', 'number'], ['local', '国内费用 RMB/票', 'number'],
    CREATOR_COLUMN, LAST_EDITOR_COLUMN,
  ],
  history: [
    ['product', '产品 / 规格', 'text'], ['quoteCountry', '报价国家 / 地区', 'text'],
    ['customer', '客户', 'text'], ['date', '核算日期', 'date'], ['mode', '核算方式', 'enum', ['rmb', 'usd', 'own']],
    ['qty', '数量 kg', 'number'], ['sell', '对客单价 USD/kg', 'number'],
    ['customerTerm', 'Incoterm', 'enum', ['待确认', 'EXW', 'FCA', 'FOB', 'CFR', 'CIF', '其他']],
    ['place', '交货地点 / 港口', 'text'], ['etd', 'ETD', 'text'], ['buy', '工厂采购单价', 'number'],
    ['fx', '买汇 RMB/USD', 'number'], ['receive', '收汇 RMB/USD', 'number'],
    ['sea', '国际运费 USD/票', 'number'], ['local', '国内费用 RMB/票', 'number'],
    ['tax', '增值税率 %', 'number'], ['rebate', '退税率 %', 'number'],
    ['transport', '运输保险费率 %', 'number'], ['credit', '信用保险费率 %', 'number'],
    ['interest', '年资金利率 %', 'number'], ['months', '资金占用月数', 'number'],
    ['result', '核算结果', 'text'], ['highFreightResult', '高运费核算', 'text'],
    CREATOR_COLUMN, LAST_EDITOR_COLUMN,
  ],
  products: [
    ['name', '产品名称', 'text'], ['cas', 'CAS 号', 'text'], ['hazard', '货物危险性', 'text'],
    ['tax', '增值税率 %', 'number'], ['rebate', '退税率 %', 'number'],
    CREATOR_COLUMN, LAST_EDITOR_COLUMN,
  ],
};

// 类型 → 飞书字段类型枚举。未验证：人员=11 需实测校正。
const FIELD_TYPE_ENUM = { number: 2, date: 5, enum: 3, user: 11, text: 1 };

function clone(value) { return value === undefined ? undefined : structuredClone(value); }

// —— 值 ⇄ 飞书字段（text/enum 存文本，number 存数字，date 存毫秒时间戳，user 存 [{id}]）。 ——
function encodeField(type, value) {
  if (type === 'user') {
    // value 为 open_id 字符串 → [{id}]；空则 null（不写该字段）。
    const id = typeof value === 'string' ? value.trim() : '';
    return id ? [{ id }] : null;
  }
  if (value === null || value === undefined || value === '') return null;
  if (type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const stamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(stamp) ? stamp : null;
  }
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const text = String(value);
  return text ? text : null;
}
function decodeField(type, value) {
  if (type === 'user') {
    // 飞书人员字段返回 [{id, name, ...}]；取第一人 open_id。
    if (Array.isArray(value)) { const first = value[0]; return first && first.id ? first.id : undefined; }
    return undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type === 'date') {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
    const raw = Array.isArray(value) ? value.map(segment => (segment && typeof segment.text === 'string' ? segment.text : '')).join('') : value;
    const text = typeof raw === 'string' ? raw : String(raw?.text ?? '');
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;
  }
  // 飞书文本字段实际返回富文本片段数组 [{ text, type:'text' }, { text, type:'mention' }, ...]，
  // 而不是纯字符串。按片段拼接出纯文本；也兼容旧版/纯字符串或单对象 { text }。
  if (Array.isArray(value)) {
    const text = value.map(segment => (segment && typeof segment.text === 'string' ? segment.text : '')).join('');
    return text ? text : undefined;
  }
  const text = typeof value === 'string' ? value : value?.text;
  return typeof text === 'string' && text ? text : undefined;
}
function encodeRecord(kind, columns, record, meta = {}) {
  const fields = {};
  for (const [key, column, type, , source] of columns) {
    let raw;
    if (source === 'creator') raw = meta.creatorOpenId;      // 创建人：首次写入的当前用户
    else if (source === 'editor') raw = meta.editorOpenId;   // 最后修改人：当前用户
    else raw = readLocalField(kind, record, key);
    // result / highFreightResult 本地是对象，飞书列存文本 → 序列化；空对象也保留。
    const value = (key === 'result' || key === 'highFreightResult') && raw && typeof raw === 'object'
      ? JSON.stringify(raw)
      : raw;
    const encoded = encodeField(type, value);
    if (encoded !== null) fields[column] = encoded;
  }
  return fields;
}
// history 记录的业务字段在本地嵌套于 values.*，但 date / mode / result / highFreightResult 在顶层。
const HISTORY_TOP_LEVEL = new Set(['date', 'mode', 'result', 'highFreightResult']);
function readLocalField(kind, record, key) {
  if (kind === 'history') return HISTORY_TOP_LEVEL.has(key) ? record?.[key] : record?.values?.[key];
  return record?.[key];
}
function writeLocalField(kind, target, key, value) {
  if (kind === 'history') {
    if (HISTORY_TOP_LEVEL.has(key)) { target[key] = value; return; }
    if (!target.values || typeof target.values !== 'object') target.values = {};
    target.values[key] = value;
  } else {
    target[key] = value;
  }
}
function keySignature(kind, record) {
  return TABLE_KEYS[kind].map(key => String(readLocalField(kind, record, key) ?? '').trim()).join('\u0001');
}

// —— HTTP ——
async function callApi(url, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) { throw Error(`无法连接飞书开放平台：${e.message}`); }
  let payload = null;
  try { payload = await response.json(); } catch { /* 网关错误时正文可能不是 JSON */ }
  if (payload?.code !== undefined && payload.code !== 0) {
    throw Error(`飞书接口返回错误 ${payload.code}：${payload.msg || '未知错误'}`);
  }
  if (!response.ok) throw Error(`飞书接口 HTTP ${response.status}`);
  return payload?.data ?? payload;
}

// —— 同步引擎 ——
export class FeishuSync {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    // 用户身份鉴权：app_access_token 用于换取/刷新 user_access_token；user 的 access_token 用于调 Bitable。
    this.appAccessTokenValue = null;
    this.appAccessTokenExpire = 0;
    this.userAccessTokenValue = null;
    this.userAccessTokenExpire = 0;
    this.currentUser = null; // { open_id, name }
    // 本地影子快照：kind -> { id -> { fields } }，字段级合并与冲突检测的依据。
    this.shadow = new Map();
    this.backfill = false; // 首次拉取后需把 record_id 回填到本地 id
    this.pushing = null; // 正在进行的后台推送 Promise，用于并发去重
    // volatile 配置是只读快照（只有 .get()，没有 .set()）；写入走 configEditor.edit，
    // 但在宿主把新值同步回 config 引用之前，用这里的覆盖值保证本进程立即读到最新配置。
    this.override = { appToken: undefined, enable: undefined, tableIds: {} };
  }

  state() {
    const settings = this.settings();
    const configured = Boolean(settings?.enable && settings?.appToken && TABLE_KINDS.every(kind => settings.tableIds[kind]));
    return { configured, pending: this.backfill || this.pendingCount() > 0, settings };
  }
  pendingCount() {
    let sum = 0;
    for (const set of this.ctx.pending.values()) sum += set.size;
    return sum;
  }

  settings() {
    let appToken = null;
    const tableIds = {};
    let enable = false;
    try {
      appToken = this.config.appToken.get();
      for (const kind of TABLE_KINDS) tableIds[kind] = this.config[`table_${kind}`].get();
      enable = this.config.enable.get();
    } catch { /* volatile 配置尚未就绪时视为未配置 */ }
    if (this.override.appToken !== undefined) appToken = this.override.appToken;
    if (this.override.enable !== undefined) enable = this.override.enable;
    for (const kind of TABLE_KINDS) {
      if (typeof this.override.tableIds[kind] === 'string' && this.override.tableIds[kind]) tableIds[kind] = this.override.tableIds[kind];
    }
    return { enable: Boolean(enable), appToken: typeof appToken === 'string' ? appToken.trim() : '', tableIds };
  }

  async credential() {
    if (!this.ctx.credentials) throw Error('宿主未提供凭据服务（credentials）。');
    const record = await this.ctx.credentials.readRecord(CREDENTIAL_KEY);
    const payload = record?.payload;
    if (record?.kind !== 'grant' || typeof payload?.appId !== 'string' || typeof payload?.appSecret !== 'string' || !payload.appId || !payload.appSecret) {
      throw Error('尚未配置飞书应用凭据，请先在设置中填写 App ID 和 App Secret。');
    }
    return payload;
  }

  async userCredential() {
    if (!this.ctx.credentials) return null;
    try {
      const record = await this.ctx.credentials.readRecord(USER_CREDENTIAL_KEY);
      const payload = record?.payload;
      if (record?.kind === 'grant' && payload && typeof payload.refreshToken === 'string' && payload.refreshToken) return payload;
    } catch { /* 未授权 */ }
    return null;
  }

  async appAccessToken() {
    if (this.appAccessTokenValue && Date.now() < this.appAccessTokenExpire) return this.appAccessTokenValue;
    const { appId, appSecret } = await this.credential();
    const data = await callApi(`${TOKEN_HOST}/open-apis/auth/v3/app_access_token/internal`, { method: 'POST', body: { app_id: appId, app_secret: appSecret } });
    const token = data?.app_access_token;
    const expire = Number(data?.expire);
    if (!token || !Number.isFinite(expire)) throw Error('飞书未返回有效的 app_access_token。');
    this.appAccessTokenValue = token;
    this.appAccessTokenExpire = Date.now() + Math.max(60, expire - 300) * 1000;
    return token;
  }

  async refreshUserToken() {
    const user = await this.userCredential();
    if (!user?.refreshToken) throw Error('尚未完成飞书个人授权，请先在设置中点击「授权飞书账号」。');
    const appToken = await this.appAccessToken();
    const data = await callApi(`${TOKEN_HOST}/open-apis/authen/v1/oidc/refresh_access_token`, {
      method: 'POST', token: appToken, body: { grant_type: 'refresh_token', refresh_token: user.refreshToken },
    });
    const access = data?.access_token;
    const expiresIn = Number(data?.expires_in);
    const refresh = data?.refresh_token || user.refreshToken;
    if (!access) throw Error('飞书用户授权已过期，请重新授权。');
    this.userAccessTokenValue = access;
    this.userAccessTokenExpire = Date.now() + Math.max(60, (Number.isFinite(expiresIn) ? expiresIn : 7200) - 300) * 1000;
    if (refresh !== user.refreshToken) {
      try {
        await this.ctx.credentials.modifyRecord(USER_CREDENTIAL_KEY, current => ({ ...(current ?? {}), kind: 'grant', payload: { ...(current?.payload ?? user), refreshToken: refresh } }));
      } catch { /* 写回失败不阻断本次使用 */ }
    }
    return access;
  }

  async accessToken() {
    if (this.userAccessTokenValue && Date.now() < this.userAccessTokenExpire) return this.userAccessTokenValue;
    return this.refreshUserToken();
  }

  /** 生成飞书授权页链接（用户点击跳转登录并同意）。未验证：authorize 端点与参数。 */
  async authorizeUrl(base) {
    const { appId } = await this.credential();
    const redirect = this.redirectUri(base);
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.oauthState = state;
    this.oauthRedirect = redirect;
    const scope = (this.ctx.oauthScope || OAUTH_SCOPE);
    return `${TOKEN_HOST}/open-apis/authen/v1/authorize?app_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}`;
  }

  redirectUri(base) {
    const root = (base && /^https?:\/\//.test(base) ? base : this.ctx.oauthBase) || 'http://127.0.0.1:63315';
    return `${root.replace(/\/$/, '')}/api/quote-workbench/oauth/callback`;
  }

  /** 用授权码换取 user_access_token，保存 refresh_token 与用户信息。未验证：端点与字段。 */
  async exchangeCode(code) {
    const value = typeof code === 'string' ? code.trim() : '';
    if (!value) throw Error('授权码为空，请重新授权或粘贴有效的 code。');
    const appToken = await this.appAccessToken();
    const data = await callApi(`${TOKEN_HOST}/open-apis/authen/v1/oidc/access_token`, {
      method: 'POST', token: appToken, body: { grant_type: 'authorization_code', code: value },
    });
    const access = data?.access_token;
    const refresh = data?.refresh_token;
    const expiresIn = Number(data?.expires_in);
    if (!access || !refresh) throw Error('飞书未返回有效的用户令牌，请重试授权。');
    this.userAccessTokenValue = access;
    this.userAccessTokenExpire = Date.now() + Math.max(60, (Number.isFinite(expiresIn) ? expiresIn : 7200) - 300) * 1000;
    let info = {};
    try {
      const me = await callApi(`${TOKEN_HOST}/open-apis/authen/v1/user_info`, { token: access });
      info = { open_id: me?.open_id ?? me?.data?.open_id ?? '', name: me?.name ?? me?.data?.name ?? '' };
    } catch { info = { open_id: '', name: '' }; }
    this.currentUser = info;
    if (!this.ctx.credentials) throw Error('宿主未提供凭据服务（credentials），无法保存授权。');
    await this.ctx.credentials.modifyRecord(USER_CREDENTIAL_KEY, () => ({ kind: 'grant', payload: { open_id: info.open_id, name: info.name, refreshToken: refresh } }));
    return { ok: true, user: info };
  }

  async logout() {
    this.userAccessTokenValue = null;
    this.userAccessTokenExpire = 0;
    this.currentUser = null;
    try { await this.ctx.credentials.deleteRecord?.(USER_CREDENTIAL_KEY); } catch { /* 忽略 */ }
    return { ok: true };
  }

  async ensureCurrentUser() {
    if (this.currentUser) return this.currentUser;
    const stored = await this.userCredential();
    if (stored) this.currentUser = { open_id: stored.open_id ?? '', name: stored.name ?? '' };
    if (this.currentUser && (this.currentUser.open_id || this.currentUser.name)) return this.currentUser;
    try {
      const token = await this.accessToken();
      const me = await callApi(`${TOKEN_HOST}/open-apis/authen/v1/user_info`, { token });
      this.currentUser = { open_id: me?.open_id ?? me?.data?.open_id ?? '', name: me?.name ?? me?.data?.name ?? '' };
    } catch { /* 取不到就用 open_id/空 */ }
    return this.currentUser ?? { open_id: '', name: '' };
  }

  async editorLabel() {
    const user = await this.ensureCurrentUser();
    return user?.name || user?.open_id || '';
  }

  /**
   * 真实的多维表格 app_token。纯 app_token（不含 /wiki/）原样使用；
   * 只有粘贴带 /wiki/<node_token> 的知识库链接才需 get_node 解析（额外需 wiki 用户权限）。
   * 未验证：get_node 参数与返回字段按官方规范实现。
   */
  async resolveAppToken() {
    const raw = this.settings().appToken;
    if (!raw) throw Error('飞书同步尚未配置 app_token，请先在设置中填写。');
    if (!/\/wiki\//.test(raw)) return raw.trim();
    if (this.resolvedAppToken && this.resolvedAppTokenRaw === raw) return this.resolvedAppToken.value;
    let nodeToken = raw.trim();
    const wikiMatch = /\/wiki\/([A-Za-z0-9]+)/.exec(raw);
    if (wikiMatch) nodeToken = wikiMatch[1];
    const token = await this.accessToken();
    const data = await callApi(`${TOKEN_HOST}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}&obj_type=wiki`, { token });
    const objToken = data?.node?.obj_token;
    const objType = data?.node?.obj_type;
    if (!objToken) throw Error('无法从知识库节点解析出多维表格 app_token，请确认该链接指向多维表格，或直接填 Base 的 app_token。');
    if (objType && objType !== 'bitable') throw Error(`该知识库节点类型是「${objType}」，不是多维表格（bitable）。`);
    this.resolvedAppToken = { value: objToken };
    this.resolvedAppTokenRaw = raw;
    return objToken;
  }

  async ensureAppToken() {
    this._appToken = await this.resolveAppToken();
    return this._appToken;
  }

  tableUrl(kind, suffix) {
    const tableId = this.settings().tableIds[kind];
    if (!tableId) throw Error('飞书同步尚未配置完整，请先在设置中保存各表 ID。');
    if (!this._appToken) throw Error('飞书同步尚未配置完整，请先解析 app_token。');
    return `${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables/${encodeURIComponent(tableId)}${suffix}`;
  }

  async listAll(kind, token) {
    const records = [];
    let pageToken = null;
    do {
      const body = { page_size: 500 };
      if (pageToken) body.page_token = pageToken;
      const data = await callApi(this.tableUrl(kind, '/records/search'), { method: 'POST', token, body }); // TODO: 分页字段名待实测
      const items = data?.items ?? [];
      for (const item of items) records.push({ recordId: item.record_id, fields: item.fields ?? {} });
      pageToken = data?.page_token ?? data?.next_page_token ?? null;
    } while (pageToken);
    return records;
  }

  /** 建表（配置保存时逐张调用；已存在则跳过）。 */
  async ensureTable(kind) {
    await this.ensureAppToken();
    const token = await this.accessToken();
    const wanted = TABLE_COLUMNS[kind].map(([, name, type, options]) => fieldDef(name, type, options));
    const list = await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables`, { token });
    const existing = (list?.items ?? []).find(table => table.name === TABLE_TITLES[kind]);
    let tableId = existing?.table_id;
    if (!tableId) {
      // 飞书「创建数据表」要求字段放在 table.fields 内（顶层 fields 会被忽略 → 只建出默认空表）。
      const created = await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables`, {
        method: 'POST', token, body: { table: { name: TABLE_TITLES[kind], default_base_app_enabled: false, fields: wanted } },
      });
      tableId = created?.table_id ?? created?.data?.table_id;
      if (!tableId) throw Error(`飞书建表「${TABLE_TITLES[kind]}」未返回 table_id。`);
      await this.saveTableId(kind, tableId);
      await this.ensureFields(kind, tableId, token);
    } else {
      if (!this.override.tableIds[kind]) {
        try { await this.saveTableId(kind, tableId); } catch { this.override.tableIds[kind] = tableId; }
      }
      await this.ensureFields(kind, tableId, token);
    }
    return tableId;
  }

  /**
   * 补全/校正字段：读取该表已有字段，缺的按定义创建；已存在但类型不符的（如旧版「最后修改人」是文本）
   * 尝试更新为正确类型。未验证：字段列表/创建/更新接口路径与载荷需实测。
   */
  async ensureFields(kind, tableId, token) {
    const wanted = TABLE_COLUMNS[kind].map(([, name, type, options]) => fieldDef(name, type, options));
    let existingFields = [];
    try {
      const list = await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables/${encodeURIComponent(tableId)}/fields?page_size=200`, { token });
      existingFields = list?.items ?? [];
    } catch { return; }
    const byName = new Map(existingFields.map(field => [field.field_name, field]));
    for (const field of wanted) {
      const cur = byName.get(field.field_name);
      if (!cur) {
        try { await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables/${encodeURIComponent(tableId)}/fields`, { method: 'POST', token, body: field }); } catch { /* 单列失败不阻断 */ }
      } else if (cur.type !== field.type) {
        // 类型不符（如文本 → 人员）→ 尝试更新字段。
        try { await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(cur.field_id)}`, { method: 'PUT', token, body: { field_name: field.field_name, type: field.type, property: field.property } }); } catch { /* 改类型失败不阻断 */ }
      }
    }
  }

  /** 只建表+字段并回写 table_id，不拉取、不推送数据。 */
  async ensureTablesOnly() {
    await this.ensureAppToken();
    const created = {};
    for (const kind of TABLE_KINDS) created[kind] = await this.ensureTable(kind);
    return { ok: true, tableIds: created, status: await this.status() };
  }

  /** 只读抽样：读取远端前 N 条记录的字段，用于验证写入结果。 */
  async sampleRemote(kind, limit = 2) {
    await this.ensureAppToken();
    const token = await this.accessToken();
    const data = await callApi(this.tableUrl(kind, '/records/search'), { method: 'POST', token, body: { page_size: limit } });
    const items = data?.items ?? [];
    return items.slice(0, limit).map(item => ({ record_id: item.record_id, fields: item.fields }));
  }

  /** 只读诊断：列出四张表在飞书端的实际字段名与类型（不改动任何数据）。 */
  async inspectTables() {
    await this.ensureAppToken();
    const token = await this.accessToken();
    let baseTables = [];
    try {
      const tl = await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables?page_size=100`, { token });
      baseTables = (tl?.items ?? []).map(t => ({ table_id: t.table_id, name: t.name }));
    } catch (error) { baseTables = [{ error: error?.message || String(error) }]; }
    const result = { baseTables };
    for (const kind of TABLE_KINDS) {
      const tableId = this.settings().tableIds[kind];
      const info = { tableId, fields: [], expected: TABLE_COLUMNS[kind].map(([, name, type, options]) => ({ name, type, options: options || null })) };
      if (tableId) {
        try {
          const list = await callApi(`${TOKEN_HOST}/open-apis/bitable/v1/apps/${encodeURIComponent(this._appToken)}/tables/${encodeURIComponent(tableId)}/fields?page_size=200`, { token });
          info.fields = (list?.items ?? []).map(field => ({ field_id: field.field_id, field_name: field.field_name, type: field.type, ui_type: field.ui_type, property: field.property }));
        } catch (error) { info.error = error?.message || String(error); }
      }
      result[kind] = info;
    }
    return result;
  }

  async saveTableId(kind, tableId) {
    const editor = this.ctx.get ? this.ctx.get('configEditor') : this.ctx.configEditor;
    if (!editor) throw Error('宿主未提供配置编辑服务，无法保存表 ID。');
    const entry = this.ctx.fiber?.entry;
    if (!entry) throw Error('缺少插件配置入口，无法保存表 ID。');
    const target = `table_${kind}`;
    await editor.edit(entry, current => ({ ...current, [target]: tableId }));
    this.override.tableIds[kind] = tableId;
  }

  /** 保存飞书应用凭据（app_id / app_secret → credentials 记录）。 */
  async saveCredential(record) {
    const appId = typeof record?.appId === 'string' ? record.appId.trim() : '';
    const appSecret = typeof record?.appSecret === 'string' ? record.appSecret.trim() : '';
    if (!appId || !appSecret) throw Error('App ID 和 App Secret 不能为空。');
    await this.ctx.credentials.modifyRecord(CREDENTIAL_KEY, current => {
      const previous = current?.payload ?? {};
      if (current && current.kind !== 'grant') return undefined;
      return { kind: 'grant', payload: { ...previous, appId, appSecret } };
    });
    this.appAccessTokenValue = null;
    this.appAccessTokenExpire = 0;
  }

  // —— 拉取：影子快照 + 字段级合并 + 冲突检测 ——
  async pull() {
    await this.ensureAppToken();
    const token = await this.accessToken();
    const db = structuredClone(this.ctx.storage.get());
    const remoteIds = {};
    for (const kind of TABLE_KINDS) {
      const remote = await this.listAll(kind, token);
      const localByKey = new Map(db[kind].map(record => [keySignature(kind, record), record]));
      const byId = new Map(db[kind].map(record => [record.id, record]));
      const previousShadow = this.shadow.get(kind) ?? new Map();
      const nextShadow = new Map();
      remoteIds[kind] = new Set();
      for (const row of remote) {
        remoteIds[kind].add(row.recordId);
        const columns = TABLE_COLUMNS[kind];
        const remoteRecord = {};
        for (const [key, column, type, , source] of columns) {
          if (source === 'creator' || source === 'editor') continue; // 人员列不写回本地业务记录
          const decoded = decodeField(type, row.fields[column]);
          if (decoded === undefined) continue;
          if ((key === 'result' || key === 'highFreightResult') && typeof decoded === 'string') {
            try { remoteRecord[key] = JSON.parse(decoded); } catch { remoteRecord[key] = decoded; }
          } else {
            remoteRecord[key] = decoded;
          }
        }
        let local = byId.get(row.recordId);
        if (!local) {
          const key = keySignature(kind, remoteRecord);
          const candidate = localByKey.get(key);
          if (candidate && !previousShadow.has(candidate.id)) {
            local = candidate;
            candidate.id = row.recordId;
            byId.set(candidate.id, candidate);
          }
        }
        const shadowBefore = local ? previousShadow.get(local.id) : undefined;
        const merged = this.mergeRecord(kind, local ?? null, shadowBefore, remoteRecord, row.recordId);
        if (merged.created && merged.record) db[kind].push(merged.record);
        if (local) nextShadow.set(local.id, remoteRecord);
        else if (merged.record) nextShadow.set(merged.record.id, remoteRecord);
      }
      for (const local of db[kind]) {
        if (!remoteIds[kind].has(local.id)) this.ctx.pending.get(kind)?.add(local.id);
      }
      this.shadow.set(kind, nextShadow);
    }
    await this.ctx.storage.set(db);
    if (this.backfill) this.backfill = false;
    return remoteIds;
  }

  /** 字段级合并：远端改动覆盖本地未被本地改动过的字段；两端都改过记冲突（本地优先）。 */
  mergeRecord(kind, local, shadowBefore, remoteRecord, recordId) {
    const columns = TABLE_COLUMNS[kind];
    if (!local) {
      const record = { id: recordId };
      for (const [key, , , , source] of columns) { if (source === 'creator' || source === 'editor') continue; writeLocalField(kind, record, key, remoteRecord[key]); }
      return { created: true, record };
    }
    const conflicts = [];
    const changed = {};
    const emptyRemote = value => value === undefined || value === null || value === '';
    for (const [key, column, type, , source] of columns) {
      if (source === 'creator' || source === 'editor') continue;
      const localValue = readLocalField(kind, local, key);
      const shadowValue = shadowBefore ? decodeField(type, shadowBefore[column] ?? shadowBefore[key]) : undefined;
      const remoteValue = remoteRecord[key];
      const localChanged = !fieldEqual(localValue, shadowValue);
      const remoteChanged = !fieldEqual(remoteValue, shadowValue);
      if (remoteChanged && emptyRemote(remoteValue) && !emptyRemote(localValue)) continue;
      if (localChanged && remoteChanged && !fieldEqual(localValue, remoteValue)) conflicts.push({ key, local: localValue, remote: remoteValue });
      else if (remoteChanged && !localChanged) changed[key] = remoteValue;
    }
    for (const [key, value] of Object.entries(changed)) writeLocalField(kind, local, key, value);
    if (conflicts.length) {
      this.ctx.conflicts.push({
        kind, id: local.id,
        name: String(readLocalField(kind, local, TABLE_KEYS[kind][0]) ?? ''),
        fields: conflicts.map(item => ({ key: item.key, local: item.local, remote: item.remote })),
      });
    }
    return { updated: true, conflicts };
  }

  // —— 推送：本地挂起记录 → 飞书（失败时保持挂起） ——
  async push(kind, records) {
    await this.ensureAppToken();
    const token = await this.accessToken();
    const user = await this.ensureCurrentUser();
    const meta = { creatorOpenId: user?.open_id || '', editorOpenId: user?.open_id || '' };
    const columns = TABLE_COLUMNS[kind];
    const results = { done: [], retry: [] };
    const creates = records.filter(record => record.__new);
    const updates = records.filter(record => !record.__new);
    if (creates.length) {
      const body = { records: creates.map(record => ({ fields: encodeRecord(kind, columns, record.record, meta) })) };
      const data = await callApi(this.tableUrl(kind, '/records/batch_create'), { method: 'POST', token, body }); // TODO: 负载格式待实测
      const ids = (data?.records ?? []).map(item => item?.record_id);
      creates.forEach((entry, index) => {
        if (ids[index]) { entry.record.id = ids[index]; results.done.push(entry.record); }
        else results.retry.push(entry.record);
      });
    }
    if (updates.length) {
      // 更新时不覆盖创建人：仅写最后修改人。
      const updateMeta = { creatorOpenId: undefined, editorOpenId: user?.open_id || '' };
      const body = { records: updates.map(entry => ({ record_id: entry.record.id, fields: encodeRecord(kind, columns, entry.record, updateMeta) })) };
      const data = await callApi(this.tableUrl(kind, '/records/batch_update'), { method: 'POST', token, body }); // TODO: 负载格式待实测
      const okIds = new Set((data?.records ?? []).map(item => item?.record_id).filter(Boolean));
      for (const entry of updates) (okIds.has(entry.record.id) ? results.done : results.retry).push(entry.record);
    }
    return results;
  }

  async deleteRemote(kind, ids) {
    await this.ensureAppToken();
    const token = await this.accessToken();
    await callApi(this.tableUrl(kind, '/records/batch_delete'), { method: 'POST', token, body: { records: ids } }); // TODO: 负载格式待实测
  }

  // —— service 集成接口 ——

  /** 记录本地改动到待同步集合；只做内存操作，不发网络。 */
  mark(action, kind, ids) {
    if (!TABLE_KINDS.includes(kind)) return;
    if (action === 'delete') {
      const set = this.ctx.deleted.get(kind);
      for (const id of ids) { set.add(id); this.ctx.pending.get(kind).delete(id); }
      return;
    }
    const set = this.ctx.pending.get(kind);
    for (const id of ids) { set.add(id); this.ctx.deleted.get(kind).delete(id); }
  }

  schedulePush() {
    if (!this.ctx.storageDomain) return;
    if (this.pushing) return;
    if (!this.settings().enable) return;
    this.pushing = this.pushLoop().catch(() => {}).finally(() => { this.pushing = null; });
  }

  async pushLoop() {
    for (const kind of TABLE_KINDS) {
      const del = this.ctx.deleted.get(kind);
      if (!del.size) continue;
      const known = this.shadow.get(kind) ?? new Map();
      const remoteIds = [...del].filter(id => typeof id === 'string' && known.has(id));
      try {
        if (remoteIds.length) await this.deleteRemote(kind, remoteIds);
        for (const id of remoteIds) { del.delete(id); known.delete(id); }
        for (const id of [...del]) if (!known.has(id)) del.delete(id);
      } catch { /* 保留待同步标记，下次重试 */ }
    }
    const db = structuredClone(this.ctx.storage.get());
    let dirty = false;
    for (const kind of TABLE_KINDS) {
      const set = this.ctx.pending.get(kind);
      if (!set.size) continue;
      const byId = new Map(db[kind].map(row => [row.id, row]));
      const known = this.shadow.get(kind) ?? new Map();
      const records = [];
      for (const id of set) {
        const row = byId.get(id);
        if (!row) { set.delete(id); continue; }
        records.push({ record: row, __new: !known.has(id) });
      }
      if (!records.length) continue;
      try {
        const rows = new Map(records.map(entry => [entry.record, { row: entry.record, oldId: entry.record.id }]));
        const results = await this.push(kind, records);
        for (const record of results.done) {
          const info = rows.get(record);
          const oldId = info?.oldId ?? record.id;
          if (record.id !== oldId) { dirty = true; set.delete(oldId); }
          else set.delete(record.id);
          this.rememberShadow(kind, record);
        }
      } catch { /* 整体失败：全部保留待同步 */ }
    }
    if (dirty) {
      try { await this.ctx.storage.set(db); } catch { /* 落盘失败下次再同步 */ }
    }
  }

  rememberShadow(kind, record) {
    const shadow = this.shadow.get(kind) ?? new Map();
    const fields = encodeRecord(kind, TABLE_COLUMNS[kind], record, {});
    shadow.set(record.id, fields);
    this.shadow.set(kind, shadow);
  }

  async credentialInfo() {
    try {
      const record = await this.ctx.credentials.readRecord(CREDENTIAL_KEY);
      const payload = record?.payload;
      if (record?.kind === 'grant' && typeof payload?.appId === 'string' && payload.appId) {
        return { configured: true, appId: payload.appId };
      }
    } catch { /* 读不到凭据时按未配置处理 */ }
    return { configured: false, appId: '' };
  }

  async status() {
    const user = await this.userCredential();
    return {
      ...this.state(),
      conflicts: this.ctx.conflicts.slice(),
      pendingRecords: this.pendingSnapshot(),
      credential: await this.credentialInfo(),
      user: user ? { authorized: true, open_id: user.open_id ?? '', name: user.name ?? '' } : { authorized: false, open_id: '', name: '' },
    };
  }

  pendingSnapshot() {
    const db = structuredClone(this.ctx.storage.get());
    const rows = [];
    for (const kind of TABLE_KINDS) {
      const byId = new Map(db[kind].map(row => [row.id, row]));
      for (const id of this.ctx.pending.get(kind)) {
        const row = byId.get(id);
        if (row) rows.push({ kind, id, name: String(readLocalField(kind, row, TABLE_KEYS[kind][0]) ?? '') });
      }
      for (const id of this.ctx.deleted.get(kind)) rows.push({ kind, id, name: '', deleted: true });
    }
    return rows;
  }

  /** 保存凭据与 app_token、建表；成功后做一次全量拉取。 */
  async setup(input) {
    if (input.credential) await this.saveCredential(input.credential);
    const editor = this.ctx.get ? this.ctx.get('configEditor') : this.ctx.configEditor;
    const entry = this.ctx.fiber?.entry;
    if (!editor || !entry) throw Error('宿主未提供配置编辑服务，无法保存飞书配置。');
    const next = {};
    if (typeof input.appToken === 'string') next.appToken = input.appToken.trim();
    if (input.enable !== undefined) next.enable = Boolean(input.enable);
    if (Object.keys(next).length) {
      await editor.edit(entry, current => ({ ...current, ...next }));
      if (next.appToken !== undefined) this.override.appToken = next.appToken;
      if (next.enable !== undefined) this.override.enable = next.enable;
    }
    const settings = this.settings();
    if (settings.appToken && settings.enable) {
      try {
        for (const kind of TABLE_KINDS) await this.ensureTable(kind);
        this.shadow.clear();
        this.backfill = true;
        await this.pull();
        this.ctx.conflicts.length = 0;
      } catch (error) {
        const status = await this.status();
        return { ...status, warning: error?.message || '建表或拉取失败，请检查授权与 app_token。' };
      }
    }
    return this.status();
  }

  /** 手动同步：全量拉取 + 推送待同步。 */
  async now() {
    if (!this.settings().enable) throw Error('请先在设置中启用飞书同步并填写 app_token。');
    this.ctx.conflicts.length = 0;
    await this.pull();
    this.schedulePush();
    return this.status();
  }

  /** 解决冲突：field 级选择本地或远端值；重算后写回。 */
  async resolve(input) {
    const { kind, id, choices } = input ?? {};
    if (!TABLE_KINDS.includes(kind)) throw Error('无效的记录类型');
    const db = structuredClone(this.ctx.storage.get());
    const row = db[kind].find(item => item.id === id);
    if (!row) throw Error('记录不存在，请刷新');
    const conflict = this.ctx.conflicts.find(item => item.kind === kind && item.id === id);
    if (!conflict) return this.status();
    for (const field of conflict.fields) {
      const pick = choices?.[field.key];
      if (pick === 'remote') writeLocalField(kind, row, field.key, field.remote);
    }
    await this.ctx.storage.set(db);
    this.ctx.conflicts = this.ctx.conflicts.filter(item => !(item.kind === kind && item.id === id));
    this.mark('update', kind, [id]);
    this.schedulePush();
    return this.status();
  }
}

/** 把列定义转换成飞书字段创建/更新载荷。未验证：人员(11)、日期(5)、单选(3) 的 property 结构需实测。 */
function fieldDef(name, type, options) {
  const def = { field_name: name, type: FIELD_TYPE_ENUM[type] ?? 1 };
  if (type === 'enum') def.property = { options: options.map(option => ({ name: option })) };
  if (type === 'user') def.property = { multiple: false }; // 单选人员
  return def;
}

function fieldEqual(local, remote) {
  if (local === remote) return true;
  if (local === null || local === undefined) return remote === null || remote === undefined || remote === '';
  if (remote === null || remote === undefined) return local === '';
  // 数字（含数字字符串）用容差比较：飞书数字字段会截断浮点末位，不能按字符串严格比较，
  // 否则精度噪声会被误判为“两端都改过”。
  const ln = typeof local === 'number' ? local : (typeof local === 'string' && local.trim() !== '' && Number.isFinite(Number(local)) ? Number(local) : null);
  const rn = typeof remote === 'number' ? remote : (typeof remote === 'string' && remote.trim() !== '' && Number.isFinite(Number(remote)) ? Number(remote) : null);
  if (ln !== null && rn !== null) {
    if (ln === rn) return true;
    const diff = Math.abs(ln - rn);
    const scale = Math.max(Math.abs(ln), Math.abs(rn), 1);
    return diff <= scale * 1e-9 || diff <= 1e-9;
  }
  return String(local) === String(remote);
}
