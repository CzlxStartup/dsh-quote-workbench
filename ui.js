// Bundled with domain.js by build.mjs; React is provided by Harness.
function createUI(React, ctx, t, css) {
  const h = React.createElement;
  const { useState, useEffect, useRef, useSyncExternalStore } = React;
  const fmt = n => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 4, minimumFractionDigits: 2 }) : '—';
  const emptyForm = defs => Object.fromEntries(defs.map(([key,, type]) => [key, Array.isArray(type) ? type[0] : type === 'number' ? null : '']));
  const ordered = (defs, order) => [...defs].sort((a, b) => { const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  // Frequently used fields come first so each page opens on its working set.
  const basicOrder = ['product','cas','customer','qty','sell','transportMode','customerTerm','place','quoteCountry','creditMonths','creditPayment'];
  const calcOrder = ['buy','fx','receive','sea','seaMax','local','tax','rebate','transport','credit','interest','months'];
  const factoryOrder = ['name','cas','price','currency','unit','incoterm','port','rebate','quoteDate','validity','delivery','factory','quantity','loading','packing','warehouse','portfee','details'];
  const range = (a, b, format = fmt) => a === b ? format(a) : `${format(Math.min(a,b))} ～ ${format(Math.max(a,b))}`;
  const factoryForm = row => ({ ...emptyForm(factoryFields), ...row, quoteDate: normalizeFactoryDate(row?.quoteDate), validity: normalizeFactoryDate(row?.validity) });
  const usableFactory = row => row && ['RMB','USD'].includes(row.currency) && ['吨','公斤'].includes(row.unit) && Number.isFinite(Number(row.price)) && Number(row.price) > 0;
  const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录';
  const modeLabels = { rmb: '人民币采购', usd: '美元采购', own: '自有工厂倒推' };
  async function api(input, signal) {
    const response = await fetch('/api/quote-workbench', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
    return result.value;
  }
  function Icon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 4, y: 2, width: 16, height: 20, rx: 3 }), h('path', { d: 'M8 7h8M8 11h3M8 16h4m-2-2v4m4-2h3' }));
  }
  function Fields({ defs, value, onChange, disabled = [], hidden = [], labels = {} }) {
    return h('div', { className: 'qw-grid' }, defs.filter(([id]) => !hidden.includes(id)).map(([id, label, type]) => {
      const options = id === 'quoteCountry' ? [['', t('请选择国家 / 地区')], ...creditCountries.map(c => [c.code, `${c.label} · ${c.code}`])] : Array.isArray(type) ? type.map(x => [x, t(x)]) : null;
      const props = { value: value[id] ?? '', disabled: disabled.includes(id), onChange: e => onChange(id, type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value) };
      return h('label', { key: id, className: id === 'details' ? 'qw-field-wide' : undefined }, h('span', null, t(labels[id] || label)), options ? h('select', props, options.map(([key, text]) => h('option', { key, value: key }, text))) : id === 'details' ? h('textarea', { ...props, rows: 3 }) : h('input', { ...props, type, ...(type === 'number' ? { min: 0, step: 'any' } : {}) }));
    }));
  }
  function App() {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const [db, setDb] = useState(null), [tab, setTab] = useState('factory'), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
    const [mode, setMode] = useState('rmb'), [v, setV] = useState({ ...defaults, fx: null, seaMax: null });
    const [factory, setFactory] = useState(emptyForm(factoryFields)), [freight, setFreight] = useState(emptyForm(freightFields));
    const [raw, setRaw] = useState(''), [pending, setPending] = useState([]), [index, setIndex] = useState(0), [selected, setSelected] = useState([]), [source, setSource] = useState('');
    const [parseModel, setParseModel] = useState(null), [parsing, setParsing] = useState(false);
    const [editing, setEditing] = useState(null), [product, setProduct] = useState({ name: '', cas: '' }), [catalogSearch, setCatalogSearch] = useState('');
    const fileInput = useRef(null), lock = useRef(false), autofill = useRef({ calc: '', factory: '' });
    const products = db ? catalogProducts(db) : [];
    const sources = db ? db.factories.filter(row => usableFactory(row) && row.currency === ({ rmb: 'RMB', usd: 'USD' })[mode] && (!normalizeCas(v.cas) || normalizeCas(row.cas) === normalizeCas(v.cas))) : [];
    const activeSource = sources.find(row => row.id === source);
    useEffect(() => { if (source && !activeSource) setSource(''); }, [source, activeSource]);
    function casFields(old, value, key, scope) {
      const match = normalizeCas(value) && products.find(row => normalizeCas(row.cas) === normalizeCas(value));
      const name = match ? match.name : old[key] === autofill.current[scope] ? '' : old[key];
      autofill.current[scope] = match ? match.name : '';
      return { ...old, cas: value, [key]: name };
    }
    function changeFactory(key, value) {
      setFactory(old => key === 'cas' ? casFields(old, value, 'name', 'factory') : { ...old, [key]: value });
    }
    function resetFactory() { setEditing(null); setPending([]); setIndex(0); setFactory(factoryForm()); setRaw(''); autofill.current.factory = ''; }
    function editFactory(row) { setEditing(row.id); setPending([]); setIndex(0); setFactory(factoryForm(row)); setRaw(row.raw || ''); autofill.current.factory = ''; setTab('factory'); setMessage(t('正在编辑已保存的报价。')); }
    function acceptParsed(records) {
      setEditing(null); setPending(records); setIndex(0); autofill.current.factory = '';
      setFactory(factoryForm(records[0]));
    }
    useEffect(() => {
      const controller = new AbortController();
      Promise.all([api({ action: 'list' }, controller.signal), api({ action: 'settings' }, controller.signal)])
        .then(([next, settings]) => { setDb(next); setParseModel({ label: settings.effective?.label ?? null }); })
        .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
      return () => controller.abort();
    }, []);
    async function run(fn) {
      if (lock.current) return;
      lock.current = true; setBusy(true); setError(''); setMessage('');
      try { await fn(); } catch (e) { setError(e.message); } finally { lock.current = false; setBusy(false); }
    }
    async function mutate(input) { const next = await api({ ...input, revision: db.revision }); setDb(next); setSelected([]); setMessage(t('已保存。')); }
    const button = (text, onClick, extra = {}) => h('button', { type: 'button', disabled: busy, onClick, ...extra }, t(text));
    const note = text => h('p', { className: 'qw-note' }, text);
    const card = (title, ...children) => h('section', { className: 'qw-card' }, h('div', { className: 'qw-card-head' }, h('h2', null, t(title))), ...children);
    function start(next, data = {}) { setMode(next); setV({ ...defaults, ...data, customerTerm: data.customerTerm || '待确认', seaMax: data.seaMax ?? data.sea ?? null, ...(next === 'rmb' ? { fx: data.fx ?? null } : {}) }); autofill.current.calc = ''; setSource(''); setMessage(''); }
    function change(id, value) {
      if (id === 'cas') setSource('');
      setV(old => { const next = id === 'cas' ? casFields(old, value, 'product', 'calc') : { ...old, [id]: value }; if (['quoteCountry','creditMonths','creditPayment'].includes(id)) next.credit = lookupCreditRate(next.quoteCountry, next.creditMonths, next.creditPayment)?.rate ?? null; return next; });
    }
    function useFactory(row, keepMode = false) {
      if (!usableFactory(row)) return;
      const nextMode = row.currency === 'RMB' ? 'rmb' : 'usd';
      if (keepMode && (nextMode !== mode || !sources.some(item => item.id === row.id))) { setError(t('请选择与当前采购币种及 CAS 相符的报价。')); return; }
      start(keepMode ? mode : nextMode, { ...v, product: row.name, cas: row.cas || '', buy: Number(row.price) / (row.unit === '吨' ? 1000 : 1), place: row.port || '', rebate: row.rebate ?? null });
      setSource(row.id); setTab('calc'); setMessage(`${t('已带入工厂报价，请核对国内费用。')} ${t('进仓费承担方')}: ${row.warehouse || '待确认'} · ${t('港杂费承担方')}: ${row.portfee || '待确认'}`);
    }
    function remove(kind, row) { if (window.confirm(t('删除这条记录？'))) run(() => mutate({ action: 'delete', kind, id: row.id })); }
    const credit = lookupCreditRate(v.quoteCountry, v.creditMonths, v.creditPayment);
    const ready = validateCalculation(v, mode);
    const result = ready ? calculate(v, mode) : null;
    const high = ready && mode === 'rmb' ? calculate({ ...v, sea: v.seaMax }, mode) : result;
    const costReady = mode === 'rmb' && v.qty > 0 && v.fx > 0 && [v.buy,v.tax,v.sea,v.seaMax,v.local].every(n => Number.isFinite(n) && n >= 0) && validRebate(v.rebate) && v.seaMax >= v.sea;
    const deduction = [v.transport,v.credit,v.interest,v.months].every(n => Number.isFinite(n) && n >= 0) ? 1 - (1.1*v.transport+v.credit+v.interest/12*v.months)/100 : 0;
    const metric = (label, value) => h('div', { className: 'qw-metric', key: label }, h('span', null, t(label)), h('strong', null, value));
    function results() {
      const parts = [];
      if (costReady) {
        const low = calculate({ ...v, sell: 0 }, 'rmb').landed, upper = calculate({ ...v, sell: 0, sea: v.seaMax }, 'rmb').landed;
        parts.push(metric('FCA 成本 USD/kg', fmt(fcaCost(v))), metric('CFR 成本 USD/kg', range(low, upper)), note('CFR 成本不含资金利息、货运险及信保费。'));
        if (deduction > 0) parts.push(metric('盈亏平衡对客单价 USD/kg', range(low/deduction, upper/deduction)));
      }
      if (result) {
        if (mode === 'own') parts.push(metric('人民币含税倒推价 RMB/kg', fmt(result.rmb)), metric('美元不含税倒推价 USD/kg', fmt(result.unit)));
        else {
          parts.push(metric('预计利润 USD', mode === 'rmb' ? range(high.profit, result.profit) : fmt(result.profit)), metric('采购成本利润率', mode === 'rmb' ? range(high.margin, result.margin, n => `${fmt(n*100)}%`) : `${fmt(result.margin*100)}%`));
          if (mode === 'usd') parts.push(metric('单位到岸成本 USD/kg', fmt(result.landed)), metric('人民币利润 RMB', fmt(result.rmb)));
        }
        parts.push(metric('运输保险 USD', fmt(result.insurance)), metric('信用保险 USD', fmt(result.credit)), metric('资金占用 USD', fmt(result.interest)));
      } else parts.push(note('请补全数量、单价、汇率、费用和费率。无费用请填 0，最高运费不得低于最低运费。'));
      return parts;
    }
    async function saveFactory() {
      const record = { ...factory, cas: normalizeCas(factory.cas), raw: pending.length ? factory.raw || factory.details || raw : raw };
      const original = editing ? db.factories.find(row => row.id === editing) : pending[index];
      for (const key of ['quoteDate','validity']) if (!record[key] && original?.[key] && !normalizeFactoryDate(original[key])) record[key] = original[key];
      await mutate({ action: editing ? 'update' : 'add', kind: 'factories', ...(editing ? { id: editing } : {}), record });
      if (!editing && index + 1 < pending.length) { setIndex(index + 1); setFactory(factoryForm(pending[index + 1])); }
      else resetFactory();
    }
    async function exportBackup() {
      const data = await api({ action: 'export' });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = '报价工作台备份.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function importBackup(e) {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      await run(async () => { if (file.size > 10_000_000) throw Error(t('备份超过 10 MB')); const data = JSON.parse(await file.text()); validateDatabase(data); if (window.confirm(t('导入将替换全部记录，请确认已备份。'))) await mutate({ action: 'import', data }); });
    }
    function factoryRow(row) {
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('h3', null, row.name, h('span', { className: 'qw-price' }, `${fmt(row.price)} ${row.currency}/${row.unit}`)),
          h('p', { className: 'qw-item-meta' }, `${row.factory || '—'} · ${row.incoterm} ${row.port || ''} · ${t('退税率')} ${row.rebate ?? '—'}%`),
          h('p', { className: 'qw-item-meta' }, `CAS ${row.cas || '未记录'} · 报价日期 ${row.quoteDate || '未记录'} · 有效至 ${row.validity || '未记录'}`),
          h('p', { className: 'qw-item-meta' }, `进仓费承担方：${row.warehouse || '待确认'} · 港杂费承担方：${row.portfee || '待确认'}`),
          h('p', { className: 'qw-item-meta' }, `保存时间 ${timestamp(row.createdAt)} · 最后修改 ${timestamp(row.updatedAt)}`),
          h('details', { className: 'qw-details' }, h('summary', null, t('完整报价明细')),
            h('p', null, `数量：${row.quantity || '—'} · 装柜量 / 柜型：${row.loading || '—'} · 包装：${row.packing || '—'} · 交货期：${row.delivery || '—'}`),
            h('p', { className: 'qw-full-text' }, row.details || '暂无明细'),
            row.raw && row.raw !== row.details && h('p', { className: 'qw-full-text' }, row.raw))),
        h('div', { className: 'qw-item-actions' }, button('带入核算', () => useFactory(row), { disabled: busy || !usableFactory(row) }), button('编辑', () => editFactory(row)), button('删除', () => remove('factories', row))));
    }
    function freightRow(row) {
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('label', { className: 'qw-check' }, h('input', { type: 'checkbox', checked: selected.includes(row.id), onChange: e => setSelected(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id)) }), `${row.agent} · ${row.route}`),
          h('p', { className: 'qw-item-meta' }, `${row.transportMode} · ${row.basis} · ${row.valid}`),
          h('p', { className: 'qw-item-meta' }, `USD ${fmt(row.sea)} / RMB ${fmt(row.local)}`)),
        h('div', { className: 'qw-item-actions' }, button('删除', () => remove('freights', row))));
    }
    function historyRow(row) {
      const a = row.result, values = { ...row.values, rebate: row.values.rebate ?? (row.mode === 'rmb' ? row.values.tax : null) };
      const b = row.highFreightResult || (row.mode === 'rmb' && Number.isFinite(values.seaMax) && values.seaMax > values.sea ? calculate({ ...values, sea: values.seaMax }, row.mode) : a);
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('h3', null, row.values.product, h('span', { className: 'qw-price' }, `${fmt(row.values.qty)} kg · USD ${fmt(row.values.sell)}/kg`)),
          h('p', { className: 'qw-item-meta' }, `${timestamp(row.date)} · CAS ${row.values.cas || '未记录'} · ${row.values.transportMode || '—'} · 对客条款 ${row.values.customerTerm || '待确认'}`),
          row.mode === 'own'
            ? h('p', { className: 'qw-item-meta' }, `${t('人民币含税倒推价 RMB/kg')}: ${fmt(a.rmb)}`)
            : h('p', { className: 'qw-item-meta' }, `${t('预计利润 USD')}: ${range(a.profit,b.profit)} · ${t('采购成本利润率')}: ${range(a.margin,b.margin,n => `${fmt(n*100)}%`)}`)),
        h('div', { className: 'qw-item-actions' }, button('查看 / 复制重算', () => { start(row.mode, { ...row.values, rebate: row.values.rebate ?? (row.mode === 'rmb' ? row.values.tax : null) }); setTab('calc'); }), button('删除', () => remove('history', row))));
    }
    function pageFactory() {
      return h('div', { className: 'qw-body qw-factory' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('粘贴工厂报价')), h('span', { className: 'qw-badge' }, `${t('已保存')} ${db.factories.length}`)),
          h('textarea', { rows: 3, value: raw, onChange: e => setRaw(e.target.value), placeholder: t('1390美金青岛，22t/20GP不打托，11月中交货'), 'aria-label': t('原始报价 / Excel 表格') }),
          h('div', { className: 'qw-toolbar' },
            button(parsing ? '正在解析…' : 'AI 提取字段', () => run(async () => {
              setParsing(true);
              try {
                const { records, model } = await api({ action: 'parse', raw });
                acceptParsed(records);
                setParseModel({ label: model });
                setMessage(records.length ? `已由 ${model} 提取 ${records.length} 条报价，请核对字段。` : '模型没有从这段内容中识别到报价，请补充数量、价格、单位等信息或换一个模型。');
              } finally { setParsing(false); }
            }), { className: 'qw-primary', disabled: busy || parsing }),
            button('规则提取', () => run(async () => { const records = parseQuotes(raw); acceptParsed(records); setMessage(records.length ? `规则已提取 ${records.length} 条报价，请核对字段；多价格和不明确的计价单位需手动确认。` : '没有识别到报价，请先粘贴报价文本。'); })),
            pending.length > 0 && h('span', { className: 'qw-note' }, `${index + 1} / ${pending.length}`)),
          editing && note('正在编辑已保存的报价；保存修改将保留原创建时间。'),
          h(Fields, { defs: ordered(factoryFields, factoryOrder), value: factory, onChange: changeFactory }),
          ['quoteDate','validity'].map(key => {
            const original = editing ? db.factories.find(row => row.id === editing)?.[key] : pending[index]?.[key];
            return original && !normalizeFactoryDate(original) ? h('p', { key, className: 'qw-note' }, `${key === 'validity' ? '原有效期' : '原报价日期'}：${original}（未填入新日期时保留原文）`) : null;
          }),
          h('div', { className: 'qw-form-foot' },
            button(editing ? '保存修改' : '确认并保存报价', () => run(saveFactory), { className: 'qw-primary' }),
            editing && button('取消编辑', () => { resetFactory(); setMessage(''); }),
            note(parseModel?.label ? `解析模型：${parseModel.label}（可在 设置 → 报价工作台 修改）` : '未选择解析模型，请到 设置 → 报价工作台 配置；字段也可手动填写。'))),
        h('section', { className: 'qw-card qw-list' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('已保存的工厂报价')), h('span', { className: 'qw-badge' }, db.factories.length)),
          h('div', { className: 'qw-list-body' }, db.factories.map(factoryRow), db.factories.length ? null : note('暂无工厂报价'))));
    }
    function pageProducts() {
      const query = catalogSearch.trim().toLowerCase(), casQuery = normalizeCas(query);
      const rows = products.filter(row => row.name.toLowerCase().includes(query) || (casQuery && normalizeCas(row.cas).includes(casQuery)));
      return h('div', { className: 'qw-body qw-factory' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('新增产品'))),
          h(Fields, { defs: [['name','产品名称','text'],['cas','CAS 号','text']], value: product, onChange: (key,value) => setProduct(old => ({ ...old, [key]: value })) }),
          h('div', { className: 'qw-form-foot' }, button('保存产品', () => run(async () => {
            const record = { name: product.name.trim(), cas: normalizeCas(product.cas) };
            if (!record.name || !/^\d{2,7}-\d{2}-\d$/.test(record.cas)) throw Error('请填写产品名称和 CAS 号，格式如 67-68-5。');
            if (products.some(row => normalizeCas(row.cas) === record.cas)) throw Error('该 CAS 号已在目录中。');
            await mutate({ action: 'add', kind: 'products', record }); setProduct({ name: '', cas: '' });
          }), { className: 'qw-primary' })),
          note('目录同时包含手工产品及已保存报价中的产品。来自报价的产品不可在目录直接删除。')),
        h('section', { className: 'qw-card qw-list' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('产品目录')), h('span', { className: 'qw-badge' }, `${rows.length} / ${products.length}`)),
          h('input', { type: 'search', value: catalogSearch, onChange: e => setCatalogSearch(e.target.value), placeholder: t('搜索产品名称或 CAS'), 'aria-label': t('搜索产品名称或 CAS') }),
          h('div', { className: 'qw-list-body' }, rows.map(row => h('article', { className: 'qw-item', key: row.id || row.cas },
            h('div', { className: 'qw-item-main' }, h('h3', null, row.name), h('p', { className: 'qw-item-meta' }, `CAS ${row.cas}`), row.manualIndex === undefined && note('来自已保存报价')),
            h('div', { className: 'qw-item-actions' },
              button('带入核算', () => { setV(old => ({ ...old, product: row.name, cas: row.cas })); autofill.current.calc = row.name; setSource(''); setTab('calc'); }),
              button('带入工厂', () => { setFactory(old => ({ ...old, name: row.name, cas: row.cas })); autofill.current.factory = row.name; setTab('factory'); }),
              row.manualIndex !== undefined && button('删除', () => remove('products', row))))), !rows.length && note('没有符合条件的产品。'))));
    }
    function pageFreight() {
      const avg = averageFreights(selected.map(id => db.freights.find(r => r.id === id)).filter(Boolean));
      return h('div', { className: 'qw-body qw-single' },
        h('div', { className: 'qw-columns' },
          card('新增货代报价',
            h(Fields, { defs: freightFields, value: freight, onChange: (k,x) => setFreight(old => ({ ...old, [k]: x })) }),
            h('div', { className: 'qw-form-foot' }, button('保存货代报价', () => run(async () => { await mutate({ action: 'add', kind: 'freights', record: freight }); setFreight(emptyForm(freightFields)); }), { className: 'qw-primary' }))),
          card('货代报价比较',
            note(`已选 ${selected.length} 家 · 请选择同路线、同运输方式、同数量及费用范围，且有效期内的报价。`),
            selected.length > 0 && !avg && note('已选报价存在口径不一致、过期或数据不完整，无法计算均值。'),
            avg && metric('国际运费 / 国内费用均值', `USD ${fmt(avg.sea)} / RMB ${fmt(avg.local)}`),
            db.freights.map(freightRow),
            !db.freights.length && note('暂无货代报价'),
            h('div', { className: 'qw-form-foot' }, button('带入核算', () => {
              setV(old => ({ ...old, transportMode: avg.transportMode, sea: mode === 'rmb' ? avg.seaMin : avg.sea, seaMax: avg.seaMax, local: avg.local }));
              setTab('calc');
            }, { disabled: busy || !avg })))));
    }
    function pageHistory() {
      return h('div', { className: 'qw-body qw-single' },
        card('核算记录', db.history.map(historyRow), !db.history.length && note('暂无核算记录')));
    }
    function pageCalc() {
      return h('div', { className: 'qw-body qw-calc' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('报价核算')), button('载入 Excel 样例', () => start(mode, samples[mode]))),
          h('div', { className: 'qw-modes' }, ...[['rmb','人民币采购'],['usd','美元采购'],['own','自有工厂倒推']].map(([key,label]) => button(label, () => start(key), { key, 'aria-pressed': mode === key }))),
          h('div', { className: 'qw-section' }, h('h3', null, t('01 / 产品与报价')), h(Fields, { defs: ordered(basic, basicOrder), value: v, onChange: change })),
          h('div', { className: 'qw-section' }, h('h3', null, t('02 / 选取工厂报价')), h('div', { className: 'qw-source' },
            h('select', { 'aria-label': t('选取工厂报价'), value: activeSource ? source : '', disabled: !sources.length, onChange: e => setSource(e.target.value) },
              h('option', { value: '' }, t(mode === 'own' ? '倒推模式无需工厂采购报价' : sources.length ? '请选择已保存的工厂报价' : normalizeCas(v.cas) ? '暂无该 CAS 的可用工厂报价' : '暂无可用的工厂报价')),
              sources.map(row => h('option', { key: row.id, value: row.id }, `${row.name} · ${row.factory || '未填写工厂'} · ${row.incoterm || '待确认'} ${row.port || ''} · 报价日期 ${row.quoteDate || '未记录'} · 有效至 ${row.validity || '未记录'} · ${row.price} ${row.currency}/${row.unit}`))),
            button('带入成本', () => useFactory(activeSource, true), { disabled: busy || !activeSource })),
            activeSource && note(`工厂条款 ${activeSource.incoterm || '待确认'} · ${activeSource.port || '地点未记录'} · 进仓费承担方 ${activeSource.warehouse || '待确认'} · 港杂费承担方 ${activeSource.portfee || '待确认'}`)),
          h('div', { className: 'qw-section' },
            h('h3', null, t('03 / 成本与参数')),
            h(Fields, { defs: ordered([...costs, ...params], calcOrder), value: v, onChange: change, disabled: mode === 'own' ? ['buy','receive'] : mode === 'usd' ? ['tax'] : [], hidden: mode === 'rmb' ? ['receive'] : ['seaMax','rebate'], labels: { buy: mode === 'rmb' ? '含税采购单价 RMB/kg' : '采购单价 USD/kg', fx: mode === 'rmb' ? '收汇汇率 RMB/USD' : '买汇 / 成本汇率 RMB/USD', sea: mode === 'rmb' ? '最低国际运费 USD/票' : '国际运费 USD/票' } }),
            note('国内费用填写我方承担的完整总额，避免重复计入货代报价。')),
          h('div', { className: 'qw-form-foot' }, credit ? note(`${credit.group} 类 · ${credit.period} · 表列 ${credit.rate.toFixed(3)}%（2026–2027.6 费率表）`) : note(v.quoteCountry && v.creditPayment && v.creditMonths != null ? '当前国家、账期和付款方式没有匹配的信保费率，请核对条件或手动填写费率；不可按 0 处理。' : '选择国家、账期和付款方式自动带出信保费率，或直接手填；账期按每月 30 天计算。'))),
        h('section', { className: 'qw-card qw-results' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('本次核算')), h('span', { className: 'qw-badge' }, t(modeLabels[mode]))),
          h('div', { className: 'qw-results-body' }, ...results()),
          h('div', { className: 'qw-results-foot' },
            button('保存本次核算', () => run(() => mutate({ action: 'add', kind: 'history', record: { mode, values: v } })), { className: 'qw-primary', disabled: busy || !ready || !v.product?.trim() }),
            note('沿用原工作台的保险、资金利息及倒推公式。'))));
    }
    let body;
    if (!db) body = h('div', { className: 'qw-body qw-single' }, card('报价工作台', note('正在加载报价记录…')));
    else if (tab === 'factory') body = pageFactory();
    else if (tab === 'freight') body = pageFreight();
    else if (tab === 'history') body = pageHistory();
    else if (tab === 'products') body = pageProducts();
    else body = pageCalc();
    return h('div', { className: 'qw-root' }, h('style', null, css), h('div', { className: 'qw-content' },
      h('header', { className: 'qw-header' },
        h('div', { className: 'qw-brand' }, h('h1', null, t('报价工作台')), h('span', { className: 'qw-sub' }, t('采购 · 物流 · 利润'))),
        h('div', { className: 'qw-toolbar' },
          button('刷新记录', () => run(async () => { setDb(await api({ action: 'list' })); setSelected([]); })),
          button('导出备份', () => run(exportBackup), { disabled: busy || !db }),
          button('导入备份', () => fileInput.current.click(), { disabled: busy || !db }),
          h('input', { ref: fileInput, hidden: true, type: 'file', accept: '.json,application/json', onChange: importBackup }))),
      h('nav', { className: 'qw-tabs', 'aria-label': t('报价工作台') }, ...[['factory','工厂报价'],['calc','报价核算'],['freight','货代报价'],['history','核算记录'],['products','产品目录']].map(([key,label]) => button(label, () => { setTab(key); setMessage(''); }, { key, 'aria-current': tab === key ? 'page' : undefined }))),
      (error || message) && h('div', { className: 'qw-alerts' }, error && h('p', { className: 'qw-error', role: 'alert' }, error), message && h('p', { className: 'qw-status', role: 'status' }, message)),
      body,
      h('p', { className: 'qw-foot-note' }, t('记录保存在 Harness 中；支持导入原工作台的 JSON 备份。'))));
  }
  function Settings() {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const [state, setState] = useState(null), [choice, setChoice] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
    async function load() {
      setBusy(true); setError(''); setStatus('');
      try {
        const [models, settings] = await Promise.all([api({ action: 'models' }), api({ action: 'settings' })]);
        setState({ providers: models.providers, defaultModel: models.defaultModel, effective: settings.effective, revision: settings.revision });
        setChoice(settings.settings ? JSON.stringify([settings.settings.provider, settings.settings.model]) : '');
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    useEffect(() => { load(); }, []);
    async function save() {
      setBusy(true); setError(''); setStatus('');
      try {
        const settings = choice ? (() => { const [provider, model] = JSON.parse(choice); return { provider, model }; })() : null;
        const result = await api({ action: 'saveSettings', revision: state.revision, settings });
        setState(old => ({ ...old, effective: result.effective, revision: result.revision, saved: result.settings }));
        setStatus(t('已保存，下一次解析立即生效。'));
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    const providers = state?.providers ?? [];
    const options = [];
    for (const provider of providers) for (const model of provider.models) options.push({ value: JSON.stringify([provider.provider, model.id]), label: `${provider.name || provider.provider} · ${model.name || model.id}` });
    if (choice && !options.some(option => option.value === choice)) {
      const [provider, model] = JSON.parse(choice);
      options.unshift({ value: choice, label: `${provider} · ${model}（${t('已保存')}）` });
    }
    const defaultLabel = state?.defaultModel ? `${state.defaultModel.provider}/${state.defaultModel.model}` : null;
    return h('div', { className: 'qw-settings' }, h('style', null, css),
      h('div', { className: 'qw-settings-inner' },
        h('h2', null, t('AI 报价解析')),
        h('p', { className: 'qw-note' }, t('粘贴工厂报价时，用来提取产品、价格、单位、条款等字段的大模型。列表来自当前 Harness 已接入的提供方与模型。')),
        h('label', { className: 'qw-settings-field' }, h('span', null, t('解析模型')),
          h('select', { value: choice, disabled: busy || !state, onChange: e => setChoice(e.target.value) },
            h('option', { value: '' }, defaultLabel ? `${t('跟随 Harness 默认模型')}（${defaultLabel}）` : t('跟随 Harness 默认模型')),
            options.map(option => h('option', { key: option.value, value: option.value }, option.label)))),
        h('div', { className: 'qw-settings-actions' },
          h('button', { type: 'button', className: 'qw-settings-primary', disabled: busy || !state, onClick: save }, t('保存')),
          h('button', { type: 'button', disabled: busy, onClick: load }, t('刷新模型列表'))),
        error && h('p', { className: 'qw-settings-error', role: 'alert' }, error),
        status && h('p', { className: 'qw-settings-status', role: 'status' }, status),
        !state && !error && h('p', { className: 'qw-note' }, t('正在读取可用模型…')),
        state && h('p', { className: 'qw-note' }, state.effective ? `${t('当前生效')}：${state.effective.label}` : t('当前没有可用模型。请先在 Harness 设置里接入模型，或选择「跟随 Harness 默认模型」。')),
        state && !providers.length && h('p', { className: 'qw-note' }, t('没有发现已公布模型的提供方；仍可跟随 Harness 默认模型，或先到 设置 → 模型 接入模型。'))));
  }
  return { App, Icon, Settings };
}
