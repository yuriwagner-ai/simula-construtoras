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
// `aportesFixos` já inclui o abatimento do MCEM (que reduz a entrada como um aporte),
// então as 3 premissas — F.I., entrada ≤ 19% e parcela — usam a entrada já abatida.
function menorSinalSaudavel(liquido, aportesFixos, interTotal, entradaMax) {
  const tFi = 0.77 * liquido - aportesFixos;
  const tEntrada19 = 0.81 * liquido - aportesFixos - interTotal;
  const tParcela = liquido - aportesFixos - interTotal - entradaMax;
  return Math.max(tFi, tEntrada19, tParcela);
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
      // MCEM: abate exatamente esse valor da entrada parcelada (como um aporte da
      // construtora), começando pelas ÚLTIMAS parcelas. Como os blocos são pagos em
      // sequência (primeiro o 80%, depois o 20%), o MCEM quita primeiro o bloco 20%
      // inteiro e, se sobrar, abate o fim do bloco 80%. Cada bloco continua dividido
      // pelo seu nº original de parcelas (q80/q20), com valor menor e igual.
      // Nunca abate mais do que a própria entrada.
      const mcem = i.descontoMcem || 0;
      const mcemAbate = Math.min(mcem, Math.max(entrada, 0));
      const temMcem = mcemAbate > 0;
      const entradaEfetiva = entrada - mcemAbate;
      const bloco80Bruto = entrada * 0.8, bloco20Bruto = entrada * 0.2;
      const abate20 = Math.min(mcemAbate, bloco20Bruto); // MCEM quita o 20% primeiro
      const abate80 = mcemAbate - abate20;               // sobra abate o fim do 80%
      const bloco80 = Math.max(bloco80Bruto - abate80, 0);
      const bloco20 = Math.max(bloco20Bruto - abate20, 0);
      const bloco20Ativo = bloco20 > 0.005; // se o MCEM zerou o bloco 20%, ele some
      const parcela80 = i.q80 > 0 ? bloco80 / i.q80 : 0;
      const parcela20 = i.q20 > 0 ? bloco20 / i.q20 : 0;
      // Blocos são SEQUENCIais: paga as q80 parcelas e só depois as q20.
      // O mês mais pesado é a maior das duas parcelas (+ a intercalada nos meses que ela cai).
      // A premissa dos 30% mede a PARCELA MENSAL (a intercalada é semestral, paga
      // com 13º/renda extra — não entra no comprometimento mensal).
      const parcelaMaxBloco = Math.max(parcela80, parcela20);
      const mesMaisPesado = parcelaMaxBloco + (temInter ? valorInter : 0); // informativo
      const totalParcelar = entradaEfetiva + semestraisTotal; // já com o MCEM abatido
      // O MCEM abate a entrada efetiva e conta como cobertura do imóvel: melhora as 3
      // premissas (Entrada%, F.I. e a parcela, que fica menor pois é recalculada).
      const fi = liquido ? (total + mcemAbate) / liquido : 0;
      const entradaPct = liquido ? entradaEfetiva / liquido : 0;
      const status = premissaSaude({ parcela: parcelaMaxBloco, capacidade, entradaPct, fi });
      // sinal sugerido: o MCEM entra como aporte fixo (reduz a entrada em todas as premissas)
      // e o sinal nunca passa do ponto em que a entrada efetiva chega a zero (sinalMax).
      const k = Math.max(i.q80 > 0 ? 0.8 / i.q80 : Infinity, i.q20 > 0 ? 0.2 / i.q20 : Infinity);
      const entradaMax = capacidade / k;
      const aportesFixos = (total - i.sinal) + mcemAbate; // tudo que reduz a entrada, menos o sinal
      const sinalMax = liquido - aportesFixos - semestraisTotal; // sinal que zera a entrada efetiva
      const sinalSug = Math.min(menorSinalSaudavel(liquido, aportesFixos, semestraisTotal, entradaMax), sinalMax);
      return {
        status,
        destaque: [
          { label: 'Entrada parcelada', valor: entradaEfetiva, fmt: 'money' },
          { label: `Parcela 80% — 1ª fase (${i.q80}x)`, valor: parcela80, fmt: 'money' },
          ...(bloco20Ativo ? [{ label: `Parcela 20% — 2ª fase (${i.q20}x)`, valor: parcela20, fmt: 'money' }] : []),
          ...(temInter ? [{ label: 'Intercalada (semestral)', valor: valorInter, fmt: 'money' }] : []),
          { label: 'Maior parcela mensal', valor: parcelaMaxBloco, fmt: 'money', forte: true },
        ],
        linhas: [
          { label: 'Líquido (tabela − desconto)', valor: liquido, fmt: 'money' },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Total aportado', valor: total, fmt: 'money' },
          { label: 'Total das intercaladas', valor: semestraisTotal, fmt: 'money' },
          ...(temMcem ? [
            { label: 'Entrada parcelada (bruta)', valor: entrada, fmt: 'money' },
            { label: 'Desconto MCEM aplicado', valor: mcemAbate, fmt: 'money' },
          ] : []),
          ...(temMcem && !bloco20Ativo ? [{ label: 'Bloco 20% quitado pelo MCEM', valor: 'Sim', fmt: 'text' }] : []),
          { label: 'Total a parcelar (entrada + intercaladas)', valor: totalParcelar, fmt: 'money' },
          ...(temInter ? [{ label: 'Mês mais pesado (parcela + intercalada)', valor: mesMaisPesado, fmt: 'money' }] : []),
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
      const mcem = i.descontoMcem || 0;
      const mcemAbate = Math.min(mcem, Math.max(entrada, 0));
      const entradaEfetiva = entrada - mcemAbate;
      // MCEM abate as últimas parcelas: quita o bloco 20% primeiro, depois o fim do 80%.
      const bloco20Bruto = entrada * 0.2;
      const abate20 = Math.min(mcemAbate, bloco20Bruto);
      const abate80 = mcemAbate - abate20;
      const bloco80 = Math.max(entrada * 0.8 - abate80, 0);
      const bloco20 = Math.max(bloco20Bruto - abate20, 0);
      const bloco20Ativo = bloco20 > 0.005;
      const parcela80 = i.q80 > 0 ? bloco80 / i.q80 : 0;
      const parcela20 = i.q20 > 0 ? bloco20 / i.q20 : 0;
      return [
        { label: 'Valor do imóvel', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor do imóvel com desconto', valor: liquido, fmt: 'money' },
        { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
        { label: 'Sinal (ato)', valor: i.sinal, fmt: 'money' },
        { label: 'Sinal intercalado', valor: i.sinalIntercalado || 0, fmt: 'money' },
        ...(mcemAbate > 0 ? [
          { label: 'Entrada parcelada (bruta)', valor: entrada, fmt: 'money' },
          { label: 'Desconto MCEM', valor: mcemAbate, fmt: 'money' },
        ] : []),
        { label: mcemAbate > 0 ? 'Entrada parcelada (após MCEM)' : 'Entrada parcelada', valor: entradaEfetiva, fmt: 'money' },
        { label: 'Mensais', valor: bloco20Ativo
            ? `Bloco 80%: ${i.q80}x de ${money(parcela80)}\nBloco 20%: ${i.q20}x de ${money(parcela20)}`
            : `Bloco 80%: ${i.q80}x de ${money(parcela80)}` + (mcemAbate > 0 ? '\nBloco 20%: quitado pelo MCEM' : ''), fmt: 'text' },
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
    obs: 'Só parcela uma carteira de até R$50 mil em até 100x (ajustável no campo "Teto da carteira" para campanhas). O que exceder esse teto precisa ser distribuído entre sinal e chaves.',
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
      { key: 'tetoCarteira',  label: 'Teto da carteira (parcelável)', type: 'money', def: 50000,
        hint: 'Limite que a construtora parcela. Padrão R$ 50 mil; ajuste em campanhas (ex.: R$ 60 mil).' },
      { key: 'qtdMensais',    label: 'Nº de parcelas (até 100)', type: 'int',  def: 100 },
      { key: 'parcelaCaixa',  label: 'Parcela Caixa (pós-chaves)', type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round(v.renda * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const TETO = i.tetoCarteira || 50000;
      const tetoFmt = TETO.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
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
          ? `Carteira dentro do teto de ${tetoFmt}`
          : 'Acima do teto — distribuir excedente entre sinal e chaves',
        checks: [
          { label: `Carteira a parcelar ≤ ${tetoFmt} em até 100x`, ok: dentroTeto },
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
                { label: `Excedente acima do teto (${tetoFmt})`, valor: excedente, fmt: 'money', alerta: true },
                { label: 'Sinal sugerido (se todo excedente virar sinal)', valor: Math.ceil(i.sinal + excedente), fmt: 'money', alerta: true },
              ]
            : []),
        ],
      };
    },
    resumo(i, money) {
      const TETO = i.tetoCarteira || 50000;
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
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
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
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
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
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
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
