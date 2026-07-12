/* =============================================================================
   data.js — Configuração das construtoras e lógica de cálculo
   Espelha as planilhas de referência. Ver directives/calculadora_construtoras.md
   ===========================================================================*/

// Helpers de premissa (Telesil / Engenharq / Engemat)
function premissaSaude({ parcela, capacidade, entradaPct, fi }) {
  const okParcela = parcela < capacidade;
  const okEntrada = entradaPct < 0.19;
  const okFi = fi >= 0.77;
  const ok = okParcela && okEntrada && okFi;
  return {
    ok,
    titulo: ok ? 'Agora Sim! Negociação saudável' : 'Precisa ajustar a proposta',
    checks: [
      { label: 'Maior parcela mensal da entrada < 30% da renda', ok: okParcela },
      { label: 'Entrada parcelada < 19% do imóvel', ok: okEntrada },
      { label: 'F.I. Real ≥ 77%', ok: okFi },
    ],
  };
}

// Menor sinal que atende às 3 premissas (mantendo os demais aportes fixos):
//  - F.I. ≥ 77%             -> total ≥ 0,77·líquido
//  - entrada ≤ 19% imóvel   -> total ≥ 0,81·líquido − intercaladas
//  - maior parcela ≤ 30%    -> entrada ≤ entradaMax
// `aportesFixos` = aportes sem o sinal (FGTS+subsídio+financiamento+chaves).
// `mcemAbate` é o valor do benefício MCEM: reduz a entrada efetiva, então alivia as
// premissas de F.I. e de entrada ≤ 19% — mas NÃO a da parcela (o valor pago por mês não muda).
function menorSinalSaudavel(liquido, aportesFixos, interTotal, entradaMax, mcemAbate = 0) {
  const tFi = 0.77 * liquido - aportesFixos - mcemAbate;
  const tEntrada19 = 0.81 * liquido - aportesFixos - interTotal - mcemAbate;
  const tParcela = liquido - aportesFixos - interTotal - entradaMax;
  return Math.max(tFi, tEntrada19, tParcela);
}

// Aplica o benefício MCEM eliminando parcelas de trás para frente:
// primeiro o bloco 20% inteiro (pago por último) e só então parcelas finais do 80%.
// Arredonda para baixo: só remove parcelas totalmente cobertas pelo valor do benefício.
function eliminarParcelasMcem({ mcem, q80, q20, parcela80, parcela20 }) {
  let restante = Math.max(mcem || 0, 0);
  const elim20 = parcela20 > 0 ? Math.min(q20, Math.floor(restante / parcela20)) : 0;
  restante -= elim20 * parcela20;
  // só avança para o bloco 80% se o bloco 20% foi totalmente eliminado
  let elim80 = 0;
  if (elim20 === q20) {
    elim80 = parcela80 > 0 ? Math.min(q80, Math.floor(restante / parcela80)) : 0;
    restante -= elim80 * parcela80;
  }
  const parcelasEliminadas = elim20 + elim80;
  return {
    elim20, elim80, parcelasEliminadas,
    q20Pagas: q20 - elim20,
    q80Pagas: q80 - elim80,
    mcemAplicado: (mcem || 0) - restante, // valor efetivamente usado (parcelas inteiras)
  };
}

