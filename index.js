import { z } from 'zod';
import { QuoteWorkbench } from './service.js';
import { validateDatabase } from './domain.js';

export const inject = ['storageDomain', 'connection', 'tools', 'llm'];
export async function apply(ctx) {
  const schema = z.object({
    revision: z.number().int().nonnegative(),
    factories: z.array(z.record(z.string(), z.unknown())),
    freights: z.array(z.record(z.string(), z.unknown())),
    history: z.array(z.record(z.string(), z.unknown())),
    products: z.array(z.record(z.string(), z.unknown())).default([]),
    settings: z.object({ provider: z.string().min(1), model: z.string().min(1) }).nullable().default(null),
  }).superRefine((value, context) => {
    try { validateDatabase(value); } catch (error) { context.addIssue({ code: 'custom', message: error.message }); }
  });
  const domain = await ctx.storageDomain.open({
    name: 'quote_workbench', version: 1, tables: {},
    global: { schema, initial: { revision: 0, factories: [], freights: [], history: [], products: [], settings: null } },
  });
  ctx.effect(() => () => domain.close());
  const defaultSelection = () => {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection();
      return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null;
    } catch { return null; }
  };
  const service = new QuoteWorkbench(domain.global, ctx.llm, defaultSelection);
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
    description: '管理报价工作台的工厂报价、货代报价、核算记录和产品目录，或用大模型解析报价文本、计算利润、查询信保费率。schema 返回字段定义；list/export 返回全部记录及 revision；settings 返回当前解析模型；models 列出 Harness 可用模型。parse 使用设置中选择的模型。quotation 根据单个或 items 多个核算数据生成可编辑 Excel 报价单（多个产品合并为一张英文 Quotation，并逐个生成内部 Costing 页），返回文件名与 base64 内容。saveSettings 修改解析模型，provider 和 model 都省略表示跟随 Harness 默认模型。import 替换全部记录。写入前先读取记录，取得 revision。产品目录的货物危险性从工厂报价按 CAS 汇集，手工目录值优先；工厂报价输入已有 CAS 时会自动代入目录中的货物危险性。',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['schema','list','export','parse','settings','models','saveSettings','credit','average','calculate','quotation','add','update','delete','import'] },
        kind: { type: 'string', enum: ['factories','freights','history','products'], description: 'add/delete 的记录类型；update 支持 factories、products 和 history。' },
        revision: { type: 'integer', description: 'add/update/delete/import/saveSettings 必填，使用最新 list 返回的 revision。' },
        id: { type: 'string', description: 'update/delete 的记录 id。' },
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
