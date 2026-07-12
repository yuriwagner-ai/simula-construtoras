/* =============================================================================
   app.js — Renderização das abas, cards de calculadora e cálculo ao vivo.
   ===========================================================================*/

const fmtMoney = (n) =>
  isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';
const fmtPct = (n) =>
  isFinite(n) ? (n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—';
const fmtVal = (v, fmt) =>
  fmt === 'pct' ? fmtPct(v) : fmt === 'text' ? v : fmtMoney(v);

// Converte texto digitado/colado em número, aceitando formato brasileiro.
// Ex.: "1.490,50" -> 1490.5 ; "1490.50" -> 1490.5 ; "1.234.567" -> 1234567
function parseBR(str) {
  if (typeof str !== 'string') return Number(str) || 0;
  str = str.replace(/[^\d.,-]/g, ''); // mantém só dígitos, ponto, vírgula e sinal
  if (!str) return 0;
  if (str.indexOf(',') !== -1) {
    // tem vírgula: vírgula é decimal, pontos são milhar
    str = str.replace(/\./g, '').replace(',', '.');
  } else {
    const pontos = (str.match(/\./g) || []).length;
    if (pontos > 1) {
      str = str.replace(/\./g, ''); // vários pontos = separadores de milhar
    } else if (pontos === 1 && /\.\d{3}$/.test(str)) {
      str = str.replace('.', ''); // um ponto com 3 dígitos após = milhar (ex.: 1.490)
    }
    // caso contrário, ponto único é tratado como decimal (ex.: 1490.50)
  }
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

let construtoraAtiva = ORDEM_CONSTRUTORAS[0];
let cardSeq = 0;
// guarda os valores digitados por card: { [cardId]: { campo: valor } }
const estado = {};
// quais cards estão visíveis na aba ativa
let cardsAtivos = [];
// último card em que o usuário interagiu (alvo do "Limpar atual")
let cardAtivo = null;

/* ----------------------------------------------------------------- ABAS */
function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  ORDEM_CONSTRUTORAS.forEach((id) => {
    const c = CONSTRUTORAS[id];
    const tab = document.createElement('button');
    tab.className = 'tab' + (id === construtoraAtiva ? ' active' : '');
    tab.textContent = c.nome;
    tab.style.setProperty('--tab-color', c.cor);
    tab.onclick = () => selecionarConstrutora(id);
    nav.appendChild(tab);
  });
}

function selecionarConstrutora(id) {
  construtoraAtiva = id;
  cardsAtivos = [];
  renderTabs();
  const c = CONSTRUTORAS[id];
  document.getElementById('tituloConstrutora').textContent = 'Calculadora ' + c.nome;
  document.getElementById('obsConstrutora').textContent = c.obs || '';
  document.getElementById('cards').innerHTML = '';
  adicionarCard(); // começa com uma calculadora
}

/* ----------------------------------------------------------------- CARDS */
// Campos com `autoDefault` se recalculam a partir de outros (ex.: 30% da renda),
// até que o usuário edite o campo manualmente (passa a constar em st.touched).
function aplicarAutos(st, c) {
  c.fields.forEach((f) => {
    if (f.autoDefault && !st.touched[f.key]) {
      st.valores[f.key] = f.autoDefault(st.valores);
    }
  });
}

function adicionarCard() {
  const id = 'card_' + (++cardSeq);
  const c = CONSTRUTORAS[construtoraAtiva];
  estado[id] = { construtora: construtoraAtiva, valores: {}, touched: {} };
  // defaults
  c.fields.forEach((f) => (estado[id].valores[f.key] = f.def));
  aplicarAutos(estado[id], c); // preenche campos automáticos (ex.: parcela Caixa)
  if (c.produtos) estado[id].produto = Object.keys(c.produtos)[0];
  cardsAtivos.push(id);
  cardAtivo = id;

  const card = document.createElement('article');
  card.className = 'card';
  card.id = id;
  card.style.setProperty('--card-color', c.cor);
  document.getElementById('cards').appendChild(card);
  renderCard(id);
}

function removerCard(id) {
  delete estado[id];
  cardsAtivos = cardsAtivos.filter((x) => x !== id);
  document.getElementById(id)?.remove();
}

function renderCard(id) {
  const card = document.getElementById(id);
  const c = CONSTRUTORAS[construtoraAtiva];
  const st = estado[id];
  const idx = cardsAtivos.indexOf(id) + 1;

  // cabeçalho
  let html = `
    <div class="card-head">
      <span class="card-title">${c.nome} • Simulação ${idx}</span>
      <button class="card-remove" title="Remover" data-act="remove">✕</button>
    </div>`;

  // seletor de produto (Telesil)
  if (c.produtos) {
    html += `<div class="field full"><label>Produto</label><select data-produto>`;
    for (const [pid, p] of Object.entries(c.produtos)) {
      html += `<option value="${pid}" ${pid === st.produto ? 'selected' : ''}>${p.nome}</option>`;
    }
    html += `</select></div>`;
  }

  // campos
  html += `<p class="section-label">Dados da proposta</p><div class="fields-grid">`;
  c.fields.forEach((f) => {
    const v = st.valores[f.key];
    const disabled = f.productControlled && c.produtos && st.produto !== 'custom' ? 'disabled' : '';
    const ro = f.info ? '' : ''; // info fields editáveis mas estilizados
    const cls = 'field ' + (f.type === 'money' ? 'money ' : '') + (f.info ? 'info ' : '');
    // dinheiro = text (aceita "1.490,50"); contagens = number
    const tipoInput = f.type === 'money'
      ? 'type="text" inputmode="decimal"'
      : 'type="number" step="any" inputmode="decimal"';
    html += `<div class="${cls}">
      <label>${f.label}</label>
      <div class="input-wrap">
        ${f.type === 'money' ? '<span class="prefix">R$</span>' : ''}
        <input ${tipoInput} data-key="${f.key}" value="${v}" ${disabled} ${ro}/>
      </div>
      ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
    </div>`;
  });
  html += `</div><div class="divider"></div><div data-result></div>`;
  html += `<button class="btn btn-primary card-resumo" data-act="resumo">📄 Resumo p/ cliente</button>`;

  card.innerHTML = html;

  // listeners
  card.querySelector('[data-act="resumo"]').onclick = () => abrirResumo(id);
  card.addEventListener('focusin', () => (cardAtivo = id));
  card.addEventListener('mousedown', () => (cardAtivo = id));
  card.querySelector('[data-act="remove"]').onclick = () => removerCard(id);
  const sel = card.querySelector('[data-produto]');
  if (sel) {
    sel.onchange = (e) => {
      st.produto = e.target.value;
      const p = c.produtos[st.produto];
      // aplica os parâmetros que o produto definir (ex.: q80/q20 na Telesil);
      // produtos que são só rótulo (Engenharq/Engemat) não alteram campos.
      if (st.produto !== 'custom') {
        Object.keys(p).forEach((k) => { if (k !== 'nome') st.valores[k] = p[k]; });
      }
      renderCard(id);
    };
  }
  card.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.oninput = (e) => {
      const f = c.fields.find((x) => x.key === e.target.dataset.key);
      let val = f.type === 'money' ? parseBR(e.target.value) : parseFloat(e.target.value);
      if (isNaN(val)) val = 0;
      st.valores[f.key] = f.type === 'int' ? Math.round(val) : val;
      st.touched[f.key] = true; // campo passou a ser controlado pelo usuário
      // re-sincroniza campos automáticos ainda não editados (ex.: parcela Caixa = 30% da renda)
      aplicarAutos(st, c);
      c.fields.forEach((af) => {
        if (af.autoDefault && !st.touched[af.key]) {
          const el = card.querySelector(`input[data-key="${af.key}"]`);
          if (el && document.activeElement !== el) el.value = st.valores[af.key];
        }
      });
      atualizarResultado(id);
    };
  });

  atualizarResultado(id);
}

