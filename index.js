import { z } from 'zod';
import schema from '@deepseek-ai/schemastery';
import { QuoteWorkbench } from './service.js';
import { FeishuSync } from './feishu.js';

export const inject = ['storageDomain', 'connection', 'tools', 'llm', 'credentials'];

// 飞书同步配置。全部声明为 volatile：保存这些字段只在内存生效、不重启插件，
// 便于在设置面板里随时改 app_token / 表 ID / 开关而不用重载。App ID 与 App Secret
// 属于机密，走 credentials 记录（quote-workbench/feishu），不进配置文件。
export const Config = schema.object({
  enable: schema.boolean().default(false).volatile(),
  appToken: schema.string().default('').volatile(),
  table_factories: schema.string().default('').volatile(),
  table_freights: schema.string().default('').volatile(),
  table_history: schema.string().default('').volatile(),
  table_products: schema.string().default('').volatile(),
});

export async function apply(ctx, config) {
  // 仅校验存储的“形状”（顶层字段与类型），不在此处对每条业务记录做严格校验。
  // 原因：storageDomain.open 会在插件启动时用此 schema 校验已持久化的数据；若历史数据里存在
  // 不完整或旧版本的记录（例如飞书同步早期从文字列为空的 Bitable 拉下的记录），严格校验会让
  // 整个插件无法激活（表现为面板空白）。改为启动时宽容兼容：已有数据总能加载，用户仍可在界面里
  // 查看/修复/导出。新增与导入仍由 service.js 的 validateRecord / validateDatabase 严格校验。
  const dbSchema = z.object({
    revision: z.number().int().nonnegative(),
    factories: z.array(z.record(z.string(), z.unknown())),
    freights: z.array(z.record(z.string(), z.unknown())),
    history: z.array(z.record(z.string(), z.unknown())),
    products: z.array(z.record(z.string(), z.unknown())).default([]),
    settings: z.object({ provider: z.string().min(1), model: z.string().min(1) }).nullable().default(null),
  });
  const domain = await ctx.storageDomain.open({
    name: 'quote_workbench', version: 1, tables: {},
    global: { schema: dbSchema, initial: { revision: 0, factories: [], freights: [], history: [], products: [], settings: null } },
  });
  ctx.effect(() => () => domain.close());
  const defaultSelection = () => {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection();
      return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null;
    } catch { return null; }
  };

  // 同步上下文：FeishuSync 借此访问本地库、凭据、配置编辑与待同步/冲突状态。
  const pending = new Map([['factories', new Set()], ['freights', new Set()], ['history', new Set()], ['products', new Set()]]);
  const deleted = new Map([['factories', new Set()], ['freights', new Set()], ['history', new Set()], ['products', new Set()]]);
  const syncCtx = {
    storage: domain.global,
    storageDomain: domain,
    credentials: ctx.credentials,
    configEditor: ctx.get('configEditor'),
    fiber: ctx.fiber,
    get: name => ctx.get(name),
    pending,
    deleted,
    conflicts: [],
  };
  const sync = new FeishuSync(syncCtx, config);
  const service = new QuoteWorkbench(domain.global, ctx.llm, defaultSelection, sync);

  // 启动后做一次全量拉取（配置完整时），并每约 2 分钟增量拉取；定时器随插件卸载清理。
  ctx.effect(() => {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        if (sync.settings().enable) { syncCtx.conflicts.length = 0; await sync.pull(); }
      } catch { /* 拉取失败只保留待同步标记，不打断本地使用 */ }
    };
    const start = () => {
      if (stopped) return;
      if (sync.settings().enable) {
        sync.backfill = true;
        tick();
        timer = setInterval(tick, 120_000);
      }
    };
    // 等一个事件循环再启动，确保配置已解析。
    const boot = setTimeout(start, 0);
    return () => {
      stopped = true;
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  });

  // OAuth 回调：飞书授权后浏览器被重定向到这里，带 ?code=。换取用户令牌后展示结果页。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/quote-workbench/oauth/callback', methods: ['GET'],
    async fetch(request) {
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      const html = (title, message) => new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;padding:40px;line-height:1.6;color:#222}</style></head><body><h2>${title}</h2><p>${message}</p><p>可以关闭此页面，回到报价工作台继续操作。</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      if (!code) return html('授权未完成', '未收到授权码 code。请回到报价工作台重新点击「授权飞书账号」，或用「粘贴授权码」方式。');
      try {
        const user = await sync.exchangeCode(code);
        return html('授权成功', `已授权飞书账号：${(user && user.user && (user.user.name || user.user.open_id)) || ''}。`);
      } catch (error) {
        return html('授权失败', String(error?.message || '未知错误'));
      }
    },
  }));

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  // Exact route on the shared, authenticated /api channel used by the Web GUI.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/quote-workbench', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const text = await request.text();
        if (text.length > 10_000_000) return json({ error: '备份超过 10 MB' }, 413);
        let input;
        try { input = JSON.parse(text); }
        catch { return json({ error: '请求内容不是有效 JSON' }, 400); }
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
        return json({ value: await service.execute(input, signal) });
      } catch (error) { return json({ error: error?.message || '操作失败' }, 400); }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'quote_workbench',
    description: '管理报价工作台的工厂报价、货代报价、核算记录和产品目录，或用大模型解析报价文本、计算利润、查询信保费率。schema 返回字段定义；list/export 返回全部记录及 revision；settings 返回当前解析模型；models 列出 Harness 可用模型。parse 使用设置中选择的模型。quotation 根据单个或 items 多个核算数据生成可编辑 Excel 报价单（多个产品合并为一张英文 Quotation，并逐个生成内部 Costing 页），返回文件名与 base64 内容。saveSettings 修改解析模型，provider 和 model 都省略表示跟随 Harness 默认模型。import 替换全部记录。写入前先读取记录，取得 revision。产品目录的货物危险性从工厂报价按 CAS 汇集，手工目录值优先；工厂报价输入已有 CAS 时会自动代入目录中的货物危险性。syncStatus/syncSetup/syncNow/syncResolve/syncAuthUrl/syncAuth/syncLogout 管理飞书同步：采用飞书用户身份（OAuth 个人授权）；setup 保存应用凭据与 app_token 并建表，authUrl 生成授权链接、auth 用授权码换用户令牌、logout 退出授权，now 执行一次全量拉取加推送，resolve 按字段解决冲突（本地优先）。',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['schema','list','export','parse','settings','models','saveSettings','credit','average','calculate','quotation','add','update','delete','import','syncStatus','syncSetup','syncNow','syncResolve','syncAuthUrl','syncAuth','syncLogout','syncInspect','syncEnsureTables','syncSample'] },
        kind: { type: 'string', enum: ['factories','freights','history','products'], description: 'add/delete 的记录类型；update 支持 factories、products 和 history。' },
        revision: { type: 'integer', description: 'add/update/delete/import/saveSettings 必填，使用最新 list 返回的 revision。' },
        id: { type: 'string', description: 'update/delete 的记录 id；syncResolve 的冲突记录 id。' },
        record: { type: 'object', additionalProperties: true, description: 'add/update 的记录；字段见 schema。products 传 name 和 cas，可选 hazard（货物危险性）、tax、rebate；product update 保留 id。history update 传 mode 和 values，服务端重算结果并保留原记录 id 和日期。工厂 update 保留 id 和 createdAt。货代报价传 agent、origin、destination、transportMode、valid、sea、local；整柜再传 containerType，拼箱/空运再传 quantity 和 quantityUnit；拼箱可选传 bulky（是/否），bulky 为「是」时须传 volume（CBM）。history 传 mode 和 values，结果由服务计算；customerTerm 为对客条款，旧 term 不作为对客条款。' },
        override: { type: 'boolean', description: 'products add 时，若该 CAS 已由报价或核算派生，可传 true 保存手工目录覆盖。' },
        data: { type: 'object', additionalProperties: true, description: 'import 的完整备份，包含 factories、freights、history、products 数组；旧备份缺少 products 时默认为空；旧货代报价的 route/basis 仍可导入；替换现有记录。' },
        mode: { type: 'string', enum: ['rmb','usd','own'], description: 'calculate 的核算模式。' },
        values: { type: 'object', additionalProperties: true, description: 'calculate 的数值，字段见 schema；RMB 需 seaMax 和 rebate，自有工厂倒推需 receive、seaMax、tax 和 rebate。' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'quotation 的多产品数组，每项传 mode、values 和 factoryId 或 factory；同一客户才能合并。' },
        includeCosting: { type: 'boolean', description: 'quotation 是否包含内部成本数据；默认 true，false 时只生成客户 Quotation。' },
        factoryId: { type: 'string', description: 'quotation 可选关联的已保存工厂报价 id，用于展示工厂、规格包装和交期。' },
        raw: { type: 'string', description: 'parse 的报价文本或从 Excel 复制的制表符表格。' },
        provider: { type: 'string', description: 'saveSettings 的模型提供方 id，与 model 一起省略表示跟随 Harness 默认模型。' },
        model: { type: 'string', description: 'saveSettings 的模型 id。' },
        country: { type: 'string', description: 'credit 的 ISO 三字母国家代码，如 USA。' },
        months: { type: 'number', description: 'credit 的账期月数，每月按30天。' },
        payment: { type: 'string', enum: ['L/C','D/P','D/A 或 O/A'] },
        rows: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'average 的货代记录，需同起运地、同目的地、同运输方式、同柜型或同询价数量（抛货含体积），并在有效期内。' },
        today: { type: 'string', description: 'average 比较日期 YYYY-MM-DD，默认今天。' },
        credential: { type: 'object', additionalProperties: true, description: 'syncSetup 的飞书应用凭据，含 appId 与 appSecret；省略则沿用已保存凭据。' },
        appToken: { type: 'string', description: 'syncSetup 的飞书多维表格 app_token。' },
        enable: { type: 'boolean', description: 'syncSetup 是否启用飞书同步。' },
        choices: { type: 'object', additionalProperties: true, description: 'syncResolve 的字段选择：{ 字段名: "local" | "remote" }。' },
        code: { type: 'string', description: 'syncAuth 的飞书授权码（授权后回调 URL 里的 code，或手动粘贴）。' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => {
      if (args.action === 'saveSettings') {
        const settings = args.provider && args.model ? { provider: args.provider, model: args.model } : null;
        return service.execute({ action: 'saveSettings', revision: args.revision, settings }, exec.signal);
      }
      return service.execute(args, exec.signal);
    },
  }));
}
