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

// Stanza (Viamar): lançamento enquadra o cliente no MCMV Faixa 3 com avaliação de
// R$ 400 mil → financiamento máximo fixo de R$ 320 mil (80%). A avaliação da tipologia
// é só referência (combinado em 2026-09-23).
const STANZA_FIN_MAX = 400000 * 0.80;

// Fluxo Stanza compartilhado por compute() e resumo(). A tabela prevê financiar 80%
// do líquido; o que o banco não financiar vira COMPLEMENTO À VISTA na assinatura
// (item 5 das observações da tabela), e as mensais continuam nos ~12% da tabela.
// FGTS e subsídio saem na assinatura do financiamento, então abatem primeiro o
// complemento e só o que sobrar reduz as mensais.
function stanzaFluxo(i) {
  const liquido = i.valorTabela - i.desconto;
  const semestrais = i.semestral * i.qtdSemestrais;
  const finTabela = Math.floor(liquido * 0.80);
  const recursos = i.fgts + i.subsidio;
  const complemento = Math.max(0, finTabela - i.financiamento - recursos);
  const totalMensais = liquido - i.ato - semestrais - i.financiamento - complemento - recursos;
  const mensal = i.qtdMensais > 0 ? totalMensais / i.qtdMensais : 0;
  return { liquido, semestrais, finTabela, complemento, totalMensais, mensal };
}