function atualizarResultado(id) {
  const c = CONSTRUTORAS[construtoraAtiva];
  const st = estado[id];
  const out = document.getElementById(id).querySelector('[data-result]');
  const r = c.compute(st.valores);

  const checks = r.status.checks
    .map((ch) => `<li class="${ch.ok ? 'ok' : ''}">${ch.label}</li>`)
    .join('');

  const destaque = r.destaque
    .map((d) => `<div class="box ${d.forte ? 'forte' : ''}">
      <div class="k">${d.label}</div>
      <div class="v">${fmtVal(d.valor, d.fmt)}</div>
    </div>`)
    .join('');

  const linhas = r.linhas
    .map((l) => `<li class="${l.alerta ? 'alerta' : ''}">
      <span class="k">${l.label}</span><span class="v">${fmtVal(l.valor, l.fmt)}</span>
    </li>`)
    .join('');

  out.innerHTML = `
    <div class="status ${r.status.ok ? 'ok' : 'bad'}">
      ${r.status.ok ? '✓ ' : '⚠ '}${r.status.titulo}
      <ul class="checks">${checks}</ul>
    </div>
    <p class="section-label">Resultado</p>
    <div class="destaque">${destaque}</div>
    <ul class="linhas">${linhas}</ul>`;
}

/* ----------------------------------------------------------------- RESUMO */
// Abre um popup com as informações finais da simulação para apresentar ao cliente.
function abrirResumo(id) {
  const st = estado[id];
  if (!st) return;
  const c = CONSTRUTORAS[st.construtora];
  const produtoNome = c.produtos && st.produto ? c.produtos[st.produto].nome : '';
  const titulo = produtoNome && produtoNome !== c.nome ? c.nome + ' — ' + produtoNome : c.nome;
  const r = c.compute(st.valores);
  const itens = c.resumo(st.valores, fmtMoney);

  const linhasHtml = itens
    .map((it) => `<div class="resumo-row">
      <span class="resumo-k">${it.label}</span>
      <span class="resumo-v">${it.fmt === 'text' ? it.valor : fmtVal(it.valor, it.fmt)}</span>
    </div>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="--card-color:${c.cor}">
      <div class="modal-head">
        <div>
          <div class="modal-title">${titulo}</div>
          <div class="modal-status ${r.status.ok ? 'ok' : 'bad'}">${r.status.ok ? '✓ ' : '⚠ '}${r.status.titulo}</div>
        </div>
        <button class="card-remove" data-act="fechar" title="Fechar">✕</button>
      </div>
      <div class="modal-body">${linhasHtml}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="fechar">Fechar</button>
        <button class="btn btn-primary" data-act="imprimir">🖨️ Imprimir / PDF</button>
      </div>
    </div>`;

  const fechar = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
  overlay.querySelectorAll('[data-act="fechar"]').forEach((b) => (b.onclick = fechar));
  overlay.querySelector('[data-act="imprimir"]').onclick = () => window.print();
  document.body.appendChild(overlay);
}

/* ----------------------------------------------------------------- LIMPAR */
// Zera os campos monetários de um card (mantém nº de parcelas/produto) e
// religa os campos automáticos (parcela Caixa, intercalada) à renda.
function limparCard(id) {
  const st = estado[id];
  if (!st) return;
  const c = CONSTRUTORAS[st.construtora];
  c.fields.forEach((f) => {
    if (f.type === 'money') st.valores[f.key] = 0;
  });
  st.touched = {};
  aplicarAutos(st, c);
  renderCard(id);
}

function limparAtual() {
  const alvo = cardsAtivos.includes(cardAtivo) ? cardAtivo : cardsAtivos[cardsAtivos.length - 1];
  if (alvo) limparCard(alvo);
}

function limparTodas() {
  cardsAtivos.slice().forEach(limparCard);
}

/* ----------------------------------------------------------------- INIT */
document.getElementById('btnDuplicar').onclick = adicionarCard;
document.getElementById('btnLimparAtual').onclick = limparAtual;
document.getElementById('btnLimpar').onclick = limparTodas;
selecionarConstrutora(construtoraAtiva);