const CONSTRUTORAS = {
  /* ---------------------------------------------------------------- TELESIL */
  telesil: {
    nome: 'Telesil',
    cor: '#2563eb',
    obs: 'Entrada em 80% + 20% pagos em sequência (primeiro o bloco 80%, depois o 20%). Nº de parcelas varia por produto.',
    produtos: {
      'grand-via':         { nome: 'Grand Via',        q80: 35, q20: 24 },
      'splendido':         { nome: 'Splendido',        q80: 35, q20: 24 },
      'reserva-aldeprime': { nome: 'Reserva Aldeprime', q80: 28, q20: 28 },
      'custom':            { nome: 'Outro (manual)',   q80: 35, q20: 24 },
    },
    fields: [
      { key: 'renda',        label: 'Renda do cliente',        type: 'money', def: 7627.29 },
      { key: 'valorTabela',  label: 'Valor de tabela',         type: 'money', def: 275990.39 },
      { key: 'desconto',     label: 'Desconto de tabela',      type: 'money', def: 0 },
      { key: 'descontoMcem', label: 'Desconto MCEM',           type: 'money', def: 0 },
      { key: 'sinal',        label: 'Sinal (ato)',             type: 'money', def: 50000 },
      { key: 'sinalIntercalado', label: 'Sinal intercalado (2ª parte do sinal)', type: 'money', def: 0 },
      { key: 'financiamento',label: 'Financiamento aprovado',  type: 'money', def: 208000 },
      { key: 'fgts',         label: 'FGTS',                    type: 'money', def: 0 },
      { key: 'subsidio',     label: 'Subsídio',                type: 'money', def: 0 },
      { key: 'semestrais',   label: 'Nº de semestrais',        type: 'int',   def: 0 },
      { key: 'valorIntercalada', label: 'Valor da intercalada (semestral)', type: 'money',
        autoDefault: (v) => Math.round(v.renda * 0.50 * 100) / 100 },
      { key: 'parcelaCaixa', label: 'Parcela Caixa (pós-chaves)', type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round(v.renda * 0.30 * 100) / 100 },
      { key: 'q80',          label: 'Parcelas do bloco 80%',   type: 'int',   def: 35 },
      { key: 'q20',          label: 'Parcelas do bloco 20%',   type: 'int',   def: 24 },
    ],
    compute(i) {
      const liquido = i.valorTabela - i.desconto;
      const capacidade = i.renda * 0.30;
      const valorInter = i.valorIntercalada || 0;       // valor de cada intercalada (editável)
      const semestraisTotal = valorInter * i.semestrais; // soma de todas as intercaladas
      const temInter = i.semestrais > 0;
      const sinalTotal = i.sinal + (i.sinalIntercalado || 0); // sinal pode ser dividido em 2x
      const total = sinalTotal + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - semestraisTotal;
      const bloco80 = entrada * 0.8, bloco20 = entrada * 0.2;
      const parcela80 = i.q80 > 0 ? bloco80 / i.q80 : 0;
      const parcela20 = i.q20 > 0 ? bloco20 / i.q20 : 0;
      // MCEM: quita parcelas do fim (20% e depois 80%) sem mudar o valor de cada parcela.
      const mcem = i.descontoMcem || 0;
      const m = eliminarParcelasMcem({ mcem, q80: i.q80, q20: i.q20, parcela80, parcela20 });
      const temMcem = m.parcelasEliminadas > 0;
      // Blocos são SEQUENCIais: paga as q80 parcelas e só depois as q20.
      // O mês mais pesado é a maior das duas parcelas (+ a intercalada nos meses que ela cai).
      // A premissa dos 30% mede a PARCELA MENSAL (a intercalada é semestral, paga
      // com 13º/renda extra — não entra no comprometimento mensal).
      const parcelaMaxBloco = Math.max(parcela80, parcela20);
      const mesMaisPesado = parcelaMaxBloco + (temInter ? valorInter : 0); // informativo
      const totalParcelar = entrada + semestraisTotal; // entrada parcelada + intercaladas
      // O MCEM abate a entrada efetiva: melhora Entrada% e F.I. (conta como cobertura do
      // imóvel), mas NÃO reduz a parcela mensal — o cliente paga a parcela cheia nos
      // primeiros meses; o benefício apenas elimina as parcelas do fim.
      const entradaEfetiva = entrada - m.mcemAplicado;
      const fi = liquido ? (total + m.mcemAplicado) / liquido : 0;
      const entradaPct = liquido ? entradaEfetiva / liquido : 0;
      const status = premissaSaude({ parcela: parcelaMaxBloco, capacidade, entradaPct, fi });
      // sinal sugerido: usa a parcela mensal real (sem a intercalada) e nunca passa
      // do ponto em que a entrada chega a zero (sinalMax).
      const k = Math.max(i.q80 > 0 ? 0.8 / i.q80 : Infinity, i.q20 > 0 ? 0.2 / i.q20 : Infinity);
      const entradaMax = capacidade / k;
      const sinalMax = liquido - (total - i.sinal) - semestraisTotal; // sinal que zera a entrada
      const sinalSug = Math.min(menorSinalSaudavel(liquido, total - i.sinal, semestraisTotal, entradaMax, m.mcemAplicado), sinalMax);
      return {
        status,
        destaque: [
          { label: 'Entrada parcelada', valor: entrada, fmt: 'money' },
          { label: `Parcela 80% — 1ª fase (${m.q80Pagas}x)`, valor: parcela80, fmt: 'money' },
          ...(m.q20Pagas > 0 ? [{ label: `Parcela 20% — 2ª fase (${m.q20Pagas}x)`, valor: parcela20, fmt: 'money' }] : []),
          ...(temInter ? [{ label: 'Intercalada (semestral)', valor: valorInter, fmt: 'money' }] : []),
          { label: 'Maior parcela mensal', valor: parcelaMaxBloco, fmt: 'money', forte: true },
        ],
        linhas: [
          { label: 'Líquido (tabela − desconto)', valor: liquido, fmt: 'money' },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Total aportado', valor: total, fmt: 'money' },
          { label: 'Total das intercaladas', valor: semestraisTotal, fmt: 'money' },
          { label: 'Total a parcelar (entrada + intercaladas)', valor: totalParcelar, fmt: 'money' },
          ...(temInter ? [{ label: 'Mês mais pesado (parcela + intercalada)', valor: mesMaisPesado, fmt: 'money' }] : []),
          ...(temMcem ? [
            { label: 'Desconto MCEM aplicado', valor: m.mcemAplicado, fmt: 'money' },
            { label: 'Parcelas eliminadas (MCEM)', valor: `${m.parcelasEliminadas} (${m.elim20} do 20% + ${m.elim80} do 80%)`, fmt: 'text' },
            { label: 'Entrada parcelada efetiva (após MCEM)', valor: entradaEfetiva, fmt: 'money' },
          ] : []),
          { label: 'Entrada % do imóvel', valor: entradaPct, fmt: 'pct' },
          { label: 'F.I. Real', valor: fi, fmt: 'pct' },
          ...(!status.ok && sinalSug > i.sinal
            ? [{ label: 'Sinal sugerido p/ ficar saudável', valor: Math.ceil(sinalSug), fmt: 'money', alerta: true }]
            : []),
        ],
      };
    },
    // Resumo para apresentar ao cliente (popup). `money` é o formatador de R$.
    resumo(i, money) {
      const liquido = i.valorTabela - i.desconto;
      const valorInter = i.valorIntercalada || 0;
      const semestraisTotal = valorInter * i.semestrais;
      const total = i.sinal + (i.sinalIntercalado || 0) + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - semestraisTotal;
      const parcela80 = i.q80 > 0 ? (entrada * 0.8) / i.q80 : 0;
      const parcela20 = i.q20 > 0 ? (entrada * 0.2) / i.q20 : 0;
      const mcem = i.descontoMcem || 0;
      const m = eliminarParcelasMcem({ mcem, q80: i.q80, q20: i.q20, parcela80, parcela20 });
      return [
        { label: 'Valor do imóvel', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor do imóvel com desconto', valor: liquido, fmt: 'money' },
        { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
        { label: 'Sinal (ato)', valor: i.sinal, fmt: 'money' },
        { label: 'Sinal intercalado', valor: i.sinalIntercalado || 0, fmt: 'money' },
        ...(mcem > 0 ? [
          { label: 'Desconto MCEM', valor: mcem, fmt: 'money' },
          { label: 'Parcelas eliminadas', valor: `${m.parcelasEliminadas} (${m.elim20} do bloco 20% + ${m.elim80} do bloco 80%)`, fmt: 'text' },
        ] : []),
        { label: 'Entrada parcelada', valor: entrada, fmt: 'money' },
        { label: 'Mensais',
          valor: (m.q80Pagas > 0 || m.q20Pagas > 0)
            ? `Bloco 80%: ${m.q80Pagas}x de ${money(parcela80)}` +
              (m.q20Pagas > 0 ? `\nBloco 20%: ${m.q20Pagas}x de ${money(parcela20)}` : '')
            : '— (todas as parcelas quitadas pelo MCEM)',
          fmt: 'text' },
        { label: 'Intercaladas semestrais', valor: i.semestrais > 0 ? `${i.semestrais}x de ${money(valorInter)}` : '—', fmt: 'text' },
        { label: 'Valor total das intercaladas', valor: semestraisTotal, fmt: 'money' },
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },

  /* -------------------------------------------------------------- ENGENHARQ */
  engenharq: {
    nome: 'Engenharq',
    cor: '#16a34a',
    obs: 'Só parcela uma carteira de até R$50 mil em até 100x. O que exceder esse teto precisa ser distribuído entre sinal e chaves.',
    TETO_CARTEIRA: 50000,
    produtos: {
      'castanheiras': { nome: 'Castanheiras' },
      'jacarandas':   { nome: 'Jacarandás' },
      'jequitibas':   { nome: 'Jequitibás' },
      'coqueirais':   { nome: 'Coqueirais' },
      'figueiras':    { nome: 'Figueiras' },
    },
    fields: [
      { key: 'renda',         label: 'Renda do cliente',       type: 'money', def: 6300 },
      { key: 'valorTabela',   label: 'Valor de tabela',        type: 'money', def: 296300 },
      { key: 'desconto',      label: 'Desconto de tabela',     type: 'money', def: 15000 },
      { key: 'sinal',         label: 'Sinal (ato)',            type: 'money', def: 10000 },
      { key: 'sinalParcelado',label: 'Sinal parcelado',        type: 'money', def: 0 },
      { key: 'chaves',        label: 'Chaves',                 type: 'money', def: 11300 },
      { key: 'financiamento', label: 'Financiamento aprovado', type: 'money', def: 200000 },
      { key: 'fgts',          label: 'FGTS',                   type: 'money', def: 0 },
      { key: 'subsidio',      label: 'Subsídio',               type: 'money', def: 0 },
      { key: 'qtdMensais',    label: 'Nº de parcelas (até 100)', type: 'int',  def: 100 },
      { key: 'parcelaCaixa',  label: 'Parcela Caixa (pós-chaves)', type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round(v.renda * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const TETO = 50000;
      const liquido = i.valorTabela - i.desconto;
      const capacidade = i.renda * 0.30;
      const total = i.sinal + i.sinalParcelado + i.chaves + i.fgts + i.subsidio + i.financiamento;
      // Quanto ainda falta cobrir do imóvel além dos aportes:
      const entradaNecessaria = liquido - total;
      // A construtora só parcela até R$50 mil dessa carteira:
      const carteira = Math.min(Math.max(entradaNecessaria, 0), TETO);
      const excedente = Math.max(0, entradaNecessaria - TETO);
      const parcela = i.qtdMensais > 0 ? carteira / i.qtdMensais : 0;
      const fi = liquido ? total / liquido : 0;
      const dentroTeto = excedente <= 0 && entradaNecessaria >= 0;
      const status = {
        ok: dentroTeto,
        titulo: dentroTeto
          ? 'Carteira dentro do teto de R$50 mil'
          : 'Acima do teto — distribuir excedente entre sinal e chaves',
        checks: [
          { label: 'Carteira a parcelar ≤ R$50 mil em até 100x', ok: dentroTeto },
        ],
      };
      return {
        status,
        destaque: [
          { label: 'Carteira a parcelar', valor: carteira, fmt: 'money' },
          { label: `Parcela mensal (${i.qtdMensais}x)`, valor: parcela, fmt: 'money', forte: true },
          ...(excedente > 0
            ? [{ label: 'Distribuir entre sinal/chaves', valor: excedente, fmt: 'money', forte: true }]
            : []),
        ],
        linhas: [
          { label: 'Líquido (tabela − desconto)', valor: liquido, fmt: 'money' },
          { label: 'Total aportado', valor: total, fmt: 'money' },
          { label: 'Entrada necessária (além dos aportes)', valor: entradaNecessaria, fmt: 'money' },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'F.I. Real', valor: fi, fmt: 'pct' },
          ...(excedente > 0
            ? [
                { label: 'Excedente acima do teto de R$50 mil', valor: excedente, fmt: 'money', alerta: true },
                { label: 'Sinal sugerido (se todo excedente virar sinal)', valor: Math.ceil(i.sinal + excedente), fmt: 'money', alerta: true },
              ]
            : []),
        ],
      };
    },
    resumo(i, money) {
      const TETO = 50000;
      const liquido = i.valorTabela - i.desconto;
      const total = i.sinal + i.sinalParcelado + i.chaves + i.fgts + i.subsidio + i.financiamento;
      const entradaNec = liquido - total;
      const carteira = Math.min(Math.max(entradaNec, 0), TETO);
      const excedente = Math.max(0, entradaNec - TETO);
      const parcela = i.qtdMensais > 0 ? carteira / i.qtdMensais : 0;
      return [
        { label: 'Valor do imóvel', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor do imóvel com desconto', valor: liquido, fmt: 'money' },
        { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        { label: 'Sinal (ato)', valor: i.sinal, fmt: 'money' },
        { label: 'Sinal parcelado', valor: i.sinalParcelado, fmt: 'money' },
        { label: 'Chaves', valor: i.chaves, fmt: 'money' },
        { label: 'Entrada parcelada (carteira)', valor: carteira, fmt: 'money' },
        ...(excedente > 0 ? [{ label: 'A distribuir (sinal/chaves)', valor: excedente, fmt: 'money' }] : []),
        { label: 'Mensais', valor: `${i.qtdMensais}x de ${money(parcela)}`, fmt: 'text' },
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },

  /* ---------------------------------------------------------------- ENGEMAT */
  engemat: {
    nome: 'Engemat',
    cor: '#ea580c',
    obs: 'Entrada parcelada em 80x. Possui intercaladas semestrais.',
    produtos: {
      'villas-lisboa': { nome: 'Villas de Lisboa' },
    },
    fields: [
      { key: 'renda',         label: 'Renda do cliente',       type: 'money', def: 3297.44 },
      { key: 'valorTabela',   label: 'Valor de tabela',        type: 'money', def: 260000 },
      { key: 'desconto',      label: 'Desconto de tabela',     type: 'money', def: 15000 },
      { key: 'sinal',         label: 'Sinal (ato)',            type: 'money', def: 3000 },
      { key: 'chaves',        label: 'Chaves',                 type: 'money', def: 0 },
      { key: 'financiamento', label: 'Financiamento aprovado', type: 'money', def: 190159.81 },
      { key: 'fgts',          label: 'FGTS',                   type: 'money', def: 4254.50 },
      { key: 'subsidio',      label: 'Subsídio',               type: 'money', def: 3624 },
      { key: 'semestrais',    label: 'Nº de intercaladas semestrais', type: 'int', def: 0 },
      { key: 'valorIntercalada', label: 'Valor da intercalada (semestral)', type: 'money',
        autoDefault: (v) => Math.round(v.renda * 0.50 * 100) / 100 },
      { key: 'qtdMensais',    label: 'Nº de parcelas mensais', type: 'int',   def: 80 },
      { key: 'parcelaCaixa',  label: 'Parcela Caixa (pós-chaves)', type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round(v.renda * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const liquido = i.valorTabela - i.desconto;
      const capacidade = i.renda * 0.30;
      const valorInter = i.valorIntercalada || 0;
      const intercaladas = valorInter * i.semestrais;
      const total = i.sinal + i.chaves + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - intercaladas;
      const parcela = i.qtdMensais > 0 ? entrada / i.qtdMensais : 0;
      const fi = liquido ? total / liquido : 0;
      const entradaPct = liquido ? entrada / liquido : 0;
      const status = premissaSaude({ parcela, capacidade, entradaPct, fi });
      // sinal sugerido para fechar nas 3 premissas (entrada ≤ capacidade·nº parcelas)
      const entradaMax = capacidade * i.qtdMensais;
      const sinalMax = liquido - (total - i.sinal) - intercaladas; // sinal que zera a entrada
      const sinalSug = Math.min(menorSinalSaudavel(liquido, total - i.sinal, intercaladas, entradaMax), sinalMax);
      return {
        status,
        destaque: [
          { label: 'Entrada parcelada', valor: entrada, fmt: 'money' },
          { label: `Parcela mensal (${i.qtdMensais}x)`, valor: parcela, fmt: 'money', forte: true },
        ],
        linhas: [
          { label: 'Líquido (tabela − desconto)', valor: liquido, fmt: 'money' },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Total aportado', valor: total, fmt: 'money' },
          { label: 'Intercaladas semestrais', valor: intercaladas, fmt: 'money' },
          { label: 'Entrada % do imóvel', valor: entradaPct, fmt: 'pct' },
          { label: 'F.I. Real', valor: fi, fmt: 'pct' },
          ...(!status.ok && sinalSug > i.sinal
            ? [{ label: 'Sinal sugerido p/ ficar saudável', valor: Math.ceil(sinalSug), fmt: 'money', alerta: true }]
            : []),
        ],
      };
    },
    resumo(i, money) {
      const liquido = i.valorTabela - i.desconto;
      const valorInter = i.valorIntercalada || 0;
      const intercaladas = valorInter * i.semestrais;
      const total = i.sinal + i.chaves + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - intercaladas;
      const parcela = i.qtdMensais > 0 ? entrada / i.qtdMensais : 0;
      return [
        { label: 'Valor do imóvel', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor do imóvel com desconto', valor: liquido, fmt: 'money' },
        { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        { label: 'Sinal (ato)', valor: i.sinal, fmt: 'money' },
        { label: 'Chaves', valor: i.chaves, fmt: 'money' },
        { label: 'Entrada parcelada', valor: entrada, fmt: 'money' },
        { label: 'Mensais', valor: `${i.qtdMensais}x de ${money(parcela)}`, fmt: 'text' },
        { label: 'Intercaladas semestrais', valor: i.semestrais > 0 ? `${i.semestrais}x de ${money(valorInter)}` : '—', fmt: 'text' },
        { label: 'Valor total das intercaladas', valor: intercaladas, fmt: 'money' },
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },

  /* ---------------------------------------------------------------- BARCELOS */
  barcelos: {
    nome: 'Barcelos',
    cor: '#7c3aed',
    obs: 'Modelo próprio: entrada dividida com a construtora (teto R$30 mil) em até 60x. Sem regra de F.I.',
    produtos: {
      'barcelos': { nome: 'Barcelos' },
    },
    fields: [
      { key: 'rendaAprovada',  label: 'Renda aprovada na Caixa',        type: 'money', def: 10235.74 },
      { key: 'valorImovel',    label: 'Valor do imóvel',                type: 'money', def: 210000 },
      { key: 'avaliacaoCaixa', label: 'Avaliação da Caixa',             type: 'money', def: 220000, info: true },
      { key: 'financiamento',  label: 'Valor do financiamento',         type: 'money', def: 131192.88 },
      { key: 'fgts',           label: 'FGTS',                           type: 'money', def: 0 },
      { key: 'subsidio',       label: 'Subsídio do governo',            type: 'money', def: 0 },
      { key: 'aVista',         label: 'Entrada à vista (1ª parte)',     type: 'money', def: 15000 },
      { key: 'sinalIntercalado', label: 'Sinal intercalado (2ª parte)', type: 'money', def: 0 },
      { key: 'intercalada',    label: 'Valor de cada intercalada anual', type: 'money', def: 10000 },
      { key: 'qtdIntercaladas',label: 'Nº de intercaladas anuais',      type: 'int',   def: 2 },
      { key: 'chave',          label: 'Chave',                          type: 'money', def: 13807.12 },
      { key: 'qtdParcelas',    label: 'Nº de parcelas (até 60)',        type: 'int',   def: 60 },
    ],
    compute(i) {
      const rendaTotal = i.rendaAprovada + (i.rendaInformal || 0);
      const entradaTotal = i.valorImovel - i.financiamento - i.fgts - i.subsidio;
      const dividir = entradaTotal - i.aVista - (i.sinalIntercalado || 0) - (i.intercalada * i.qtdIntercaladas) - i.chave;
      const parcela = i.qtdParcelas > 0 ? dividir / i.qtdParcelas : 0;
      const comprometimento = rendaTotal ? parcela / rendaTotal : 0;
      const okTeto = dividir <= 30000;
      const status = {
        ok: okTeto,
        titulo: okTeto ? 'Dentro do teto de R$30 mil' : 'Acima do teto de R$30 mil — ajustar',
        checks: [
          { label: 'Valor a dividir com a construtora ≤ R$30 mil', ok: okTeto },
        ],
      };
      return {
        status,
        destaque: [
          { label: 'A dividir com a construtora', valor: dividir, fmt: 'money' },
          { label: `Parcela (${i.qtdParcelas}x)`, valor: parcela, fmt: 'money', forte: true },
          { label: 'Comprometimento de renda', valor: comprometimento, fmt: 'pct', forte: true },
        ],
        linhas: [
          { label: 'Renda total', valor: rendaTotal, fmt: 'money' },
          { label: 'Entrada em dinheiro total', valor: entradaTotal, fmt: 'money' },
          { label: 'Entrada à vista', valor: i.aVista, fmt: 'money' },
          { label: 'Intercaladas anuais', valor: i.intercalada * i.qtdIntercaladas, fmt: 'money' },
          { label: 'Chave', valor: i.chave, fmt: 'money' },
          ...(dividir > 30000
            ? [
                { label: 'Excedente acima do teto', valor: dividir - 30000, fmt: 'money', alerta: true },
                { label: 'Entrada à vista sugerida', valor: Math.ceil(i.aVista + (dividir - 30000)), fmt: 'money', alerta: true },
              ]
            : []),
        ],
      };
    },
    resumo(i, money) {
      const entradaTotal = i.valorImovel - i.financiamento - i.fgts - i.subsidio;
      const dividir = entradaTotal - i.aVista - (i.sinalIntercalado || 0) - (i.intercalada * i.qtdIntercaladas) - i.chave;
      const parcela = i.qtdParcelas > 0 ? dividir / i.qtdParcelas : 0;
      return [
        { label: 'Valor do imóvel', valor: i.valorImovel, fmt: 'money' },
        { label: 'Avaliação da Caixa', valor: i.avaliacaoCaixa, fmt: 'money' },
        { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        { label: 'Entrada à vista (1ª parte)', valor: i.aVista, fmt: 'money' },
        { label: 'Sinal intercalado (2ª parte)', valor: i.sinalIntercalado || 0, fmt: 'money' },
        { label: 'Intercaladas anuais', valor: i.qtdIntercaladas > 0 ? `${i.qtdIntercaladas}x de ${money(i.intercalada)}` : '—', fmt: 'text' },
        { label: 'Chave', valor: i.chave, fmt: 'money' },
        { label: 'A dividir com a construtora', valor: dividir, fmt: 'money' },
        { label: 'Mensais', valor: `${i.qtdParcelas}x de ${money(parcela)}`, fmt: 'text' },
      ];
    },
  },
};

const ORDEM_CONSTRUTORAS = ['telesil', 'engenharq', 'engemat', 'barcelos'];