const CONSTRUTORAS = {
  /* ---------------------------------------------------------------- TELESIL */
  telesil: {
    nome: 'Telesil',
    cor: '#2563eb',
    obs: 'Entrada dividida em dois blocos pagos em sequência (paga o 1º bloco inteiro e só depois o 2º). A divisão (%) e o nº de parcelas variam por produto.',
    // pct80 = % da entrada no 1º bloco (o 2º bloco fica com o restante).
    // q80/q20 = nº de parcelas de cada bloco.
    produtos: {
      'grand-diamond':     { nome: 'Grand Diamond',     q80: 28, q20: 24, pct80: 67 },
      'grand-via':         { nome: 'Grand Via',         q80: 31, q20: 24, pct80: 80 },
      'splendido':         { nome: 'Splendido',         q80: 35, q20: 24, pct80: 80 },
      'reserva-aldeprime': { nome: 'Reserva Aldeprime', q80: 26, q20: 28, pct80: 70 },
      'custom':            { nome: 'Outro (manual)',    q80: 35, q20: 24, pct80: 80 },
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
      // A divisão entre os blocos (pct80) vem do produto selecionado e não é
      // editável na tela — ela já aparece nos rótulos das fases e no resumo.
      // Sem produto que a defina (ex.: "Outro (manual)"), cai no padrão 80/20.
      { key: 'q80',          label: 'Parcelas do 1º bloco',    type: 'int',   def: 35 },
      { key: 'q20',          label: 'Parcelas do 2º bloco',    type: 'int',   def: 24 },
    ],
    compute(i) {
      const liquido = i.valorTabela - i.desconto;
      const capacidade = i.renda * 0.30;
      // Divisão da entrada entre os dois blocos (varia por produto).
      const f80 = (i.pct80 || 80) / 100;
      const f20 = 1 - f80;
      const pctA = Math.round(f80 * 100), pctB = Math.round(f20 * 100);
      const valorInter = i.valorIntercalada || 0;       // valor de cada intercalada (editável)
      const semestraisTotal = valorInter * i.semestrais; // soma de todas as intercaladas
      const temInter = i.semestrais > 0;
      const sinalTotal = i.sinal + (i.sinalIntercalado || 0); // sinal pode ser dividido em 2x
      const total = sinalTotal + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - semestraisTotal;
      // MCEM: abate exatamente esse valor da entrada parcelada (como um aporte da
      // construtora), começando pelas ÚLTIMAS parcelas. Como os blocos são pagos em
      // sequência (primeiro o 1º bloco, depois o 2º), o MCEM quita primeiro o 2º
      // bloco inteiro e, se sobrar, abate o fim do 1º. Cada bloco continua dividido
      // pelo seu nº original de parcelas (q80/q20), com valor menor e igual.
      // Nunca abate mais do que a própria entrada.
      const mcem = i.descontoMcem || 0;
      const mcemAbate = Math.min(mcem, Math.max(entrada, 0));
      const temMcem = mcemAbate > 0;
      const entradaEfetiva = entrada - mcemAbate;
      const bloco80Bruto = entrada * f80, bloco20Bruto = entrada * f20;
      const abate20 = Math.min(mcemAbate, bloco20Bruto); // MCEM quita o 2º bloco primeiro
      const abate80 = mcemAbate - abate20;               // sobra abate o fim do 1º
      const bloco80 = Math.max(bloco80Bruto - abate80, 0);
      const bloco20 = Math.max(bloco20Bruto - abate20, 0);
      const bloco20Ativo = bloco20 > 0.005; // se o MCEM zerou o 2º bloco, ele some
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
      const k = Math.max(i.q80 > 0 ? f80 / i.q80 : Infinity, i.q20 > 0 ? f20 / i.q20 : Infinity);
      const entradaMax = capacidade / k;
      const aportesFixos = (total - i.sinal) + mcemAbate; // tudo que reduz a entrada, menos o sinal
      const sinalMax = liquido - aportesFixos - semestraisTotal; // sinal que zera a entrada efetiva
      const sinalSug = Math.min(menorSinalSaudavel(liquido, aportesFixos, semestraisTotal, entradaMax), sinalMax);
      return {
        status,
        destaque: [
          { label: 'Entrada parcelada', valor: entradaEfetiva, fmt: 'money' },
          { label: `1ª fase — ${pctA}% (${i.q80}x)`, valor: parcela80, fmt: 'money' },
          ...(bloco20Ativo ? [{ label: `2ª fase — ${pctB}% (${i.q20}x)`, valor: parcela20, fmt: 'money' }] : []),
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
          ...(temMcem && !bloco20Ativo ? [{ label: `2ª fase (${pctB}%) quitada pelo MCEM`, valor: 'Sim', fmt: 'text' }] : []),
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
      const f80 = (i.pct80 || 80) / 100;
      const f20 = 1 - f80;
      const pctA = Math.round(f80 * 100), pctB = Math.round(f20 * 100);
      const mcem = i.descontoMcem || 0;
      const mcemAbate = Math.min(mcem, Math.max(entrada, 0));
      const entradaEfetiva = entrada - mcemAbate;
      // MCEM abate as últimas parcelas: quita o 2º bloco primeiro, depois o fim do 1º.
      const bloco20Bruto = entrada * f20;
      const abate20 = Math.min(mcemAbate, bloco20Bruto);
      const abate80 = mcemAbate - abate20;
      const bloco80 = Math.max(entrada * f80 - abate80, 0);
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
            ? `1ª fase (${pctA}%): ${i.q80}x de ${money(parcela80)}\n2ª fase (${pctB}%): ${i.q20}x de ${money(parcela20)}`
            : `1ª fase (${pctA}%): ${i.q80}x de ${money(parcela80)}` + (mcemAbate > 0 ? `\n2ª fase (${pctB}%): quitada pelo MCEM` : ''), fmt: 'text' },
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
      'laranjeiras':  { nome: 'Laranjeiras' },
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
      const MAX_PARCELAS = 100; // a Engenharq não parcela a carteira em mais de 100x
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
      // Três situações distintas, antes confundidas num único `dentroTeto`:
      // aportes maiores que o imóvel, carteira acima do teto e nº de parcelas inválido.
      const sobraAportes = Math.max(0, -entradaNecessaria);
      const aportesExcedem = sobraAportes > 0;
      const dentroTeto = excedente <= 0;
      const parcelasOk = i.qtdMensais > 0 && i.qtdMensais <= MAX_PARCELAS;
      const ok = dentroTeto && parcelasOk && !aportesExcedem;
      const titulo = aportesExcedem
        ? 'Aportes maiores que o imóvel — revisar financiamento/sinal/chaves'
        : !dentroTeto
          ? 'Acima do teto — distribuir excedente entre sinal e chaves'
          : !parcelasOk
            ? `Nº de parcelas fora do limite (máx. ${MAX_PARCELAS}x)`
            : `Carteira dentro do teto de ${tetoFmt}`;
      const status = {
        ok,
        titulo,
        checks: [
          // com aportes acima do imóvel a carteira zera, então o check do teto passaria
          // sem sentido — nesse caso o rótulo aponta a causa real.
          aportesExcedem
            ? { label: 'Aportes não podem superar o valor do imóvel', ok: false }
            : { label: `Carteira a parcelar ≤ ${tetoFmt}`, ok: dentroTeto },
          { label: `Parcelamento em até ${MAX_PARCELAS}x (atual: ${i.qtdMensais}x)`, ok: parcelasOk },
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
          ...(aportesExcedem
            ? [{ label: 'Sobra de aportes (acima do valor do imóvel)', valor: sobraAportes, fmt: 'money', alerta: true }]
            : []),
          ...(!parcelasOk
            ? [{ label: `Nº de parcelas informado (máx. ${MAX_PARCELAS}x)`, valor: `${i.qtdMensais}x`, fmt: 'text', alerta: true }]
            : []),
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
      'plaza-santa-lucia-2': { nome: 'Plaza Santa Lúcia II' },
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
    obs: 'Modelo próprio: entrada dividida com a construtora em até 60x. A carteira de R$30 mil deixou de ser teto e virou base — em cima dela a construtora aceita uma parcela extra de 20% da renda do cliente (ex. em 60x: R$ 500 da carteira + 20% da renda). Sem regra de F.I.',
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
      // Informativo: só começa a ser paga na entrega das chaves. Aqui a renda base
      // é `rendaAprovada` (a Barcelos não tem o campo `renda`).
      { key: 'parcelaCaixa',   label: 'Parcela Caixa (pós-chaves)',     type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round((v.rendaAprovada || 0) * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const rendaTotal = i.rendaAprovada + (i.rendaInformal || 0);
      const entradaTotal = i.valorImovel - i.financiamento - i.fgts - i.subsidio;
      const dividir = entradaTotal - i.aVista - (i.sinalIntercalado || 0) - (i.intercalada * i.qtdIntercaladas) - i.chave;
      const parcela = i.qtdParcelas > 0 ? dividir / i.qtdParcelas : 0;
      const comprometimento = rendaTotal ? parcela / rendaTotal : 0;
      // Modelo novo (2026-09): a carteira de R$30 mil NÃO sumiu — ela deixou de ser o
      // teto e virou a base. A construtora passou a aceitar, EM CIMA dela, uma parcela
      // extra de 20% da renda do cliente. Ex. em 60x: R$30 mil/60 = R$500 de carteira
      // + 20% da renda. Por isso o valor total a dividir sobe bem além dos R$30 mil.
      const MAX_PARCELAS = 60;     // prazo máximo da Barcelos (confirmado 2026-09-12)
      const BASE_CARTEIRA = 30000; // carteira que a construtora já parcelava
      const parcelaCarteira = i.qtdParcelas > 0 ? BASE_CARTEIRA / i.qtdParcelas : 0;
      const parcelaRenda = rendaTotal * 0.20;
      const limiteParcela = parcelaCarteira + parcelaRenda;
      const maxParcelavel = limiteParcela * i.qtdParcelas;
      const limiteFmt = limiteParcela.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const carteiraFmt = parcelaCarteira.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const okParcela = parcela <= limiteParcela;
      // Prazo inválido vem antes no título: com 0 parcelas a parcela zera e passaria
      // no teste dos 20% sem significar nada (mesmo defeito já corrigido na Engenharq).
      const parcelasOk = i.qtdParcelas > 0 && i.qtdParcelas <= MAX_PARCELAS;
      const status = {
        ok: okParcela && parcelasOk,
        titulo: !parcelasOk
          ? `Nº de parcelas fora do limite (máx. ${MAX_PARCELAS}x)`
          : okParcela
            ? 'Parcela dentro do limite (carteira + 20% da renda)'
            : 'Parcela acima do limite — ajustar',
        checks: [
          { label: `Parcela ≤ ${limiteFmt} (${carteiraFmt} da carteira + 20% da renda)`, ok: okParcela },
          { label: `Parcelamento em até ${MAX_PARCELAS}x (atual: ${i.qtdParcelas}x)`, ok: parcelasOk },
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
          { label: `Parcela da carteira (R$ 30 mil em ${i.qtdParcelas}x)`, valor: parcelaCarteira, fmt: 'money' },
          { label: 'Parcela extra por renda (20%)', valor: parcelaRenda, fmt: 'money' },
          { label: 'Limite de parcela (carteira + renda)', valor: limiteParcela, fmt: 'money' },
          { label: `Máximo parcelável em ${i.qtdParcelas}x`, valor: maxParcelavel, fmt: 'money' },
          ...(!parcelasOk
            ? [{ label: `Nº de parcelas informado (máx. ${MAX_PARCELAS}x)`, valor: `${i.qtdParcelas}x`, fmt: 'text', alerta: true }]
            : []),
          ...(!okParcela
            ? [
                { label: 'Excedente acima do limite', valor: dividir - maxParcelavel, fmt: 'money', alerta: true },
                { label: 'Entrada à vista sugerida', valor: Math.ceil(i.aVista + (dividir - maxParcelavel)), fmt: 'money', alerta: true },
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
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },
  /* ---------------------------------------------------------------- STANZA */
  // Viamar (Maceió) — tabela de preços set/2026 V0. Fluxo padrão por unidade
  // (conferido na unidade 001: 11.000 + 34×1.941,18 + 2×16.500 + 440.000 = 550.000,12):
  //   Ato 2% (1x) · Mensais 12% em 34x até o habite-se · Semestrais 2× 3% · Financiamento associativo 80%.
  stanza: {
    nome: 'Stanza',
    cor: '#f47b20',
    obs: 'Viamar — fluxo da tabela: Ato 2% + 34 mensais até o habite-se (12%) + 2 semestrais de 3% + financiamento associativo 80%. FGTS e subsídio abatem das mensais. Escolha a tipologia para puxar a avaliação oficial Caixa.',
    // Produtos = tipologias do Viamar; só definem a avaliação oficial Caixa.
    produtos: {
      'v2-terreo':   { nome: 'Viamar — 2 Quartos Térreo',   avaliacaoCaixa: 450000 },
      'v2-giardino': { nome: 'Viamar — 2 Quartos Giardino', avaliacaoCaixa: 550000 },
      'v2-tipo':     { nome: 'Viamar — 2 Quartos Tipo',     avaliacaoCaixa: 550000 },
      'v2-pcd':      { nome: 'Viamar — 2 Quartos PCD',      avaliacaoCaixa: 550000 },
      'v3-terreo':   { nome: 'Viamar — 3 Quartos Térreo',   avaliacaoCaixa: 550000 },
      'v3-giardino': { nome: 'Viamar — 3 Quartos Giardino', avaliacaoCaixa: 600000 },
      'v3-tipo':     { nome: 'Viamar — 3 Quartos Tipo',     avaliacaoCaixa: 600000 },
      'v3-pcd':      { nome: 'Viamar — 3 Quartos PCD',      avaliacaoCaixa: 600000 },
      'custom':      { nome: 'Outro (manual)' },
    },
    fields: [
      { key: 'renda',          label: 'Renda bruta familiar',            type: 'money', def: 10000 },
      { key: 'valorTabela',    label: 'Valor total (tabela)',            type: 'money', def: 465000.12 },
      { key: 'desconto',       label: 'Desconto',                        type: 'money', def: 0 },
      // Só referência de quanto a unidade vale para a Caixa: o financiamento é enquadrado
      // no MCMV Faixa 3 com avaliação de R$ 400 mil (ver AVALIACAO_MCMV no compute).
      { key: 'avaliacaoCaixa', label: 'Avaliação oficial Caixa (referência)', type: 'money', def: 550000, info: true,
        hint: 'Só informativa — não entra no cálculo nem no resumo.' },
      { key: 'financiamento',  label: 'Financiamento associativo',       type: 'money', def: 0,
        // 80% do valor, arredondado p/ baixo em reais (como a tabela), limitado ao teto MCMV
        autoDefault: (v) => Math.min(Math.floor(((v.valorTabela || 0) - (v.desconto || 0)) * 0.80), 320000),
        hint: 'Até R$ 320 mil (80% da avaliação MCMV de R$ 400 mil).' },
      { key: 'fgts',           label: 'FGTS',                            type: 'money', def: 0 },
      { key: 'subsidio',       label: 'Subsídio do governo',             type: 'money', def: 0 },
      { key: 'ato',            label: 'Ato (1x)',                        type: 'money', def: 0,
        autoDefault: (v) => Math.round(((v.valorTabela || 0) - (v.desconto || 0)) * 0.02 * 100) / 100,
        hint: 'Padrão da tabela: 2%.' },
      { key: 'semestral',      label: 'Valor de cada semestral',         type: 'money', def: 0,
        autoDefault: (v) => Math.round(((v.valorTabela || 0) - (v.desconto || 0)) * 0.03 * 100) / 100,
        hint: 'Padrão da tabela: 3% cada.' },
      { key: 'qtdSemestrais',  label: 'Nº de semestrais',                type: 'int',   def: 2 },
      { key: 'qtdMensais',     label: 'Nº de mensais (até o habite-se)', type: 'int',   def: 34 },
      { key: 'parcelaCaixa',   label: 'Parcela Caixa (pós-chaves)',      type: 'money', def: 0, info: true,
        autoDefault: (v) => Math.round((v.renda || 0) * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const f = stanzaFluxo(i);
      const mensal = f.mensal;
      const capacidade = i.renda * 0.30;
      const okParcela = mensal <= capacidade;
      const okFin = i.financiamento <= STANZA_FIN_MAX + 1; // tolerância de arredondamento
      const okFecha = f.totalMensais >= 0;
      const okPrazo = i.qtdMensais > 0 && i.qtdMensais <= 34;
      const ok = okParcela && okFin && okFecha && okPrazo;
      const pct = (x) => (f.liquido ? x / f.liquido : 0);
      return {
        status: {
          ok,
          titulo: !okFecha ? 'Aportes maiores que o imóvel'
            : !okPrazo ? 'Nº de mensais fora do limite (máx. 34x até o habite-se)'
            : ok ? 'Proposta dentro do fluxo' : 'Precisa ajustar a proposta',
          checks: [
            { label: 'Mensal ≤ 30% da renda', ok: okParcela },
            { label: 'Financiamento ≤ R$ 320 mil (80% da avaliação MCMV de R$ 400 mil)', ok: okFin },
            { label: `Mensais em até 34x (atual: ${i.qtdMensais}x)`, ok: okPrazo },
            { label: 'Aportes não ultrapassam o valor do imóvel', ok: okFecha },
          ],
        },
        destaque: [
          { label: 'Complemento à vista', valor: f.complemento, fmt: 'money' },
          { label: `Mensal (${i.qtdMensais}x)`, valor: mensal, fmt: 'money', forte: true },
          { label: 'Comprometimento de renda', valor: i.renda ? mensal / i.renda : 0, fmt: 'pct', forte: true },
        ],
        linhas: [
          { label: 'Valor líquido', valor: f.liquido, fmt: 'money' },
          { label: 'Avaliação oficial Caixa (referência)', valor: i.avaliacaoCaixa, fmt: 'money' },
          { label: `Ato (${fmtPct(pct(i.ato))})`, valor: i.ato, fmt: 'money' },
          { label: `Semestrais ${i.qtdSemestrais}x (${fmtPct(pct(f.semestrais))})`, valor: f.semestrais, fmt: 'money' },
          { label: `Mensais (${fmtPct(pct(f.totalMensais))})`, valor: f.totalMensais, fmt: 'money' },
          { label: `Financiamento (${fmtPct(pct(i.financiamento))})`, valor: i.financiamento, fmt: 'money' },
          { label: 'Financiamento da tabela (80%)', valor: f.finTabela, fmt: 'money' },
          { label: 'Complemento à vista (na assinatura)', valor: f.complemento, fmt: 'money' },
          { label: 'Financiamento máximo (MCMV)', valor: STANZA_FIN_MAX, fmt: 'money', alerta: !okFin },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Mês mais pesado (mensal + semestral)', valor: mensal + (i.qtdSemestrais > 0 ? i.semestral : 0), fmt: 'money' },
          ...(!okParcela && i.qtdMensais > 0
            ? [{ label: 'Aumentar ato/semestrais em', valor: (mensal - capacidade) * i.qtdMensais, fmt: 'money', alerta: true }]
            : []),
          ...(!okFin ? [{ label: 'Excedente do financiamento', valor: i.financiamento - STANZA_FIN_MAX, fmt: 'money', alerta: true }] : []),
        ],
      };
    },
    resumo(i, money) {
      const f = stanzaFluxo(i);
      return [
        { label: 'Valor de tabela', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor líquido', valor: f.liquido, fmt: 'money' },
        { label: 'Ato', valor: i.ato, fmt: 'money' },
        { label: 'Mensais até o habite-se', valor: `${i.qtdMensais}x de ${money(f.mensal)}`, fmt: 'text' },
        { label: 'Semestrais', valor: i.qtdSemestrais > 0 ? `${i.qtdSemestrais}x de ${money(i.semestral)}` : '—', fmt: 'text' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
        { label: 'Financiamento associativo', valor: i.financiamento, fmt: 'money' },
        ...(f.complemento > 0 ? [{ label: 'Complemento à vista (na assinatura)', valor: f.complemento, fmt: 'money' }] : []),
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },
};

const ORDEM_CONSTRUTORAS = ['telesil', 'engenharq', 'engemat', 'barcelos', 'stanza'];
