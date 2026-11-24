// Bundled with domain.js by build.mjs; React is provided by Harness.
function createUI(React, ctx, t, css) {
  const h = React.createElement;
  const { useState, useEffect, useRef, useSyncExternalStore } = React;
  const fmt = n => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 4, minimumFractionDigits: 2 }) : '—';
  const emptyForm = defs => Object.fromEntries(defs.map(([key,, type]) => [key, Array.isArray(type) ? type[0] : type === 'number' ? null : '']));
  const ordered = (defs, order) => [...defs].sort((a, b) => { const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  // Frequently used fields come first so each page opens on its working set.
  const basicOrder = ['product','cas','customer','qty','sell','transportMode','customerTerm','place','etd','quoteCountry','creditMonths','creditPayment'];
  const calcOrder = ['buy','fx','receive','sea','seaMax','local','tax','rebate','transport','credit','interest','months'];
  const factoryOrder = ['name','cas','purity','quality','hazard','price','currency','tax','rebate','unit','incoterm','port','quoteDate','validity','delivery','factory','quantity','loading','packing','warehouse','portfee','details'];
  const freightOrder = ['agent','origin','destination','transportMode','containerType','quantity','quantityUnit','bulky','volume','valid','sea','local'];
  const hiddenFreightFields = form => form.transportMode === '海运整柜'
    ? ['quantity','quantityUnit','bulky','volume']
    : form.transportMode === '海运拼箱'
      ? ['containerType', ...(form.bulky === '是' ? [] : ['volume'])]
      : ['containerType','bulky','volume'];
  const range = (a, b, format = fmt) => a === b ? format(a) : `${format(Math.min(a,b))} ～ ${format(Math.max(a,b))}`;
  const factoryForm = (row, derive = true, defaultQuoteDate = true) => {
    // New quotes default to today and stay editable; a stated period such as "30 days" becomes quoteDate + 30 days.
    const quoteDate = normalizeFactoryDate(row?.quoteDate) || (defaultQuoteDate ? localDateString() : '');
    const plan = derive ? factoryValidity(quoteDate, row?.validity) : null;
    return { ...emptyForm(factoryFields), ...row, quoteDate, validity: normalizeFactoryDate(row?.validity) || plan?.date || '' };
  };
  const blankProduct = { name: '', cas: '', hazard: '', tax: null, rebate: null };
  const usableFactory = row => row && ['RMB','USD'].includes(row.currency) && ['吨','公斤'].includes(row.unit) && Number.isFinite(Number(row.price)) && Number(row.price) > 0;
  const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未记录';
  const modeLabels = { rmb: '人民币采购', usd: '美元采购', own: '自有工厂倒推' };
  // Panel zoom behaves like browser page zoom and stays below the host app.
  const zoomStorageKey = 'quote-workbench.zoom', zoomSteps = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
  const clampZoom = value => zoomSteps.reduce((best, step) => Math.abs(step - value) < Math.abs(best - value) ? step : best, 1);
  const stepZoom = (value, direction) => zoomSteps[Math.min(zoomSteps.length - 1, Math.max(0, zoomSteps.indexOf(clampZoom(value)) + direction))];
  function readZoom() {
    try {
      if (typeof localStorage === 'undefined') return 1;
      const stored = Number(localStorage.getItem(zoomStorageKey));
      return Number.isFinite(stored) && stored > 0 ? clampZoom(stored) : 1;
    } catch { return 1; }
  }
  // Every unsaved page draft shares one session cache and expires five minutes after leaving the panel.
  const draftStorageKey = 'quote-workbench.drafts.v2', draftTtlMs = 5 * 60 * 1000;
  const tabKeys = ['factory', 'calc', 'freight', 'history', 'products'];
  const TABLE_LABELS = { factories: '工厂报价', freights: '货代报价', history: '核算记录', products: '产品目录' };
  const FIELD_LABELS = { cas: 'CAS 号', quoteDate: '报价日期', quoteCountry: '报价国家', customer: '客户', product: '产品', sell: '对客单价', sea: '国际运费', local: '国内费用', agent: '货代名称', origin: '起运地', destination: '目的地', transportMode: '运输方式', price: '报价单价', tax: '增值税率', rebate: '退税率', hazard: '货物危险性', name: '产品名称', qty: '数量', mode: '核算方式' };
  const calcModes = ['rmb', 'usd', 'own'];
  const blankCalc = mode => ({ ...defaults, ...(mode === 'rmb' ? { fx: null } : {}), seaMax: null });
  function blankCalcCache() {
    const state = { mode: 'rmb', used: {}, drafts: {}, sources: {}, monthsManual: {} };
    for (const mode of calcModes) { state.used[mode] = false; state.monthsManual[mode] = false; state.drafts[mode] = blankCalc(mode); state.sources[mode] = ''; }
    return state;
  }
  function blankDraft() {
    return {
      tab: 'factory',
      factory: { form: factoryForm(), raw: '', pending: [], index: 0, editing: null },
      calc: blankCalcCache(),
      freight: emptyForm(freightFields),
      product: { ...blankProduct },
      productEditing: null,
      catalogSearch: '',
      historyFilter: { cas: '', customer: '' },
      selected: [],
      selectedHistory: [],
      historySource: null,
    };
  }
  let memoryDraft = null;
  const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  function readDraft() {
    const empty = blankDraft();
    let stored = null, canStore = false;
    try {
      if (typeof sessionStorage !== 'undefined') {
        canStore = true;
        const raw = sessionStorage.getItem(draftStorageKey);
        if (raw) stored = JSON.parse(raw);
      }
    } catch { stored = null; }
    if (!canStore || !stored) stored = memoryDraft;
    if (!isRecord(stored) || !Number.isFinite(stored.savedAt) || Date.now() - stored.savedAt > draftTtlMs) {
      if (canStore) { try { sessionStorage.removeItem(draftStorageKey); } catch { /* 存储不可用 */ } }
      memoryDraft = null;
      return empty;
    }
    if (tabKeys.includes(stored.tab)) empty.tab = stored.tab;

    const factory = isRecord(stored.factory) ? stored.factory : {};
    const form = isRecord(factory.form) ? { ...empty.factory.form, ...factory.form } : empty.factory.form;
    const pending = Array.isArray(factory.pending) ? factory.pending.filter(isRecord) : [];
    if (!normalizeFactoryDate(form.quoteDate) && !factory.editing && !pending[0]?.id) form.quoteDate = localDateString();
    empty.factory = {
      form,
      raw: typeof factory.raw === 'string' ? factory.raw : '',
      pending,
      index: Number.isInteger(factory.index) && factory.index >= 0 && factory.index < Math.max(1, pending.length) ? factory.index : 0,
      editing: typeof factory.editing === 'string' ? factory.editing : null,
    };

    const calc = isRecord(stored.calc) ? stored.calc : {};
    if (calcModes.includes(calc.mode)) empty.calc.mode = calc.mode;
    for (const mode of calcModes) {
      empty.calc.used[mode] = calc.used?.[mode] === true;
      empty.calc.monthsManual[mode] = calc.monthsManual?.[mode] === true;
      const draft = isRecord(calc.drafts?.[mode]) ? calc.drafts[mode] : null;
      if (draft) {
        empty.calc.drafts[mode] = { ...empty.calc.drafts[mode], ...draft, customerTerm: draft.customerTerm || '待确认' };
        const restored = empty.calc.drafts[mode];
        // 旧草稿没有手动标记：仍是默认月数时跟随账期，明显自定义过的值保持不变。
        if (!empty.calc.monthsManual[mode] && Number.isFinite(restored.creditMonths) && (restored.months == null || restored.months === defaults.months)) restored.months = restored.creditMonths;
      }
      if (typeof calc.sources?.[mode] === 'string') empty.calc.sources[mode] = calc.sources[mode];
    }

    const freight = isRecord(stored.freight) ? stored.freight : {};
    empty.freight = { ...empty.freight, ...freight };
    if (!['海运整柜','海运拼箱','空运'].includes(empty.freight.transportMode)) empty.freight.transportMode = '海运整柜';
    if (!['否','是'].includes(empty.freight.bulky)) empty.freight.bulky = '否';
    if (!['公斤','吨','CBM','票'].includes(empty.freight.quantityUnit)) empty.freight.quantityUnit = '公斤';

    const product = isRecord(stored.product) ? stored.product : {};
    empty.product = {
      name: typeof product.name === 'string' ? product.name : '',
      cas: typeof product.cas === 'string' ? product.cas : '',
      hazard: typeof product.hazard === 'string' ? product.hazard : '',
      tax: Number.isFinite(product.tax) ? product.tax : null,
      rebate: Number.isFinite(product.rebate) ? product.rebate : null,
    };
    const editingProduct = isRecord(stored.productEditing) ? stored.productEditing : null;
    if (editingProduct && (typeof editingProduct.id === 'string' || typeof editingProduct.cas === 'string' || editingProduct.derived === true)) {
      empty.productEditing = {
        id: typeof editingProduct.id === 'string' ? editingProduct.id : null,
        cas: typeof editingProduct.cas === 'string' ? normalizeCas(editingProduct.cas) : '',
        derived: editingProduct.derived === true,
      };
    }

    empty.catalogSearch = typeof stored.catalogSearch === 'string' ? stored.catalogSearch : '';
    const filter = isRecord(stored.historyFilter) ? stored.historyFilter : {};
    empty.historyFilter = { cas: typeof filter.cas === 'string' ? filter.cas : '', customer: typeof filter.customer === 'string' ? filter.customer : '' };
    empty.selected = Array.isArray(stored.selected) ? stored.selected.filter(id => typeof id === 'string') : [];
    empty.selectedHistory = Array.isArray(stored.selectedHistory) ? stored.selectedHistory.filter(id => typeof id === 'string') : [];
    empty.historySource = typeof stored.historySource === 'string' ? stored.historySource : null;
    return empty;
  }
  function writeDraft(draft) {
    memoryDraft = draft;
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch { /* 存储不可用时只保留内存草稿 */ }
  }
  async function api(input, signal) {
    const response = await fetch('/api/quote-workbench', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
    const result = await response.json();
    if (!response.ok) {
      const message = result.error || `HTTP ${response.status}`;
      const stale = ['未知操作', '仅支持更新工厂报价', '仅支持更新工厂报价或产品'].includes(message);
      throw Error(stale ? '报价工作台服务端仍是旧版本，请完全退出并重启 Harness，或重新启用报价工作台插件后再试。' : message);
    }
    return result.value;
  }
  function Icon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 4, y: 2, width: 16, height: 20, rx: 3 }), h('path', { d: 'M8 7h8M8 11h3M8 16h4m-2-2v4m4-2h3' }));
  }
  function CountrySelect({ value, disabled, onChange }) {
    const [query, setQuery] = useState(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const selected = creditCountries.find(row => row.code === value);
    const countryText = row => `${row.label}${row.english ? ` · ${row.english}` : ''} · ${row.code}`;
    const term = (query ?? '').trim().toLowerCase();
    const matches = term
      ? creditCountries.filter(row => [row.label, row.english, row.iso2, row.code].some(text => String(text ?? '').toLowerCase().includes(term)))
      : creditCountries;
    const display = query ?? (selected ? countryText(selected) : '');
    useEffect(() => { setQuery(null); }, [value]);
    function choose(row) { onChange(row.code); setQuery(null); setOpen(false); }
    function clear() { onChange(''); setQuery(null); }
    function onKeyDown(event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(matches.length - 1, index + 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => Math.max(0, index - 1)); }
      else if (event.key === 'Enter' && open && matches[Math.min(active, matches.length - 1)]) { event.preventDefault(); choose(matches[Math.min(active, matches.length - 1)]); }
      else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(null); }
    }
    return h('div', { className: 'qw-country-select' },
      h('input', {
        type: 'text', value: display, disabled, autoComplete: 'off', role: 'combobox', 'aria-expanded': open, 'aria-autocomplete': 'list', 'aria-controls': 'qw-country-menu',
        placeholder: t('输入国家中文 / English / 代码'), 'aria-label': t('报价国家 / 地区'),
        onFocus: event => { setOpen(true); setActive(0); if (event.target.select) event.target.select(); },
        onClick: () => setOpen(true),
        onChange: event => {
          const next = event.target.value;
          setQuery(next); setOpen(true); setActive(0);
          if (!next) return clear();
          const hit = creditCountries.find(row => countryText(row) === next || row.code === next);
          if (hit) choose(hit);
        },
        onKeyDown,
        onBlur: () => { setOpen(false); setQuery(null); },
      }),
      open && h('div', { id: 'qw-country-menu', className: 'qw-country-menu', role: 'listbox', 'aria-label': t('报价国家 / 地区'), onMouseDown: event => event.stopPropagation(), onClick: event => event.stopPropagation() },
        matches.length
          ? matches.map((row, index) => h('div', {
              key: row.code, role: 'option', 'aria-selected': row.code === value, className: `qw-country-option${index === active ? ' qw-active' : ''}`,
              onMouseDown: event => { event.preventDefault(); event.stopPropagation(); choose(row); },
              onClick: event => { event.preventDefault(); event.stopPropagation(); },
              onMouseEnter: () => setActive(index),
            }, countryText(row)))
          : h('div', { className: 'qw-country-empty' }, t('没有匹配的国家 / 地区'))));
  }
  const productSearchKey = value => String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  function productSuggestions(products, query) {
    const term = productSearchKey(query);
    if (!term || term.length > 96) return [];
    function distance(name) {
      let previous = Array.from({ length: term.length + 1 }, (_, i) => i);
      let beforePrevious;
      for (let i = 1; i <= name.length; i++) {
        const row = [i];
        for (let j = 1; j <= term.length; j++) {
          row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(name[i - 1] !== term[j - 1]));
          if (i > 1 && j > 1 && name[i - 1] === term[j - 2] && name[i - 2] === term[j - 1]) {
            row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
          }
        }
        beforePrevious = previous;
        previous = row;
      }
      return previous[term.length];
    }
    function score(name) {
      if (name === term) return 0;
      if (name.startsWith(term)) return 1;
      if (name.includes(term)) return 2;
      if (term.length < 4) return Infinity;
      const tolerance = term.length >= 8 ? 2 : 1;
      if (Math.abs(name.length - term.length) > tolerance) return Infinity;
      const edits = distance(name);
      return edits <= tolerance ? 2 + edits : Infinity;
    }
    return products.map(product => ({ product, rank: score(productSearchKey(product.name)) }))
      .filter(({ rank }) => Number.isFinite(rank))
      .sort((a, b) => a.rank - b.rank || a.product.name.localeCompare(b.product.name) || a.product.cas.localeCompare(b.product.cas))
      .slice(0, 8);
  }
  function ProductSearch({ products, onSelect, invalid, label, ...input }) {
    const [show, setShow] = useState(false);
    const [active, setActive] = useState(-1);
    const activeRef = useRef(null);
    const display = input.value;
    const matches = show && !input.disabled ? productSuggestions(products, display) : [];
    const expanded = show && !input.disabled && Boolean(productSearchKey(display));
    const optionId = index => `qw-product-suggestion-${index}`;
    useEffect(() => { activeRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
    function close() { setShow(false); setActive(-1); }
    function choose(product) { close(); onSelect(product); }
    function handleKey(event) {
      if (event.nativeEvent?.isComposing) return;
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active].product); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const available = show ? matches : productSuggestions(products, display);
        if (!available.length) return;
        event.preventDefault(); setShow(true);
        setActive(index => event.key === 'ArrowDown' ? Math.min(index + 1, available.length - 1) : index < 0 ? available.length - 1 : Math.max(index - 1, 0));
      }
    }
    return h('div', { className: 'qw-country-select' },
      h('input', { ...input, value: display, type: 'text', role: 'combobox', autoComplete: 'off', 'aria-label': t(label),
        'aria-invalid': invalid || undefined, 'aria-autocomplete': 'list', 'aria-expanded': expanded,
        'aria-controls': expanded ? 'qw-product-suggestions' : undefined,
        'aria-activedescendant': matches[active] ? optionId(active) : undefined,
        placeholder: t('输入产品名称搜索'), onFocus: () => setShow(true), onClick: () => setShow(true),
        onBlur: close,
        onChange: event => { input.onChange(event); setShow(true); setActive(-1); }, onKeyDown: handleKey }),
      expanded && h('div', { className: 'qw-country-menu qw-product-menu' },
        !matches.length && h('div', { className: 'qw-country-empty', role: 'status' }, t('未找到相似产品，可继续手动输入。')),
        matches.length > 0 && h('div', { className: 'qw-country-empty' }, t('↑↓ 选择 · Enter 确认')),
        h('div', { id: 'qw-product-suggestions', role: 'listbox', 'aria-label': t('产品推荐') },
          matches.map(({ product, rank }, index) => h('div', { id: optionId(index), key: product.cas, role: 'option',
            ref: index === active ? activeRef : undefined, 'aria-selected': index === active,
            className: `qw-country-option qw-product-option${index === active ? ' qw-active' : ''}`,
            onMouseDown: event => event.preventDefault(), onClick: () => choose(product) },
          h('span', null, product.name), h('small', null, `CAS ${product.cas}${rank > 2 ? ` · ${t('相似')}` : ''}`))))));
  }
  function Fields({ defs, value, onChange, disabled = [], hidden = [], labels = {}, wide = [], spans = {}, className, productLookup, signed = [] }) {
    return h('div', { className: className ? `qw-grid ${className}` : 'qw-grid' }, defs.filter(([id]) => !hidden.includes(id)).map(([id, label, type]) => {
      const options = Array.isArray(type) ? type.map(x => [x, t(x)]) : null;
      const props = { value: value[id] ?? '', disabled: disabled.includes(id), onChange: e => onChange(id, type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value) };
      const classes = [id === 'details' || id === 'quality' || wide.includes(id) ? 'qw-field-wide' : '', spans[id] ? `qw-span-${spans[id]}` : ''].filter(Boolean).join(' ');
      // 结构化单行文本只允许英文/数字/标点；工厂名称可含中文，明细/质量/粘贴原文不受限。
      const digitsOnly = type === 'text' && id === 'quantity';
      const quantityText = String(value[id] ?? '').trim();
      const invalidDigits = digitsOnly && quantityText !== '' && !/^\d+$/.test(quantityText);
      const invalidChinese = !digitsOnly && type === 'text' && id !== 'factory' && id !== 'details' && id !== 'quality' && hasChinese(value[id]);
      const invalidEtd = id === 'etd' && !englishText(value[id]);
      const invalid = invalidDigits || invalidChinese || invalidEtd;
      const control = id === 'product' && productLookup
        ? h(ProductSearch, { ...props, ...productLookup, invalid, label: labels[id] || label })
        : id === 'quoteCountry'
        ? h(CountrySelect, { value: value[id] ?? '', disabled: disabled.includes(id), onChange: next => onChange(id, next) })
        : options
          ? h('select', props, options.map(([key, text]) => h('option', { key, value: key }, text)))
          : id === 'details' || id === 'quality'
            ? h('textarea', { ...props, rows: id === 'details' ? 3 : 2 })
            : h('input', { ...props, type, inputMode: digitsOnly ? 'numeric' : undefined, pattern: digitsOnly ? '[0-9]*' : undefined, 'aria-invalid': invalid || undefined, ...(type === 'number' ? { min: signed.includes(id) ? undefined : 0, step: 'any' } : {}) });
      return h('label', { key: id, className: classes || undefined }, h('span', null, t(labels[id] || label)), control, invalid && h('span', { className: 'qw-field-error' }, t(invalidEtd ? 'ETD 只能输入英文字符、数字和标点' : invalidDigits ? '数量只能填写阿拉伯数字' : '不能包含中文')));
    }));
  }
  function App() {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const restoredRef = useRef(null);
    if (!restoredRef.current) restoredRef.current = readDraft();
    const restored = restoredRef.current, calcCache = restored.calc;
    const [db, setDb] = useState(null), [tab, setTab] = useState(restored.tab), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
    const [mode, setMode] = useState(restored.calc.mode), [v, setV] = useState(restored.calc.drafts[restored.calc.mode]);
    const [factory, setFactory] = useState(restored.factory.form), [freight, setFreight] = useState(restored.freight);
    const [raw, setRaw] = useState(restored.factory.raw), [pending, setPending] = useState(restored.factory.pending), [index, setIndex] = useState(restored.factory.index), [selected, setSelected] = useState(restored.selected), [selectedHistory, setSelectedHistory] = useState(restored.selectedHistory), [historySource, setHistorySource] = useState(restored.historySource), [source, setSource] = useState(restored.calc.sources[restored.calc.mode]);
    const [parseModel, setParseModel] = useState(null), [parsing, setParsing] = useState(false);
    const [sync, setSync] = useState(null);
    const refreshSync = () => api({ action: 'syncStatus' }).then(setSync).catch(() => {});
    const [editing, setEditing] = useState(restored.factory.editing), [product, setProduct] = useState(restored.product), [productEditing, setProductEditing] = useState(restored.productEditing), [catalogSearch, setCatalogSearch] = useState(restored.catalogSearch);
    const [historyFilter, setHistoryFilter] = useState(restored.historyFilter);
    const [includeCosting, setIncludeCosting] = useState(true);
    const [zoom, setZoom] = useState(readZoom);
    const fileInput = useRef(null), lock = useRef(false), autofill = useRef({ calc: { rmb: '', usd: '', own: '' }, factory: '', factoryHazard: '', rates: { rmb: {}, usd: {}, own: {} }, factoryRates: {}, factoryValidity: null }), rootRef = useRef(null), draftSnapshot = useRef(null);
    const products = db ? catalogProducts(db) : [];
    const sources = db ? db.factories.filter(row => usableFactory(row) && row.currency === ({ rmb: 'RMB', usd: 'USD' })[mode] && (!normalizeCas(v.cas) || normalizeCas(row.cas) === normalizeCas(v.cas))) : [];
    const activeSource = sources.find(row => row.id === source);
    useEffect(() => { if (db && source && !activeSource) setSource(''); }, [db, source, activeSource]);
    useEffect(() => {
      calcCache.mode = mode; calcCache.drafts[mode] = v; calcCache.sources[mode] = source;
      const draft = {
        tab,
        factory: { form: factory, raw, pending, index, editing },
        calc: calcCache,
        freight, product, productEditing, catalogSearch, historyFilter,
        selected, selectedHistory, historySource,
        savedAt: Date.now(),
      };
      draftSnapshot.current = draft;
      writeDraft(draft);
    }, [tab, mode, v, source, factory, raw, pending, index, editing, freight, product, productEditing, catalogSearch, historyFilter, selected, selectedHistory, historySource]);
    // 离开工作台时刷新时间戳：之后 5 分钟内回来仍能恢复，超时才清空。
    useEffect(() => () => { if (draftSnapshot.current) writeDraft({ ...draftSnapshot.current, savedAt: Date.now() }); }, []);
    function casFields(old, value, key, scope) {
      const match = normalizeCas(value) && products.find(row => normalizeCas(row.cas) === normalizeCas(value));
      const marker = scope === 'factory' ? autofill.current.factory : autofill.current.calc[mode];
      const name = match ? match.name : old[key] === marker ? '' : old[key];
      if (scope === 'factory') autofill.current.factory = match ? match.name : '';
      else autofill.current.calc[mode] = match ? match.name : '';
      const next = { ...old, cas: value, [key]: name };
      // 货物危险性跟随目录：有目录值就代入；之前自动代入、新 CAS 没有目录值时清空，手工填写的不覆盖。
      if (scope === 'factory') {
        const hazard = match ? String(match.hazard ?? '').trim() : '';
        if (hazard) { next.hazard = hazard; autofill.current.factoryHazard = hazard; }
        else if (old.hazard === (autofill.current.factoryHazard ?? '')) { next.hazard = ''; autofill.current.factoryHazard = ''; }
      }
      // 税率随 CAS 绑定：历史记录有值就代入；之前自动代入但新 CAS 没有数据的，恢复默认，避免串到别的产品。
      const marks = scope === 'factory' ? autofill.current.factoryRates : autofill.current.rates[mode];
      const fallback = scope === 'factory' ? { tax: null, rebate: null } : defaults;
      for (const id of ['tax', 'rebate']) {
        const found = match?.[id];
        if (Number.isFinite(found)) { next[id] = found; marks[id] = found; }
        else if (marks[id] !== undefined && old[id] === marks[id]) { next[id] = fallback[id]; delete marks[id]; }
        else delete marks[id];
      }
      return next;
    }
    function loadFactoryForm(row, derive = true, defaultQuoteDate = true) {
      const form = factoryForm(row, derive, defaultQuoteDate);
      const plan = factoryValidity(form.quoteDate, row?.validity);
      autofill.current.factoryValidity = derive ? plan?.duration ?? null : null;
      setFactory(form);
      return form;
    }
    function changeFactory(key, value) {
      if (key === 'cas') { setFactory(old => casFields(old, value, 'name', 'factory')); return; }
      if (key === 'validity') { autofill.current.factoryValidity = null; setFactory(old => ({ ...old, validity: value })); return; }
      if (key === 'quoteDate') {
        // A validity computed from a stated period follows the quote date until the user edits it directly.
        const duration = autofill.current.factoryValidity;
        const derived = duration ? addValidityDate(value, duration) : '';
        setFactory(old => ({ ...old, quoteDate: value, ...(derived ? { validity: derived } : {}) }));
        return;
      }
      setFactory(old => ({ ...old, [key]: value }));
    }
    function changeFreight(key, value) {
      setFreight(old => key === 'transportMode'
        ? { ...old, transportMode: value, quantityUnit: '公斤', bulky: '否' }
        : { ...old, [key]: value });
    }
    function freightRecord(form) {
      const record = {
        agent: String(form.agent ?? '').trim(),
        origin: String(form.origin ?? '').trim(),
        destination: String(form.destination ?? '').trim(),
        transportMode: form.transportMode,
        valid: form.valid,
        sea: form.sea,
        local: form.local,
      };
      if (form.transportMode === '海运整柜') record.containerType = form.containerType;
      else {
        record.quantity = form.quantity;
        record.quantityUnit = form.quantityUnit;
        if (form.transportMode === '海运拼箱') {
          record.bulky = form.bulky === '是' ? '是' : '否';
          if (record.bulky === '是') record.volume = form.volume;
        }
      }
      return record;
    }
    function resetFactory() { setEditing(null); setPending([]); setIndex(0); loadFactoryForm(); setRaw(''); autofill.current.factory = ''; autofill.current.factoryHazard = ''; autofill.current.factoryRates = {}; }
    const draftFormRef = useRef(null), focusCopiedDraft = useRef(false);
    useEffect(() => {
      if (!focusCopiedDraft.current || !draftFormRef.current) return;
      focusCopiedDraft.current = false;
      draftFormRef.current.focus();
    }, [tab, factory, v]);
    function openFactory(row, editingOriginal) {
      const { id, createdAt, updatedAt, ...fields } = row;
      focusCopiedDraft.current = !editingOriginal;
      setEditing(editingOriginal ? id : null);
      setPending(editingOriginal ? [] : [row]);
      setIndex(0);
      loadFactoryForm(fields, false, false);
      setRaw(row.raw || '');
      autofill.current.factory = '';
      autofill.current.factoryHazard = String(row.hazard ?? '').trim();
      autofill.current.factoryRates = {};
      setTab('factory');
      setError('');
      setMessage(t(editingOriginal ? '正在编辑已保存的报价。' : '已复制到新报价草稿，请确认后保存。'));
    }
    function acceptParsed(records) {
      setEditing(null); setPending(records); setIndex(0); autofill.current.factory = ''; autofill.current.factoryHazard = ''; autofill.current.factoryRates = {};
      loadFactoryForm(records[0]);
    }
    useEffect(() => {
      const controller = new AbortController();
      Promise.all([api({ action: 'list' }, controller.signal), api({ action: 'settings' }, controller.signal)])
        .then(([next, settings]) => { setDb(next); setParseModel({ label: settings.effective?.label ?? null }); })
        .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
      return () => controller.abort();
    }, []);
    useEffect(() => { refreshSync(); }, []);
    useEffect(() => { if (historySource && db && !db.history.some(row => row.id === historySource)) setHistorySource(null); }, [historySource, db]);
    useEffect(() => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(zoomStorageKey, String(zoom)); } catch { /* 隐私模式或宿主禁用存储时保持当前缩放 */ } }, [zoom]);
    useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
      function onKeyDown(event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const action = event.key === '=' || event.key === '+' ? 1 : event.key === '-' || event.key === '_' ? -1 : event.key === '0' ? 0 : null;
        if (action === null) return;
        const element = rootRef.current;
        if (!element || !element.getClientRects().length) return; // 工作台未显示时不拦截宿主快捷键
        event.preventDefault();
        event.stopPropagation();
        setZoom(current => action === 0 ? 1 : stepZoom(current, action));
      }
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
    async function run(fn) {
      if (lock.current) return;
      lock.current = true; setBusy(true); setError(''); setMessage('');
      try { await fn(); } catch (e) { setError(e.message); } finally { lock.current = false; setBusy(false); }
    }
    async function mutate(input) { const next = await api({ ...input, revision: db.revision }); setDb(next); setSelected([]); setSelectedHistory([]); setMessage(t('已保存。')); refreshSync(); }
    const button = (text, onClick, extra = {}) => h('button', { type: 'button', disabled: busy, onClick, ...extra }, t(text));
    const note = text => h('p', { className: 'qw-note' }, text);
    const costingOption = () => h('label', { className: 'qw-check qw-export-option', title: t('同时导出内部成本页') }, h('input', { type: 'checkbox', checked: includeCosting, 'aria-label': t('包含成本数据'), onChange: e => setIncludeCosting(e.target.checked) }), t('包含成本数据'));
    const card = (title, ...children) => h('section', { className: 'qw-card' }, h('div', { className: 'qw-card-head' }, h('h2', null, t(title))), ...children);
    // 文本字段的中文校验：工厂名称例外，明细/质量等长文本例外。
    const invalidText = (defs, value) => defs.filter(([id,, type]) => type === 'text' && id !== 'factory' && id !== 'details' && id !== 'quality' && hasChinese(value?.[id]));
    const assertTextClean = (defs, value) => {
      if (value && Object.hasOwn(value, 'etd') && !englishText(value.etd)) throw Error('ETD 只能输入英文字符、数字和标点。');
      const bad = invalidText(defs, value);
      if (bad.length) throw Error(`以下字段不能包含中文：${bad.map(([, label]) => t(label)).join('、')}。`);
    };
    function start(next, data = {}, monthsManual = false) {
      if (next !== mode) { calcCache.drafts[mode] = v; calcCache.sources[mode] = source; }
      const values = { ...defaults, ...data, customerTerm: data.customerTerm || '待确认', seaMax: data.seaMax ?? data.sea ?? null, ...(next === 'rmb' ? { fx: data.fx ?? null } : {}) };
      // 资金占用月数默认同账期；历史记录或手工值通过 monthsManual 保留原值。
      if (!monthsManual && !Object.hasOwn(data, 'months') && Number.isFinite(values.creditMonths)) values.months = values.creditMonths;
      calcCache.used[next] = true; calcCache.monthsManual[next] = monthsManual; calcCache.drafts[next] = values; calcCache.sources[next] = '';
      setMode(next); setV(values); setSource('');
      autofill.current.calc[next] = '';
      autofill.current.rates[next] = {};
      setMessage('');
    }
    function switchMode(next) {
      if (next === mode) return;
      calcCache.drafts[mode] = v; calcCache.sources[mode] = source;
      setMode(next); setV(calcCache.drafts[next]); setSource(calcCache.sources[next]);
      setHistorySource(null);
      setMessage('');
    }
    // Saving a calculation ends this round: the form and every per-mode draft restart blank.
    function clearCalc() {
      for (const nextMode of calcModes) {
        calcCache.used[nextMode] = false;
        calcCache.monthsManual[nextMode] = false;
        calcCache.drafts[nextMode] = blankCalc(nextMode);
        calcCache.sources[nextMode] = '';
        autofill.current.calc[nextMode] = '';
        autofill.current.rates[nextMode] = {};
      }
      setV(blankCalc(mode));
      setSource('');
      setHistorySource(null);
    }
    function change(id, value) {
      calcCache.used[mode] = true;
      if (id === 'months') calcCache.monthsManual[mode] = true;
      if (id === 'cas') setSource('');
      setV(old => {
        const next = id === 'cas' ? casFields(old, value, 'product', 'calc') : { ...old, [id]: value };
        if (['quoteCountry','creditMonths','creditPayment'].includes(id)) next.credit = lookupCreditRate(next.quoteCountry, next.creditMonths, next.creditPayment)?.rate ?? null;
        if (id === 'creditMonths' && !calcCache.monthsManual[mode] && Number.isFinite(value)) next.months = value;
        return next;
      });
    }
    function useFactory(row, keepMode = false) {
      if (!usableFactory(row)) return;
      const nextMode = row.currency === 'RMB' ? 'rmb' : 'usd';
      if (keepMode && (nextMode !== mode || !sources.some(item => item.id === row.id))) { setError(t('请选择与当前采购币种及 CAS 相符的报价。')); return; }
      const rebate = row.rebate === null || row.rebate === undefined || row.rebate === '' ? null : Number(row.rebate);
      const quantity = factoryQuantityKg(row.quantity, row.unit);
      const targetMode = keepMode ? mode : nextMode;
      const targetValues = targetMode === mode || !calcCache.used[targetMode] ? v : calcCache.drafts[targetMode];
      const targetManual = targetMode === mode || !calcCache.used[targetMode] ? calcCache.monthsManual[mode] : calcCache.monthsManual[targetMode];
      if (!keepMode) setHistorySource(null);
      start(targetMode, { ...targetValues, product: row.name || '', cas: normalizeCas(row.cas), buy: Number(row.price) / (row.unit === '吨' ? 1000 : 1), rebate: Number.isFinite(rebate) ? rebate : null, ...(quantity ? { qty: quantity } : {}) }, targetManual);
      autofill.current.calc[targetMode] = row.name || '';
      setSource(row.id); setTab('calc'); setMessage(`${t('已自动填入工厂报价的采购单价、退税率、产品和 CAS，报价含明确数量时同步填入数量；请补充交货地点、运费和汇率。')} ${t('进仓费承担方')}: ${row.warehouse || '待确认'} · ${t('港杂费承担方')}: ${row.portfee || '待确认'}`);
    }
    function selectFactory(id) {
      if (!id) { setSource(''); return; }
      const row = sources.find(item => item.id === id);
      if (row) useFactory(row, true);
    }
    function remove(kind, row) { if (window.confirm(t('删除这条记录？'))) run(() => mutate({ action: 'delete', kind, id: row.id })); }
    function matchFactory(values, targetMode) {
      if (!db || targetMode === 'own') return null;
      const currency = ({ rmb: 'RMB', usd: 'USD' })[targetMode];
      if (!currency) return null;
      const cas = normalizeCas(values?.cas), name = String(values?.product || '').trim();
      const rows = db.factories.filter(row => usableFactory(row) && row.currency === currency);
      const candidates = cas ? rows.filter(row => normalizeCas(row.cas) === cas) : rows;
      return candidates.find(row => name && row.name === name) || (cas ? candidates[0] : null) || null;
    }
    function factoryForHistory(row) {
      if (!row) return null;
      if (row.factorySnapshot && typeof row.factorySnapshot === 'object' && !Array.isArray(row.factorySnapshot)) return row.factorySnapshot;
      if (row.factoryId) {
        const found = db?.factories.find(item => item.id === row.factoryId);
        if (found) return found;
      }
      return matchFactory(row.values, row.mode);
    }
    function historyValues(row) {
      const values = { ...row.values, rebate: row.values.rebate ?? (row.mode === 'rmb' ? row.values.tax : row.mode === 'own' ? 0 : null), seaMax: row.values.seaMax ?? row.values.sea };
      if (row.mode === 'own') values.receive = row.values.seaMax == null ? row.values.fx ?? row.values.receive : row.values.receive ?? row.values.fx;
      return values;
    }
    const credit = lookupCreditRate(v.quoteCountry, v.creditMonths, v.creditPayment);
    const ready = validateCalculation(v, mode);
    const currentFactory = mode === 'own' ? null : activeSource || matchFactory(v, mode);
    const etdInvalid = !englishText(v.etd);
    const canExport = ready && Boolean(v.product?.trim()) && (mode === 'own' || Boolean(currentFactory)) && !etdInvalid;
    const result = ready ? calculate(v, mode) : null;
    const high = ready && mode !== 'own' ? calculate({ ...v, sea: v.seaMax }, mode) : result;
    const ownHigh = ready && mode === 'own' ? calculate({ ...v, sea: v.seaMax }, 'own') : null;
    const fcaReady = mode === 'rmb' && v.fx > 0 && [v.buy,v.tax].every(n => Number.isFinite(n) && n >= 0) && validRebate(v.rebate);
    const cfr = cfrCost(v, mode);
    const cfrHigh = cfr != null && Number.isFinite(v.seaMax) && v.seaMax >= v.sea ? cfrCost({ ...v, sea: v.seaMax }, mode) : null;
    const deduction = [v.transport,v.credit,v.interest,v.months].every(n => Number.isFinite(n) && n >= 0) ? 1 - (1.1*v.transport+v.credit+v.interest/12*v.months)/100 : 0;
    const missingCost = () => [
      !(v.qty > 0) && '数量',
      !(v.fx > 0) && '汇率',
      !(Number.isFinite(v.buy) && v.buy >= 0) && '采购单价',
      !(Number.isFinite(v.sea) && v.sea >= 0) && '国际运费',
      !(Number.isFinite(v.local) && v.local >= 0) && '国内费用',
      mode === 'rmb' && !(Number.isFinite(v.tax) && v.tax >= 0) && '增值税率',
      mode === 'rmb' && !validRebate(v.rebate) && '退税率'
    ].filter(Boolean);
    const missingOwn = () => [
      !(v.qty > 0) && '数量',
      !(Number.isFinite(v.sell) && v.sell >= 0) && '对客单价',
      !(v.receive > 0) && '收汇汇率',
      !(Number.isFinite(v.sea) && (mode === 'usd' || v.sea >= 0)) && '最低国际运费',
      !(Number.isFinite(v.seaMax) && (mode === 'usd' || v.seaMax >= 0)) && '最高国际运费',
      !(Number.isFinite(v.local) && v.local >= 0) && '国内费用',
      !(Number.isFinite(v.tax) && v.tax >= 0) && '增值税率',
      !validRebate(v.rebate) && '退税率'
    ].filter(Boolean);
    const metric = (label, value) => h('div', { className: 'qw-metric', key: label }, h('span', null, t(label)), h('strong', null, value));
    function results() {
      const parts = [];
      if (fcaReady) parts.push(metric('FCA 成本 USD/kg', fmt(fcaCost(v))));
      if (cfr != null) {
        parts.push(metric('C&F 成本 USD/kg', cfrHigh != null ? range(cfr, cfrHigh) : fmt(cfr)));
        parts.push(note('C&F（CFR）成本、预计利润和利润率按最低 / 最高国际运费计算区间；最高与最低相同时为单值，不含资金利息、货运险及信保费。'));
        if (cfrHigh == null && !(Number.isFinite(v.seaMax) && v.seaMax < v.sea)) parts.push(note('填写高于最低运费的「最高国际运费」后，C&F 成本、利润和利润率会显示区间。'));
        if (deduction > 0) parts.push(metric('盈亏平衡对客单价 USD/kg', range(cfr/deduction, (cfrHigh ?? cfr)/deduction)));
        if (Number.isFinite(v.seaMax) && v.seaMax < v.sea) parts.push(note('最高国际运费低于最低国际运费，请调整后才能保存。'));
      }
      if (result) {
        if (mode === 'own') {
          parts.push(metric('人民币含税倒推价 RMB/kg', ownHigh ? range(result.rmb, ownHigh.rmb) : fmt(result.rmb)));
          parts.push(metric('美元不含税倒推价 USD/kg', ownHigh ? range(result.unit, ownHigh.unit) : fmt(result.unit)));
          parts.push(note('按最低 / 最高国际运费计算倒推价区间；人民币含税倒推价按增值税率和退税率换算。'));
        } else {
          parts.push(metric('预计利润 USD', range(high.profit, result.profit)), metric('采购成本利润率', range(high.margin, result.margin, n => `${fmt(n*100)}%`)));
          if (mode === 'usd') parts.push(metric('人民币利润 RMB', range(high.rmb, result.rmb)));
        }
        parts.push(metric('运输保险 USD', fmt(result.insurance)), metric('信用保险 USD', fmt(result.credit)), metric('资金占用 USD', fmt(result.interest)));
      } else if (mode === 'own') {
        const missing = missingOwn();
        const rateBad = validRebate(v.rebate) && Number.isFinite(v.tax) && v.rebate - v.tax >= 100;
        const freightBad = Number.isFinite(v.sea) && Number.isFinite(v.seaMax) && v.seaMax < v.sea;
        parts.push(note(missing.length ? `补齐${missing.join('、')}后显示倒推价；无费用请填 0。` : rateBad ? '退税率不能达到 100% + 增值税率，请调整。' : freightBad ? '最高国际运费不能低于最低国际运费，请调整。' : '请补全数量、售价、汇率、费用和费率。无费用请填 0。'));
      } else if (cfr == null) {
        const missing = missingCost();
        parts.push(note(missing.length ? `补齐${missing.join('、')}后显示 C&F 成本；无费用请填 0。` : '请补全数量、单价、汇率、费用和费率。无费用请填 0，最高运费不得低于最低运费。'));
      }
      return parts;
    }
    function openHistory(row, values, editingOriginal) {
      focusCopiedDraft.current = !editingOriginal;
      const monthsManual = values.months != null && Number.isFinite(values.creditMonths) && values.months !== values.creditMonths;
      start(row.mode, values, monthsManual);
      setHistorySource(editingOriginal ? row.id : null);
      if (row.factoryId) setSource(row.factoryId);
      setTab('calc');
      setError('');
      if (!editingOriginal) setMessage(t('已复制到新核算草稿，请确认后保存。'));
    }
    async function saveFactory(overwrite = true) {
      const quantity = String(factory.quantity ?? '').trim();
      if (quantity && !/^\d+$/.test(quantity)) throw Error('数量只能填写阿拉伯数字。');
      assertTextClean(factoryFields, factory);
      const updating = Boolean(editing) && overwrite !== false;
      const original = editing ? db.factories.find(row => row.id === editing) : pending[index];
      const parsed = pending.length > 0 && !original?.id;
      const record = { ...factory, cas: normalizeCas(factory.cas), raw: parsed ? factory.raw || factory.details || raw : raw };
      for (const key of ['quoteDate','validity']) if (!record[key] && original?.[key] && !normalizeFactoryDate(original[key])) record[key] = original[key];
      await mutate({ action: updating ? 'update' : 'add', kind: 'factories', ...(updating ? { id: editing } : {}), record });
      if (updating) setMessage('已覆盖原报价。');
      else if (editing) setMessage('已另存为新的报价。');
      if (!editing && index + 1 < pending.length) { setIndex(index + 1); loadFactoryForm(pending[index + 1]); }
      else resetFactory();
    }
    async function saveHistory(overwrite) {
      assertTextClean(basic, v);
      const record = { mode, values: v, factoryId: currentFactory?.id ?? null };
      if (overwrite && historySource) {
        await mutate({ action: 'update', kind: 'history', id: historySource, record });
        clearCalc();
        setMessage('已覆盖原核算记录，核算页面已清空。');
      } else {
        const wasEditing = Boolean(historySource);
        await mutate({ action: 'add', kind: 'history', record });
        clearCalc();
        if (wasEditing) setMessage('已另存为新的核算记录，核算页面已清空。');
        else setMessage('已保存，核算页面已清空。');
      }
    }
    async function exportBackup() {
      const data = await api({ action: 'export' });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = '报价工作台备份.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function downloadQuotation(file) {
      const binary = atob(file.base64), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`已生成 ${file.filename}，${includeCosting ? '包含内部成本页' : '仅含客户 Quotation 页'}，可直接编辑并另存为 Excel。`);
    }
    async function exportQuotation() {
      assertTextClean(basic, v);
      const sourceFactory = mode === 'own' ? null : activeSource || matchFactory(v, mode);
      if (mode !== 'own' && !sourceFactory) throw Error('请先在 01 选择对应工厂报价');
      const file = await api({ action: 'quotation', includeCosting, items: [{ mode, values: v, ...(sourceFactory ? { factoryId: sourceFactory.id, factory: sourceFactory } : {}) }] });
      downloadQuotation(file);
    }
    async function exportSelectedHistory() {
      const rows = db.history.filter(row => selectedHistory.includes(row.id));
      if (!rows.length) throw Error('请先勾选要合并的核算记录');
      const items = rows.map(row => {
        const factory = factoryForHistory(row);
        return { mode: row.mode, values: historyValues(row), ...(factory ? { factory, ...(factory.id ? { factoryId: factory.id } : {}) } : {}) };
      });
      if (items.some(item => !englishText(item.values.etd))) throw Error('ETD 只能输入英文字符、数字和标点。');
      const file = await api({ action: 'quotation', includeCosting, items });
      downloadQuotation(file);
    }
    async function importBackup(e) {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      await run(async () => { if (file.size > 10_000_000) throw Error(t('备份超过 10 MB')); const data = JSON.parse(await file.text()); validateDatabase(data); if (window.confirm(t('导入将替换全部记录，请确认已备份。'))) await mutate({ action: 'import', data }); });
    }
    function factoryRow(row) {
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('h3', null, row.name, h('span', { className: 'qw-price' }, `${fmt(row.price)} ${row.currency}/${row.unit}`)),
          h('p', { className: 'qw-item-meta' }, `${row.factory || '—'} · ${row.incoterm} ${row.port || ''} · 增值税率 ${row.tax ?? '—'}% · ${t('退税率')} ${row.rebate ?? '—'}%`),
          h('p', { className: 'qw-item-meta' }, `CAS ${row.cas || '未记录'} · 报价日期 ${row.quoteDate || '未记录'} · 有效至 ${row.validity || '未记录'}`),
          h('p', { className: 'qw-item-meta' }, `含量 / 纯度：${row.purity || '—'} · 其他关键质量指标：${row.quality || '—'} · 货物危险性：${row.hazard || '—'}`),
          h('p', { className: 'qw-item-meta' }, `进仓费承担方：${row.warehouse || '待确认'} · 港杂费承担方：${row.portfee || '待确认'}`),
          h('p', { className: 'qw-item-meta' }, `保存时间 ${timestamp(row.createdAt)} · 最后修改 ${timestamp(row.updatedAt)}`),
          h('details', { className: 'qw-details' }, h('summary', null, t('完整报价明细')),
            h('p', null, `数量：${row.quantity || '—'} · 装柜量 / 柜型：${row.loading || '—'} · 包装：${row.packing || '—'} · 交货期：${row.delivery || '—'}`),
            h('p', { className: 'qw-full-text' }, row.details || '暂无明细'),
            row.raw && row.raw !== row.details && h('p', { className: 'qw-full-text' }, row.raw))),
        h('div', { className: 'qw-item-actions' },
          button('带入核算', () => useFactory(row), { disabled: busy || !usableFactory(row) }),
          button('编辑', () => openFactory(row, true)),
          button('复制', () => openFactory(row, false)),
          button('删除', () => remove('factories', row))));
    }
    function freightRow(row) {
      const route = freightRoute(row), basis = freightBasis(row);
      const scope = basis ? `${row.transportMode === '海运整柜' ? '柜型' : '询价'}：${basis}` : '口径未填写';
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('label', { className: 'qw-check' }, h('input', { type: 'checkbox', checked: selected.includes(row.id), onChange: e => setSelected(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id)) }), `${row.agent} · ${row.transportMode}`),
          h('p', { className: 'qw-item-meta' }, `起运地：${route.origin || '—'}`),
          h('p', { className: 'qw-item-meta' }, `目的地：${route.destination || '—'}`),
          h('p', { className: 'qw-item-meta' }, `${scope} · 有效期 ${row.valid || '—'}`),
          h('p', { className: 'qw-item-meta' }, `USD ${fmt(row.sea)} / RMB ${fmt(row.local)}`)),
        h('div', { className: 'qw-item-actions' }, button('删除', () => remove('freights', row))));
    }
    function historyRow(row) {
      const a = row.result, values = historyValues(row);
      const b = row.highFreightResult || (Number.isFinite(values.seaMax) && values.seaMax > values.sea ? calculate({ ...values, sea: values.seaMax }, row.mode) : a);
      const historyFactory = factoryForHistory(row);
      const factoryName = historyFactory?.factory || (row.mode === 'own' ? 'Own factory' : '未匹配工厂');
      return h('article', { key: row.id, className: 'qw-item' },
        h('div', { className: 'qw-item-main' },
          h('h3', null, row.values.product, h('span', { className: 'qw-price' }, `${fmt(row.values.qty)} kg · USD ${fmt(row.values.sell)}/kg`)),
          h('p', { className: 'qw-item-meta' }, `${timestamp(row.date)} · 客户 ${row.values.customer || '未记录'} · CAS ${row.values.cas || '未记录'} · ${row.values.transportMode || '—'} · 对客条款 ${row.values.customerTerm || '待确认'}`),
          h('p', { className: 'qw-item-meta' }, `工厂 ${factoryName} · ${row.values.place || '地点未记录'}`),
          row.mode === 'own'
            ? h('p', { className: 'qw-item-meta' }, `${t('人民币含税倒推价 RMB/kg')}: ${range(a.rmb,b.rmb)}`)
            : h('p', { className: 'qw-item-meta' }, `${t('C&F 成本 USD/kg')}: ${range(a.landed,b.landed)} · ${t('预计利润 USD')}: ${range(a.profit,b.profit)} · ${t('采购成本利润率')}: ${range(a.margin,b.margin,n => `${fmt(n*100)}%`)}`)),
        h('div', { className: 'qw-item-actions' },
          h('label', { className: 'qw-check qw-history-check', title: t('选择这条核算记录') }, h('input', { type: 'checkbox', checked: selectedHistory.includes(row.id), 'aria-label': `${t('选择')} ${row.values.product}`, onChange: e => setSelectedHistory(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id)) }), t('选择')),
          button('编辑', () => openHistory(row, values, true)),
          button('复制', () => openHistory(row, values, false)),
          button('删除', () => remove('history', row))));
    }
    function pageFactory() {
      return h('div', { className: 'qw-body qw-factory' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', { ref: draftFormRef, tabIndex: -1 }, t('粘贴工厂报价')), h('span', { className: 'qw-badge' }, `${t('已保存')} ${db.factories.length}`)),
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
            pending.length > 0 && !pending[index]?.id && h('span', { className: 'qw-note' }, `${index + 1} / ${pending.length}`)),
          editing && note('正在编辑已保存的报价：可覆盖原报价，或另存为新报价；覆盖会保留原创建时间。'),
          h(Fields, { defs: ordered(factoryFields, factoryOrder), value: factory, onChange: changeFactory, wide: ['quality'] }),
          ['quoteDate','validity'].map(key => {
            const original = editing ? db.factories.find(row => row.id === editing)?.[key] : pending[index]?.[key];
            if (!original || normalizeFactoryDate(original)) return null;
            if (key === 'quoteDate') return h('p', { key, className: 'qw-note' }, `原报价日期：${original}（未填入新日期时保留原文）`);
            const plan = factoryValidity(factory.quoteDate, original);
            return h('p', { key, className: 'qw-note' }, plan && factory.validity === plan.date
              ? `原有效期：${original}（已按报价日期 ${factory.quoteDate} + ${plan.label}计算并填入 ${plan.date}）`
              : `原有效期：${original}（未填入新日期时保留原文）`);
          }),
          h('div', { className: 'qw-form-foot' },
            editing
              ? button('覆盖原报价', () => run(() => saveFactory(true)), { className: 'qw-primary' })
              : button('确认并保存报价', () => run(() => saveFactory()), { className: 'qw-primary' }),
            editing && button('另存为新报价', () => run(() => saveFactory(false))),
            editing && button('取消编辑', () => { resetFactory(); setMessage(''); }),
            note(parseModel?.label ? `解析模型：${parseModel.label}（可在 设置 → 报价工作台 修改）` : '未选择解析模型，请到 设置 → 报价工作台 配置；字段也可手动填写。'))),
        h('section', { className: 'qw-card qw-list' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('已保存的工厂报价')), h('span', { className: 'qw-badge' }, db.factories.length)),
          h('div', { className: 'qw-list-body' }, db.factories.map(factoryRow), db.factories.length ? null : note('暂无工厂报价'))));
    }
    function editProduct(row) {
      const own = row.id ? db.products.find(item => item.id === row.id) : null;
      setProductEditing({ id: own?.id ?? null, cas: normalizeCas(own?.cas ?? row.cas), derived: !own });
      setProduct({ name: own?.name ?? row.name, cas: own?.cas ?? row.cas, hazard: own?.hazard ?? row.hazard ?? '', tax: own && Number.isFinite(own.tax) ? own.tax : null, rebate: own && Number.isFinite(own.rebate) ? own.rebate : null });
      setMessage('');
    }
    function cancelProductEdit() { setProductEditing(null); setProduct(blankProduct); }
    async function saveProduct() {
      assertTextClean(productFields, product);
      const record = { name: product.name.trim(), cas: normalizeCas(product.cas) };
      if (!record.name || !/^\d{2,7}-\d{2}-\d$/.test(record.cas)) throw Error('请填写产品名称和 CAS 号，格式如 67-68-5。');
      const hazard = String(product.hazard ?? '').trim();
      // 编辑时也发送空值，才能清除目录覆盖并恢复按报价自动取值。
      if (hazard || productEditing) record.hazard = hazard;
      for (const key of ['tax', 'rebate']) record[key] = product[key] === null || product[key] === '' ? null : Number(product[key]);
      const originalCas = productEditing ? normalizeCas(productEditing.cas) : null;
      if (products.some(row => normalizeCas(row.cas) === record.cas && normalizeCas(row.cas) !== originalCas)) throw Error('该 CAS 号已在目录中。');
      if (productEditing?.id) await mutate({ action: 'update', kind: 'products', id: productEditing.id, record });
      else await mutate({ action: 'add', kind: 'products', record, ...(productEditing?.derived ? { override: true } : {}) });
      setProductEditing(null); setProduct(blankProduct);
    }
    function pageProducts() {
      const query = catalogSearch.trim().toLowerCase(), casQuery = normalizeCas(query);
      const rows = products.filter(row => row.name.toLowerCase().includes(query) || (casQuery && normalizeCas(row.cas).includes(casQuery)));
      return h('div', { className: 'qw-body qw-factory' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t(productEditing ? '编辑产品' : '新增产品'))),
          h(Fields, { defs: productFields, value: product, onChange: (key,value) => setProduct(old => ({ ...old, [key]: value })), disabled: productEditing?.derived ? ['cas'] : [] }),
          h('div', { className: 'qw-form-foot' },
            button(productEditing ? '保存修改' : '保存产品', () => run(saveProduct), { className: 'qw-primary' }),
            productEditing && button('取消编辑', cancelProductEdit)),
          note(productEditing?.derived ? '来自报价的产品：CAS 已锁定；货物危险性、税率留空时继续按报价/核算自动取值，填写后以目录设置为准。' : '货物危险性留空时按该 CAS 最近一次工厂报价自动取值；税率留空时按核算或工厂报价自动取值；填写后以目录设置为准。'),
          note('目录同时包含手工产品及已保存报价中的产品；编辑来自报价的产品会保存一条目录覆盖，删除覆盖后恢复报价名称和货物危险性。')),
        h('section', { className: 'qw-card qw-list' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('产品目录')), h('span', { className: 'qw-badge' }, `${rows.length} / ${products.length}`)),
          h('input', { type: 'search', value: catalogSearch, onChange: e => setCatalogSearch(e.target.value), placeholder: t('搜索产品名称或 CAS'), 'aria-label': t('搜索产品名称或 CAS') }),
          h('div', { className: 'qw-list-body' }, rows.map(row => h('article', { className: 'qw-item', key: row.id || row.cas },
            h('div', { className: 'qw-item-main' }, h('h3', null, row.name), h('p', { className: 'qw-item-meta' }, `CAS ${row.cas}${row.hazard ? ` · 货物危险性 ${row.hazard}` : ''}${Number.isFinite(row.tax) ? ` · 增值税率 ${row.tax}%` : ''}${Number.isFinite(row.rebate) ? ` · 退税率 ${row.rebate}%` : ''}`), row.manualIndex === undefined && note('来自已保存报价')),
            h('div', { className: 'qw-item-actions' },
              button('编辑', () => editProduct(row)),
              button('带入核算', () => {
                setV(old => ({ ...old, product: row.name, cas: row.cas, ...(Number.isFinite(row.tax) ? { tax: row.tax } : {}), ...(Number.isFinite(row.rebate) ? { rebate: row.rebate } : {}) }));
                autofill.current.calc[mode] = row.name; autofill.current.rates[mode] = {}; calcCache.used[mode] = true; setSource(''); setTab('calc');
              }),
              button('带入工厂', () => {
                const hazard = String(row.hazard ?? '').trim();
                setFactory(old => ({ ...old, name: row.name, cas: row.cas, hazard, ...(Number.isFinite(row.tax) ? { tax: row.tax } : {}), ...(Number.isFinite(row.rebate) ? { rebate: row.rebate } : {}) }));
                autofill.current.factory = row.name; autofill.current.factoryHazard = hazard; autofill.current.factoryRates = {}; setTab('factory');
              }),
              row.manualIndex !== undefined && button('删除', () => remove('products', row))))), !rows.length && note('没有符合条件的产品。'))));
    }
    function pageFreight() {
      const avg = averageFreights(selected.map(id => db.freights.find(r => r.id === id)).filter(Boolean));
      const isLcl = freight.transportMode === '海运拼箱';
      return h('div', { className: 'qw-body qw-single' },
        h('div', { className: 'qw-columns' },
          card('新增货代报价',
            h(Fields, { defs: ordered(freightFields, freightOrder), value: freight, onChange: changeFreight, hidden: hiddenFreightFields(freight), className: 'qw-freight-form' }),
            note(isLcl ? '拼箱询价单位默认按重量；如为抛货，请选择「是」并填写体积（CBM）。' : '整柜只需选择柜型；拼箱 / 空运需填写询价数量和单位。'),
            h('div', { className: 'qw-form-foot' }, button('保存货代报价', () => run(async () => { assertTextClean(freightFields, freight); await mutate({ action: 'add', kind: 'freights', record: freightRecord(freight) }); setFreight(emptyForm(freightFields)); }), { className: 'qw-primary' }))),
          card('货代报价比较',
            note(`已选 ${selected.length} 家 · 请选择同起运地、同目的地、同运输方式、同柜型或同询价数量（抛货含体积），且有效期内的报价。`),
            selected.length > 0 && !avg && note('已选报价存在口径不一致、过期或数据不完整，无法计算均值。'),
            avg && metric('国际运费 / 国内费用均值', `USD ${fmt(avg.sea)} / RMB ${fmt(avg.local)}`),
            db.freights.map(freightRow),
            !db.freights.length && note('暂无货代报价'),
            h('div', { className: 'qw-form-foot' }, button('带入核算', () => {
              setV(old => ({ ...old, transportMode: avg.transportMode, sea: mode === 'rmb' ? avg.seaMin : avg.sea, seaMax: avg.seaMax, local: avg.local }));
              calcCache.used[mode] = true;
              setTab('calc');
            }, { disabled: busy || !avg })))));
    }
    function pageHistory() {
      const filtering = Boolean(historyFilter.cas.trim() || historyFilter.customer.trim());
      const rows = db.history.filter(row => historyMatches(row, historyFilter));
      const selectedRows = db.history.filter(row => selectedHistory.includes(row.id));
      const customers = [...new Set(selectedRows.map(row => String(row.values.customer || '').trim()).filter(Boolean))];
      const sameCustomer = selectedRows.length > 0 && customers.length === 1 && selectedRows.every(row => String(row.values.customer || '').trim());
      const missingFactories = selectedRows.filter(row => row.mode !== 'own' && !factoryForHistory(row));
      const canMerge = selectedRows.length > 0 && sameCustomer && missingFactories.length === 0;
      const mergeHint = !selectedRows.length
        ? '勾选同一客户的核算记录后，可合并输出一张报价单。'
        : !sameCustomer
          ? '只能合并同一客户的记录；请检查所选记录的客户名称。'
          : missingFactories.length
            ? `以下记录缺少对应工厂报价：${missingFactories.map(row => row.values.product).join('、')}`
            : `已选 ${selectedRows.length} 条 · ${customers[0]} · 将合并为一张报价单。`;
      return h('div', { className: 'qw-body qw-single' },
        card('核算记录',
          h('div', { className: 'qw-filters' },
            h('label', { className: 'qw-filter' }, h('span', null, t('CAS 关键词')), h('input', { type: 'search', value: historyFilter.cas, onChange: e => setHistoryFilter(old => ({ ...old, cas: e.target.value })), placeholder: t('如 67-68 或 6768'), 'aria-label': t('按 CAS 筛选核算记录') })),
            h('label', { className: 'qw-filter' }, h('span', null, t('客户名称关键词')), h('input', { type: 'search', value: historyFilter.customer, onChange: e => setHistoryFilter(old => ({ ...old, customer: e.target.value })), placeholder: t('如 STIM'), 'aria-label': t('按客户名称筛选核算记录') })),
            filtering && button('清除筛选', () => setHistoryFilter({ cas: '', customer: '' }))),
          h('div', { className: 'qw-history-actions' },
            button('全选当前结果', () => setSelectedHistory(rows.map(row => row.id)), { disabled: busy || !rows.length }),
            selectedHistory.length > 0 && button('清除选择', () => setSelectedHistory([])),
            costingOption(),
            button('合并输出报价单', () => run(exportSelectedHistory), { className: 'qw-primary', disabled: busy || !canMerge })),
          h('p', { className: 'qw-note' }, mergeHint),
          h('p', { className: 'qw-note' }, filtering ? `显示 ${rows.length} / ${db.history.length} 条记录；两项同时填写时须同时满足，均为包含关键词匹配。` : `共 ${db.history.length} 条记录；可按 CAS 或客户名称关键词筛选。`),
          rows.length ? rows.map(historyRow) : note(filtering ? '没有符合 CAS 或客户名称关键词的核算记录。' : '暂无核算记录')));
    }
    function selectCalcProduct({ cas: productCas, name }) {
      const cas = normalizeCas(productCas);
      const changedCas = cas !== normalizeCas(v.cas);
      if (changedCas) setSource('');
      calcCache.used[mode] = true;
      setV(old => {
        // A different product needs a fresh purchase price and CAS-specific rates.
        const values = changedCas && (old.cas || source)
          ? { ...old, buy: null, tax: defaults.tax, rebate: defaults.rebate }
          : old;
        return { ...casFields(values, cas, 'product', 'calc'), product: name };
      });
    }
    function pageCalc() {
      const productLookup = { products, onSelect: selectCalcProduct };
      const pick = (defs, ids) => ids.map(id => defs.find(([key]) => key === id)).filter(Boolean);
      const section = (title, ...children) => h('div', { className: 'qw-section' }, h('h3', null, t(title)), ...children);
      const productFields = pick([...basic, ...costs], ['product', 'cas', 'tax', 'rebate']);
      const factoryField = ['factory', '工厂', 'text'];
      const costFields = [factoryField, ...pick([...basic, ...costs], ['qty', 'buy', 'fx', 'receive', 'sea', 'seaMax', 'local'])];
      const costValues = { ...v, factory: currentFactory?.factory || '' };
      const customerFields = pick(basic, ['customer', 'quoteCountry', 'sell', 'transportMode', 'customerTerm', 'place', 'etd']);
      const rateFields = pick([...basic, ...params], ['creditMonths', 'creditPayment', 'transport', 'credit', 'interest', 'months']);
      const monthsNote = note('资金占用月数默认同账期，可手动修改；手动修改后不再随账期变化。');
      const sections = mode === 'own'
        ? [
            section('01 / 产品与报价', h(Fields, { defs: ordered(basic, basicOrder), value: v, onChange: change, productLookup })),
            section('02 / 成本与参数',
              h(Fields, { defs: ordered([...costs, ...params], calcOrder), value: v, onChange: change, hidden: ['buy', 'fx'], labels: { sea: '最低国际运费 USD/票' } }),
              note('国内费用填写我方承担的完整总额，避免重复计入货代报价。'),
              monthsNote,
              note('自有工厂倒推只需收汇汇率；人民币含税倒推价按增值税率和退税率换算。'))
          ]
        : [
            section('01 / 选取工厂报价',
              h(Fields, { defs: productFields, value: v, onChange: change, productLookup, className: 'qw-3col', spans: { product: 2 }, hidden: mode === 'usd' ? ['tax', 'rebate'] : [] }),
              mode === 'rmb' && note('增值税率和退税率按 CAS 绑定：输入有历史记录的 CAS 自动代入，保存核算后会记住该产品的税率。'),
              h('div', { className: 'qw-source' },
                h('select', { 'aria-label': t('选取工厂报价'), value: activeSource ? source : '', disabled: !sources.length, onChange: e => selectFactory(e.target.value) },
                  h('option', { value: '' }, t(sources.length ? '请选择已保存的工厂报价' : normalizeCas(v.cas) ? '暂无该 CAS 的可用工厂报价' : '暂无可用的工厂报价')),
                  sources.map(row => h('option', { key: row.id, value: row.id }, `${row.name}${row.purity ? `（${row.purity}）` : ''} · ${row.factory || '未填写工厂'} · ${row.incoterm || '待确认'} ${row.port || ''} · 报价日期 ${row.quoteDate || '未记录'} · 有效至 ${row.validity || '未记录'} · ${row.price} ${row.currency}/${row.unit}`))),
                button('带入成本', () => useFactory(activeSource, true), { disabled: busy || !activeSource })),
              activeSource && note(`含量 / 纯度 ${activeSource.purity || '—'} · 其他关键质量指标 ${activeSource.quality || '—'} · 货物危险性 ${activeSource.hazard || '—'} · 工厂条款 ${activeSource.incoterm || '待确认'} · ${activeSource.port || '地点未记录'} · 进仓费承担方 ${activeSource.warehouse || '待确认'} · 港杂费承担方 ${activeSource.portfee || '待确认'}`)),
            section('02 / 工厂与运输成本',
              h(Fields, { defs: costFields, value: costValues, onChange: change, signed: mode === 'usd' ? ['sea', 'seaMax'] : [], className: 'qw-3col', disabled: ['factory'], hidden: mode === 'rmb' ? ['receive'] : [], labels: { buy: mode === 'rmb' ? '含税采购单价 RMB/kg' : '采购单价 USD/kg', fx: mode === 'rmb' ? '收汇汇率 RMB/USD' : '买汇 / 成本汇率 RMB/USD', sea: '最低国际运费 USD/票' } }),
              note('国内费用填写我方承担的完整总额，避免重复计入货代报价。')),
            section('03 / 对客户报价',
              h(Fields, { defs: customerFields, value: v, onChange: change, className: 'qw-3col' })),
            section('04 / 其他费率、资金占用情况',
              h(Fields, { defs: rateFields, value: v, onChange: change, className: 'qw-3col' }),
              monthsNote)
          ];
      const exportHint = !ready ? '补全核算后可输出。' : !v.product?.trim() ? '请先填写产品名称。' : etdInvalid ? 'ETD 只能输入英文字符、数字和标点。' : mode !== 'own' && !currentFactory ? '请先在 01 选择对应工厂报价。' : '生成英文 Quotation 和内部 Costing 工作表，可直接编辑。';
      return h('div', { className: 'qw-body qw-calc' },
        h('section', { className: 'qw-card qw-form' },
          h('div', { className: 'qw-card-head' }, h('h2', { ref: draftFormRef, tabIndex: -1 }, t('报价核算')), button('载入 Excel 样例', () => { setHistorySource(null); start(mode, samples[mode]); })),
          h('div', { className: 'qw-modes' }, ...[['rmb','人民币采购'],['usd','美元采购'],['own','自有工厂倒推']].map(([key,label]) => button(label, () => switchMode(key), { key, 'aria-pressed': mode === key }))),
          ...sections,
          h('div', { className: 'qw-form-foot' }, credit ? note(`${credit.group} 类 · ${credit.period} · 表列 ${credit.rate.toFixed(3)}%（2026–2027.6 费率表）`) : note(v.quoteCountry && v.creditPayment && v.creditMonths != null ? '当前国家、账期和付款方式没有匹配的信保费率，请核对条件或手动填写费率；不可按 0 处理。' : '选择国家、账期和付款方式自动带出信保费率，或直接手填；账期按每月 30 天计算。'))),
        h('section', { className: 'qw-card qw-results' },
          h('div', { className: 'qw-card-head' }, h('h2', null, t('本次核算')), h('span', { className: 'qw-badge' }, t(modeLabels[mode]))),
          h('div', { className: 'qw-export-bar' },
            button('输出报价单', () => run(exportQuotation), {
              className: 'qw-primary qw-export-button',
              disabled: busy || !canExport,
              title: canExport ? '生成可编辑的英文 Excel 报价单' : exportHint,
            }),
            costingOption(),
            note(exportHint)),
          h('div', { className: 'qw-results-body' }, ...results()),
          h('div', { className: 'qw-results-foot' },
            historySource && note('正在编辑历史记录：可另存为新记录，或覆盖原记录。'),
            button(historySource ? '另存为新记录' : '保存本次核算', () => run(() => saveHistory(false)), { className: 'qw-primary', disabled: busy || !ready || !v.product?.trim() }),
            historySource && button('覆盖原记录', () => run(() => saveHistory(true)), { disabled: busy || !ready || !v.product?.trim() }),
            note('沿用原工作台的保险、资金利息及倒推公式；导出的工作簿包含英文 Quotation 和内部 Costing 两个可编辑工作表。'))));
    }
    let body;
    if (!db) body = h('div', { className: 'qw-body qw-single' }, card('报价工作台', note('正在加载报价记录…')));
    else if (tab === 'factory') body = pageFactory();
    else if (tab === 'freight') body = pageFreight();
    else if (tab === 'history') body = pageHistory();
    else if (tab === 'products') body = pageProducts();
    else body = pageCalc();
    return h('div', { className: 'qw-root', ref: rootRef, style: { zoom: String(zoom) } }, h('style', null, css), h('div', { className: 'qw-content' },
      h('header', { className: 'qw-header' },
        h('div', { className: 'qw-brand' }, h('h1', null, t('报价工作台')), h('span', { className: 'qw-sub' }, t('采购 · 物流 · 利润'))),
        h('div', { className: 'qw-toolbar' },
          h('div', { className: 'qw-zoom', role: 'group', 'aria-label': t('界面缩放') },
            h('button', { type: 'button', title: t('缩小（Ctrl + -）'), 'aria-label': t('缩小'), disabled: zoom === zoomSteps[0], onClick: () => setZoom(current => stepZoom(current, -1)) }, 'A−'),
            h('button', { type: 'button', className: 'qw-zoom-value', title: t('恢复默认大小（Ctrl + 0）'), onClick: () => setZoom(1) }, `${Math.round(zoom * 100)}%`),
            h('button', { type: 'button', title: t('放大（Ctrl + =）'), 'aria-label': t('放大'), disabled: zoom === zoomSteps[zoomSteps.length - 1], onClick: () => setZoom(current => stepZoom(current, 1)) }, 'A+')),
          button('刷新记录', () => run(async () => { setDb(await api({ action: 'list' })); setSelected([]); refreshSync(); })),
          sync?.configured && button(sync.pending ? '同步飞书（有待同步）' : '同步飞书', () => run(async () => { setSync(await api({ action: 'syncNow' })); setDb(await api({ action: 'list' })); })),
          button('导出备份', () => run(exportBackup), { disabled: busy || !db }),
          button('导入备份', () => fileInput.current.click(), { disabled: busy || !db }),
          h('input', { ref: fileInput, hidden: true, type: 'file', accept: '.json,application/json', onChange: importBackup }))),
      h('nav', { className: 'qw-tabs', 'aria-label': t('报价工作台') }, ...[['factory','工厂报价'],['calc','报价核算'],['freight','货代报价'],['history','核算记录'],['products','产品目录']].map(([key,label]) => button(label, () => { setTab(key); setMessage(''); }, { key, 'aria-current': tab === key ? 'page' : undefined }))),
      (error || message) && h('div', { className: 'qw-alerts' }, error && h('p', { className: 'qw-error', role: 'alert' }, error), message && h('p', { className: 'qw-status', role: 'status' }, message)),
      sync?.conflicts?.length ? h('div', { className: 'qw-alerts' }, h('p', { className: 'qw-error', role: 'alert' }, t('检测到飞书端与本地同时修改了以下记录，请选择保留哪一端：')),
        sync.conflicts.map(c => h('div', { key: `${c.kind}:${c.id}`, className: 'qw-conflict' },
          h('span', null, `${TABLE_LABELS[c.kind] || c.kind} · ${c.name || c.id}：${c.fields.map(f => t(FIELD_LABELS[f.key] || f.key)).join('、')}`),
          h('span', { className: 'qw-conflict-actions' },
            button('保留本地', () => run(async () => { setSync(await api({ action: 'syncResolve', kind: c.kind, id: c.id, choices: Object.fromEntries(c.fields.map(f => [f.key, 'local'])) })); }), { className: 'qw-mini' }),
            button('采用远端', () => run(async () => { setSync(await api({ action: 'syncResolve', kind: c.kind, id: c.id, choices: Object.fromEntries(c.fields.map(f => [f.key, 'remote'])) })); setDb(await api({ action: 'list' })); }), { className: 'qw-mini' }))))) : null,
      body,
      h('p', { className: 'qw-foot-note' }, t('记录保存在 Harness 中；未保存的草稿在离开工作台后保留 5 分钟，超过 5 分钟未操作则清空。支持导入原工作台的 JSON 备份。'))));
  }
  function Settings() {
    useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const [state, setState] = useState(null), [choice, setChoice] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
    const [sync, setSync] = useState(null), [syncBusy, setSyncBusy] = useState(false), [syncMsg, setSyncMsg] = useState(''), [syncErr, setSyncErr] = useState('');
    const [appId, setAppId] = useState(''), [appSecret, setAppSecret] = useState(''), [appToken, setAppToken] = useState(''), [enable, setEnable] = useState(false);
    const [authCode, setAuthCode] = useState('');
    function applySync(s) {
      setSync(s);
      if (s?.settings) { setAppToken(s.settings.appToken || ''); setEnable(Boolean(s.settings.enable)); }
      // 已保存的 App ID 回填（App Secret 永不回传，留空表示沿用已保存值）。
      if (s?.credential?.appId) setAppId(s.credential.appId);
    }
    async function loadSync() {
      setSyncErr(''); setSyncMsg('');
      try { applySync(await api({ action: 'syncStatus' })); } catch (e) { setSyncErr(e.message); }
    }
    async function saveSync() {
      setSyncBusy(true); setSyncErr(''); setSyncMsg('');
      try {
        // 只有同时填了 App ID 和 App Secret 才提交新凭据；否则沿用已保存的（Secret 从不回填明文）。
        const credential = appId && appSecret ? { appId, appSecret } : undefined;
        const s = await api({ action: 'syncSetup', credential, appToken, enable });
        applySync(s); setAppSecret('');
        setSyncMsg(s?.warning ? `${t('配置已保存，但同步未就绪')}：${s.warning}` : t('飞书同步设置已保存，并已检查/创建数据表。'));
      } catch (e) { setSyncErr(e.message); } finally { setSyncBusy(false); }
    }
    async function runSync() {
      setSyncBusy(true); setSyncErr(''); setSyncMsg('');
      try { applySync(await api({ action: 'syncNow' })); setSyncMsg(t('已完成一次全量拉取与推送。')); }
      catch (e) { setSyncErr(e.message); } finally { setSyncBusy(false); }
    }
    async function startAuth() {
      setSyncBusy(true); setSyncErr(''); setSyncMsg('');
      try {
        const base = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
        const { url } = await api({ action: 'syncAuthUrl', base });
        // 新窗口打开飞书授权页。
        if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
        else setSyncMsg(url);
      } catch (e) { setSyncErr(e.message); } finally { setSyncBusy(false); }
    }
    async function submitAuthCode() {
      setSyncBusy(true); setSyncErr(''); setSyncMsg('');
      try {
        // 用户可能粘贴整条回调 URL，从中提取 code。
        const m = /[?&]code=([^&]+)/.exec(authCode);
        const code = m ? decodeURIComponent(m[1]) : authCode.trim();
        applySync(await api({ action: 'syncAuth', code }));
        setAuthCode('');
        setSyncMsg(t('飞书账号授权成功。'));
      } catch (e) { setSyncErr(e.message); } finally { setSyncBusy(false); }
    }
    async function logoutAuth() {
      setSyncBusy(true); setSyncErr(''); setSyncMsg('');
      try { applySync(await api({ action: 'syncLogout' })); setSyncMsg(t('已退出飞书账号授权。')); }
      catch (e) { setSyncErr(e.message); } finally { setSyncBusy(false); }
    }
    useEffect(() => { loadSync(); }, []);
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
        h('hr', { className: 'qw-settings-sep' }),
        h('h2', null, t('飞书同步')),
        h('p', { className: 'qw-note' }, t('把工厂报价、货代报价、核算记录、产品目录同步到飞书多维表格（Bitable）。业务数据经飞书开放平台服务端接口读写，需先在飞书开放平台创建自建应用并开通多维表格权限。')),
        h('label', { className: 'qw-settings-field' }, h('span', null, t('App ID')),
          h('input', { type: 'text', value: appId, disabled: syncBusy, placeholder: t('飞书应用 App ID'), onChange: e => setAppId(e.target.value.trim()) })),
        h('label', { className: 'qw-settings-field' }, h('span', null, t('App Secret')),
          h('input', { type: 'password', value: appSecret, disabled: syncBusy, placeholder: sync?.credential?.configured ? t('已保存，留空则不修改') : t('飞书应用 App Secret'), onChange: e => setAppSecret(e.target.value.trim()) })),
        h('label', { className: 'qw-settings-field' }, h('span', null, t('多维表格 app_token')),
          h('input', { type: 'text', value: appToken, disabled: syncBusy, placeholder: t('多维表格 Base 的 app_token'), onChange: e => setAppToken(e.target.value.trim()) })),
        h('label', { className: 'qw-check' }, h('input', { type: 'checkbox', checked: enable, disabled: syncBusy, onChange: e => setEnable(e.target.checked) }), t('启用飞书同步')),
        h('h3', { className: 'qw-settings-subhead' }, t('个人账号授权')),
        h('p', { className: 'qw-note' }, t('同步使用你本人的飞书账号身份。先保存上面的应用配置，再点击授权，登录飞书并同意后即可。此后你的修改会以你的名义写入多维表格的「最后修改人」列。')),
        sync?.user?.authorized
          ? h('div', { className: 'qw-settings-actions' },
            h('span', { className: 'qw-note' }, `${t('当前已授权')}：${sync.user.name || sync.user.open_id}`),
            h('button', { type: 'button', disabled: syncBusy, onClick: startAuth }, t('重新授权')),
            h('button', { type: 'button', disabled: syncBusy, onClick: logoutAuth }, t('退出授权')))
          : h('div', { className: 'qw-settings-actions' },
            h('button', { type: 'button', className: 'qw-settings-primary', disabled: syncBusy || !sync?.credential?.configured, onClick: startAuth }, t('授权飞书账号'))),
        h('label', { className: 'qw-settings-field' }, h('span', null, t('或粘贴授权码')),
          h('input', { type: 'text', value: authCode, disabled: syncBusy, placeholder: t('从回调地址粘贴 code 或整条 URL'), onChange: e => setAuthCode(e.target.value) })),
        h('div', { className: 'qw-settings-actions' },
          h('button', { type: 'button', disabled: syncBusy || !authCode.trim(), onClick: submitAuthCode }, t('提交授权码'))),
        sync && h('p', { className: 'qw-note' }, sync.configured ? t('飞书同步已就绪。') : t('飞书同步尚未配置完整（需 App ID、App Secret、app_token 与四张表）。')),
        h('div', { className: 'qw-settings-actions' },
          h('button', { type: 'button', className: 'qw-settings-primary', disabled: syncBusy, onClick: saveSync }, t('保存飞书设置')),
          h('button', { type: 'button', disabled: syncBusy || !sync?.configured, onClick: runSync }, t('立即同步'))),
        syncErr && h('p', { className: 'qw-settings-error', role: 'alert' }, syncErr),
        syncMsg && h('p', { className: 'qw-settings-status', role: 'status' }, syncMsg),
        !state && !error && h('p', { className: 'qw-note' }, t('正在读取可用模型…')),
        state && h('p', { className: 'qw-note' }, state.effective ? `${t('当前生效')}：${state.effective.label}` : t('当前没有可用模型。请先在 Harness 设置里接入模型，或选择「跟随 Harness 默认模型」。')),
        state && !providers.length && h('p', { className: 'qw-note' }, t('没有发现已公布模型的提供方；仍可跟随 Harness 默认模型，或先到 设置 → 模型 接入模型。'))));
  }
  return { App, Icon, Settings };
}
