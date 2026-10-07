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

/* ---------------------------------------------------------------- MOURA DUBEUX */
// Planos prontos: os dados das unidades vêm de assets/md_tabelas.js (MD_PLANOS),
// gerado por execution/extrair_tabelas_md.py a partir dos PDFs de vendas.
const mdPlano = (id) => (typeof MD_PLANOS !== 'undefined' ? MD_PLANOS.find((p) => p.id === id) : null);
const mdUnidade = (v) => {
  const p = mdPlano(v.plano);
  const lista = p && p.torres[v.torre];
  return lista ? lista.find((u) => u.u === v.unidade) || null : null;
};
const mdAndar = (u) => {
  const n = Math.floor(parseInt(u, 10) / 100);
  return n === 0 ? 'Térreo' : `${n}º andar`;
};
// Parcela PRICE de um saldo S em n meses à taxa i (sem a correção IPCA).
// A taxa NÃO aparece na tela nem no resumo (pedido do corretor em 2026-09-29: assusta o
// cliente; ele explica pessoalmente na leitura do contrato).
const mdPrice = (S, n, i) => (n > 0 ? (i > 0 ? (S * i) / (1 - Math.pow(1 + i, -n)) : S / n) : 0);

// Ordem de abatimento do sinal EXTRA (pedido do corretor em 2026-09-29):
// 1º intercaladas/semestrais/parcela aleatória (valores maiores) → 2º financiamento MD
// (ou parcela de habite-se) → 3º mensais. Financiamento bancário nunca é abatido.
const MD_ORDEM_ABATE = ['intercalada', 'finMD', 'mensal'];

function mdFluxo(v) {
  const p = mdPlano(v.plano);
  const un = mdUnidade(v);
  if (!p || !un) return null;
  const comps = p.comp.map((c, idx) => ({ ...c, parcelaTab: un.v[idx], totalTab: un.v[idx] * c.q, abatido: 0 }));
  comps.forEach((c) => (c.total = c.totalTab));
  const sinalC = comps.find((c) => c.t === 'sinal');
  const sinalTab = sinalC.totalTab;
  const sinal = v.sinal;
  sinalC.total = sinal;
  let extra = sinal - sinalTab;
  let restante = extra;
  if (extra > 0) {
    MD_ORDEM_ABATE.forEach((tipo) => {
      comps.filter((c) => c.t === tipo).forEach((c) => {
        const a = Math.min(c.total, restante);
        c.total -= a; c.abatido += a; restante -= a;
      });
    });
  } else if (extra < 0) {
    // sinal abaixo da tabela: a diferença volta para as mensais (ou saldo MD) e gera alerta
    const alvo = comps.find((c) => c.t === 'mensal') || comps.find((c) => c.t === 'finMD');
    if (alvo) { alvo.total += -extra; alvo.abatido -= -extra; restante = 0; }
  }
  comps.forEach((c) => {
    c.parcela = c.q > 0 ? c.total / c.q : 0;
    if (c.prazo) c.pmt = mdPrice(c.total, c.prazo, c.taxa || 0);
  });
  return { p, un, comps, sinalTab, sinal, extra, excesso: Math.max(0, restante) };
}

// Texto de uma linha do plano (ex.: "48x de R$ 3.420,00" ou "R$ 791.700,00 em até 120x").
function mdDescreve(c) {
  if (c.total <= 0.004) return 'quitado pelo sinal';
  if (c.prazo) return `${fmtMoney(c.total)} em até ${c.prazo}x`;
  return c.q > 1 ? `${c.q}x de ${fmtMoney(c.parcela)}` : fmtMoney(c.total);
}

// Telesil — divisão da entrada parcelada nas duas fases, compartilhada por
// compute(), resumo() e pelo autoDefault do campo "Parcela da 2ª fase".
// Os VALORES das parcelas saem da entrada BRUTA (antes do MCEM): divisão do produto
// (pct80) ou, com ajuste manual, `parcela2 × q20` na 2ª fase e o restante na 1ª.
// MCEM (regra de 2026-10-01): NÃO recalcula as parcelas. Abate parcelas inteiras de
// trás para frente — fim da 2ª fase primeiro, depois fim da 1ª — e o que sobrar
// (menos que uma parcela) reduz a ÚLTIMA parcela que restar no fluxo.

// Abate `rem` do fim de uma fase de `q` parcelas de valor `parcela`.
// Retorna parcelas inteiras restantes, valor da última (parcial, 0 se não houver)
// e quanto foi usado.
function abateFimFase(parcela, q, rem) {
  if (q <= 0 || parcela <= 0.005 || rem <= 0.005) return { cheias: Math.max(q, 0), parcial: 0, usado: 0 };
  const bloco = parcela * q;
  if (rem >= bloco - 0.005) return { cheias: 0, parcial: 0, usado: bloco };
  const n = Math.floor((rem + 1e-9) / parcela); // parcelas inteiras quitadas
  const resto = rem - n * parcela;
  return resto > 0.005
    ? { cheias: q - n - 1, parcial: parcela - resto, usado: rem }
    : { cheias: q - n, parcial: 0, usado: rem };
}

function telesilBlocos(i) {
  const liquido = i.valorTabela - i.desconto;
  const f80 = (i.pct80 || 80) / 100;
  const f20 = 1 - f80;
  const valorInter = i.valorIntercalada || 0;
  const semestraisTotal = valorInter * i.semestrais;
  const total = i.sinal + (i.sinalIntercalado || 0) + i.fgts + i.subsidio + i.financiamento;
  const entrada = liquido - total - semestraisTotal;
  // produto fora do Minha Casa É Massa (mcem === false): o desconto MCEM não abate
  const mcemBloqueado = i.mcem === false && (i.descontoMcem || 0) > 0;
  const mcemAbate = i.mcem === false ? 0 : Math.min(i.descontoMcem || 0, Math.max(entrada, 0));
  const entradaEfetiva = entrada - mcemAbate;
  const base = Math.max(entrada, 0);
  // divisão automática pela % do produto (sobre a entrada bruta)
  let bloco80 = base * f80;
  let bloco20 = base * f20;
  const parcela20Auto = i.q20 > 0 ? bloco20 / i.q20 : 0;
  // manual = valor digitado difere do automático (o campo guarda o automático
  // arredondado em centavos enquanto não for editado)
  const p2 = i.parcela2;
  const manual = p2 != null && i.q20 > 0 && Math.abs(p2 - Math.round(parcela20Auto * 100) / 100) >= 0.01;
  let limitada = false;
  if (manual) {
    bloco20 = Math.max(p2, 0) * i.q20;
    if (bloco20 > base) { bloco20 = base; limitada = true; }
    bloco80 = base - bloco20;
  }
  const parcela80 = i.q80 > 0 ? bloco80 / i.q80 : 0;
  const parcela20 = i.q20 > 0 ? bloco20 / i.q20 : 0;
  // MCEM de trás para frente: 2ª fase, depois 1ª
  const fase2 = abateFimFase(parcela20, i.q20, mcemAbate);
  const fase1 = abateFimFase(parcela80, i.q80, mcemAbate - fase2.usado);
  const fase2Resta = fase2.cheias > 0 || fase2.parcial > 0;
  const fase1Resta = fase1.cheias > 0 || fase1.parcial > 0;
  // última parcela do fluxo (só faz sentido mostrar quando há MCEM)
  let ultima = null;
  if (mcemAbate > 0) {
    ultima = fase2Resta
      ? { fase: 2, valor: fase2.parcial || parcela20, numero: i.q80 + fase2.cheias + (fase2.parcial ? 1 : 0) }
      : { fase: 1, valor: fase1.parcial || parcela80, numero: fase1.cheias + (fase1.parcial ? 1 : 0) };
    if (ultima.numero <= 0) ultima = null; // MCEM quitou toda a entrada
  }
  const soma = bloco80 + bloco20;
  const pctA = manual ? Math.round(soma ? (bloco80 / soma) * 100 : 0) : Math.round(f80 * 100);
  const pctB = manual ? 100 - pctA : Math.round(f20 * 100);
  return { liquido, f80, f20, valorInter, semestraisTotal, total, entrada, mcemAbate, entradaEfetiva,
    bloco80, bloco20, parcela80, parcela20, parcela20Auto, manual, limitada, pctA, pctB,
    fase1, fase2, fase1Resta, fase2Resta, ultima, mcemBloqueado };
}

// Texto de uma fase: "28x de R$ 430,48", "19x de R$ 247,37 + 1x de R$ 236,85 (última)".
function telesilFaseTxt(fase, parcela, money) {
  if (fase.cheias <= 0 && fase.parcial <= 0) return 'quitada pelo MCEM';
  const partes = [];
  if (fase.cheias > 0) partes.push(`${fase.cheias}x de ${money(parcela)}`);
  if (fase.parcial > 0) partes.push(`1x de ${money(fase.parcial)} (última)`);
  return partes.join(' + ');
}

// Barcelos — fluxo compartilhado por compute() e resumo(). No Plano Direto não há
// banco: financiamento, FGTS e subsídio são ignorados (os valores digitados ficam
// guardados no card, só não entram na conta, para não se perder ao voltar ao Caixa).
function barcelosFluxo(i) {
  const direto = i.plano === 'direto';
  const renda = i.rendaAprovada + (i.rendaInformal || 0);
  const fin = direto ? 0 : i.financiamento;
  const fgts = direto ? 0 : i.fgts;
  const subsidio = direto ? 0 : i.subsidio;
  const entradaTotal = i.valorImovel - fin - fgts - subsidio;
  const sinal = i.aVista + (i.sinalIntercalado || 0);
  const intercaladas = i.intercalada * i.qtdIntercaladas;
  const dividir = entradaTotal - sinal - intercaladas - i.chave;
  const parcela = i.qtdParcelas > 0 ? dividir / i.qtdParcelas : 0;
  const maxParcelas = i.maxParcelas || (direto ? 36 : 60);
  const sinalMin = direto ? i.valorImovel * 0.30 : 1000;
  return { direto, renda, entradaTotal, sinal, intercaladas, dividir, parcela, maxParcelas, sinalMin };
}

const CONSTRUTORAS = {
  /* ---------------------------------------------------------------- TELESIL */
  telesil: {
    nome: 'Telesil',
    cor: '#2563eb',
    obs: 'Entrada dividida em dois blocos pagos em sequência (paga o 1º bloco inteiro e só depois o 2º). A divisão (%) e o nº de parcelas variam por produto.',
    // pct80 = % da entrada no 1º bloco (o 2º bloco fica com o restante).
    // q80/q20 = nº de parcelas de cada bloco.
    // Condições comerciais de OUTUBRO/2026 (ver diretiva). Ao escolher o produto, os
    // campos sinal / sinalIntercalado / semestrais recebem os valores da campanha.
    //   atoMin   = ato mínimo (abaixo dele: alerta; com F.I. ≥ 77% é "caso a caso")
    //   mcem     = participa do Minha Casa É Massa (false = desconto MCEM não abate)
    //   campanha = aviso mostrado no card (desconto NÃO é aplicado automaticamente)
    produtos: {
      'grand-diamond':     { nome: 'Grand Diamond',     q80: 28, q20: 24, pct80: 67,
        sinal: 999.99, sinalIntercalado: 999.99, semestrais: 5, atoMin: 999.99, mcem: true,
        campanha: 'Minha Casa É Massa' },
      'grand-via':         { nome: 'Grand Via',         q80: 30, q20: 24, pct80: 80,
        atoMin: 0, mcem: null, campanha: '' },
      'splendido':         { nome: 'Splendido',         q80: 33, q20: 24, pct80: 85,
        sinal: 999.99, sinalIntercalado: 999.99, semestrais: 0, atoMin: 999.99, mcem: false,
        campanha: 'R$ 10 mil de desconto p/ unidades acima de R$ 380 mil (5 primeiras unidades)' },
      'reserva-aldeprime': { nome: 'Reserva Aldeprime', q80: 24, q20: 28, pct80: 70,
        sinal: 999.99, sinalIntercalado: 999.99, semestrais: 4, atoMin: 999.99, mcem: true,
        campanha: 'R$ 10 mil de desconto (10 primeiras unidades) · Minha Casa É Massa' },
      'reserva-prata':     { nome: 'Reserva do Prata',  q80: 14, q20: 14, pct80: 70,
        sinal: 999.99, sinalIntercalado: 0, semestrais: 2, atoMin: 999.99, mcem: false,
        campanha: 'R$ 10 mil de desconto' },
      'custom':            { nome: 'Outro (manual)',    q80: 35, q20: 24, pct80: 80,
        atoMin: 0, mcem: null, campanha: '' },
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
      // Editável: digitar um valor recalcula a 1ª fase; apagar volta ao automático.
      { key: 'parcela2',     label: 'Parcela da 2ª fase',      type: 'money', def: 0,
        vazioAuto: true, resetProduto: true,
        autoDefault: (v) => Math.round(telesilBlocos({ ...v, parcela2: null }).parcela20Auto * 100) / 100,
        hint: 'Ajuste manual recalcula a 1ª fase. Apague para voltar ao automático.' },
    ],
    compute(i) {
      const liquido = i.valorTabela - i.desconto;
      const capacidade = i.renda * 0.30;
      // Divisão da entrada entre os dois blocos (varia por produto).
      const f80 = (i.pct80 || 80) / 100;
      const f20 = 1 - f80;
      const valorInter = i.valorIntercalada || 0;       // valor de cada intercalada (editável)
      const semestraisTotal = valorInter * i.semestrais; // soma de todas as intercaladas
      const temInter = i.semestrais > 0;
      const sinalTotal = i.sinal + (i.sinalIntercalado || 0); // sinal pode ser dividido em 2x
      const total = sinalTotal + i.fgts + i.subsidio + i.financiamento;
      const entrada = liquido - total - semestraisTotal;
      // MCEM: abate exatamente esse valor da entrada parcelada (como um aporte da
      // construtora), SEM recalcular as parcelas: quita parcelas inteiras de trás para
      // frente (fim da 2ª fase, depois fim da 1ª) e o resto reduz a última parcela
      // do fluxo, mostrada à parte. Nunca abate mais do que a própria entrada.
      const b = telesilBlocos(i);
      const { mcemAbate, entradaEfetiva, parcela80, parcela20 } = b;
      const temMcem = mcemAbate > 0;
      // se o MCEM quitou a 2ª fase, ela some; com ajuste manual mostra sempre
      const bloco20Ativo = b.fase2Resta || (b.manual && !temMcem);
      const n80 = b.fase1.cheias, n20 = b.fase2.cheias;
      const pctA = b.pctA, pctB = b.pctB;
      // Blocos são SEQUENCIais: paga as q80 parcelas e só depois as q20.
      // O mês mais pesado é a maior das duas parcelas (+ a intercalada nos meses que ela cai).
      // A premissa dos 30% mede a PARCELA MENSAL (a intercalada é semestral, paga
      // com 13º/renda extra — não entra no comprometimento mensal).
      // só contam as fases que ainda têm parcelas depois do MCEM
      const parcelaMaxBloco = Math.max(b.fase1Resta ? parcela80 : 0, b.fase2Resta ? parcela20 : 0);
      const mesMaisPesado = parcelaMaxBloco + (temInter ? valorInter : 0); // informativo
      const totalParcelar = entradaEfetiva + semestraisTotal; // já com o MCEM abatido
      // O MCEM abate a entrada efetiva e conta como cobertura do imóvel: melhora
      // Entrada% e F.I. A parcela NÃO muda (as parcelas não são recalculadas).
      const fi = liquido ? (total + mcemAbate) / liquido : 0;
      const entradaPct = liquido ? entradaEfetiva / liquido : 0;
      const status = premissaSaude({ parcela: parcelaMaxBloco, capacidade, entradaPct, fi });
      // sinal sugerido: o MCEM entra como aporte fixo (reduz a entrada em todas as premissas)
      // e o sinal nunca passa do ponto em que a entrada efetiva chega a zero (sinalMax).
      const k = Math.max(i.q80 > 0 ? f80 / i.q80 : Infinity, i.q20 > 0 ? f20 / i.q20 : Infinity);
      // com ajuste manual o bloco da 2ª fase é fixo: a entrada máxima é o que cabe na
      // 1ª fase (30% × q80) mais esse bloco
      // as parcelas saem da entrada BRUTA (antes do MCEM), então o limite da parcela
      // vale para a bruta: na entrada efetiva ele fica menor pelo valor do MCEM
      const entradaMax = (b.manual ? capacidade * i.q80 + b.bloco20 : capacidade / k) - mcemAbate;
      const aportesFixos = (total - i.sinal) + mcemAbate; // tudo que reduz a entrada, menos o sinal
      const sinalMax = liquido - aportesFixos - semestraisTotal; // sinal que zera a entrada efetiva
      const sinalSug = Math.min(menorSinalSaudavel(liquido, aportesFixos, semestraisTotal, entradaMax), sinalMax);
      return {
        status,
        destaque: [
          { label: 'Entrada parcelada', valor: entradaEfetiva, fmt: 'money' },
          ...(b.fase1Resta || !temMcem ? [{ label: `1ª fase — ${pctA}% (${n80}x)`, valor: parcela80, fmt: 'money' }] : []),
          ...(bloco20Ativo ? [{ label: `2ª fase — ${pctB}% (${n20}x)${b.manual ? ' · ajustada' : ''}`, valor: parcela20, fmt: 'money' }] : []),
          ...(b.ultima ? [{ label: `Última parcela (${b.ultima.fase}ª fase, nº ${b.ultima.numero})`, valor: b.ultima.valor, fmt: 'money' }] : []),
          ...(temInter ? [{ label: 'Intercalada (semestral)', valor: valorInter, fmt: 'money' }] : []),
          { label: 'Maior parcela mensal', valor: parcelaMaxBloco, fmt: 'money', forte: true },
        ],
        linhas: [
          ...(i.campanha ? [{ label: 'Campanha do mês', valor: i.campanha, fmt: 'text' }] : []),
          // Ato mínimo da campanha: com F.I. ≥ 77% a construtora analisa o ato caso a caso
          ...(i.atoMin > 0 && i.sinal < i.atoMin - 0.005
            ? [fi >= 0.77
                ? { label: `Ato abaixo de ${fmtMoney(i.atoMin)} — F.I. ≥ 77%: análise caso a caso`, valor: i.sinal, fmt: 'money' }
                : { label: `Ato abaixo do mínimo (${fmtMoney(i.atoMin)})`, valor: i.sinal, fmt: 'money', alerta: true }]
            : []),
          ...(b.mcemBloqueado
            ? [{ label: 'Produto fora do Minha Casa É Massa — MCEM não abatido', valor: i.descontoMcem, fmt: 'money', alerta: true }]
            : []),
          { label: 'Líquido (tabela − desconto)', valor: liquido, fmt: 'money' },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Total aportado', valor: total, fmt: 'money' },
          { label: 'Total das intercaladas', valor: semestraisTotal, fmt: 'money' },
          ...(temMcem ? [
            { label: 'Entrada parcelada (bruta)', valor: entrada, fmt: 'money' },
            { label: 'Desconto MCEM aplicado', valor: mcemAbate, fmt: 'money' },
          ] : []),
          ...(temMcem ? [
            { label: `1ª fase (${i.q80}x na tabela)`, valor: telesilFaseTxt(b.fase1, parcela80, fmtMoney), fmt: 'text' },
            { label: `2ª fase (${i.q20}x na tabela)`, valor: telesilFaseTxt(b.fase2, parcela20, fmtMoney), fmt: 'text' },
          ] : []),
          ...(b.manual ? [{ label: 'Parcela da 2ª fase automática (referência)', valor: b.parcela20Auto, fmt: 'money' }] : []),
          ...(b.limitada ? [{ label: '2ª fase limitada ao total da entrada — 1ª fase zerada', valor: parcela20, fmt: 'money', alerta: true }] : []),
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
      const b = telesilBlocos(i);
      const { liquido, valorInter, semestraisTotal, entrada, mcemAbate, entradaEfetiva, parcela80, parcela20, pctA, pctB } = b;
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
        { label: 'Mensais', valor:
            `1ª fase (${pctA}%): ${telesilFaseTxt(b.fase1, parcela80, money)}` +
            (b.fase2Resta || mcemAbate > 0 ? `\n2ª fase (${pctB}%): ${telesilFaseTxt(b.fase2, parcela20, money)}` : ''), fmt: 'text' },
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
  // Condições comerciais de OUTUBRO/2026 (ver diretiva). Dois planos:
  //   Plano Caixa (MCMV): sinal mín. R$ 1.000, 2 intercaladas, chaves, saldo em até 60x
  //   Plano Direto: sinal mín. 30% do imóvel, 2 intercaladas, chaves, saldo em até 36x,
  //                 sem banco (financiamento, FGTS e subsídio não entram)
  // Nos dois: parcela mensal limitada a 20% da renda. A carteira de R$ 30 mil que
  // somava ao limite (set/2026) SAIU — confirmado pelo corretor em 2026-10-07.
  barcelos: {
    nome: 'Barcelos',
    cor: '#7c3aed',
    obs: 'Escolha o plano: Plano Caixa (MCMV — sinal mín. R$ 1.000, saldo em até 60x) ou Plano Direto (sem banco — sinal mín. 30%, saldo em até 36x). Nos dois: 2 intercaladas + chaves, e a parcela mensal fica limitada a 20% da renda.',
    produtos: {
      'caixa':  { nome: 'Plano Caixa (MCMV)', plano: 'caixa',  maxParcelas: 60, qtdParcelas: 60, qtdIntercaladas: 2 },
      'direto': { nome: 'Plano Direto',       plano: 'direto', maxParcelas: 36, qtdParcelas: 36, qtdIntercaladas: 2 },
    },
    fields: [
      { key: 'rendaAprovada',  label: (v) => (v.plano === 'direto' ? 'Renda do cliente' : 'Renda aprovada na Caixa'), type: 'money', def: 10235.74 },
      { key: 'valorImovel',    label: 'Valor do imóvel',                type: 'money', def: 230000,
        hint: (v) => (v.plano === 'direto' ? '' : 'Unidades a partir de R$ 230.000.') },
      { key: 'avaliacaoCaixa', label: 'Avaliação da Caixa',             type: 'money', def: 220000, info: true,
        visivel: (v) => v.plano !== 'direto' },
      { key: 'financiamento',  label: 'Valor do financiamento',         type: 'money', def: 131192.88,
        visivel: (v) => v.plano !== 'direto' },
      { key: 'fgts',           label: 'FGTS',                           type: 'money', def: 0,
        visivel: (v) => v.plano !== 'direto' },
      { key: 'subsidio',       label: 'Subsídio do governo',            type: 'money', def: 0,
        visivel: (v) => v.plano !== 'direto' },
      { key: 'aVista',         label: 'Sinal / entrada à vista (1ª parte)', type: 'money', def: 15000,
        hint: (v) => (v.plano === 'direto' ? 'Sinal mínimo: 30% do imóvel (soma com a 2ª parte).' : 'Sinal mínimo: R$ 1.000 (soma com a 2ª parte).') },
      { key: 'sinalIntercalado', label: 'Sinal intercalado (2ª parte)', type: 'money', def: 0 },
      { key: 'intercalada',    label: 'Valor de cada intercalada',      type: 'money', def: 10000 },
      { key: 'qtdIntercaladas',label: 'Nº de intercaladas',             type: 'int',   def: 2 },
      { key: 'chave',          label: 'Chaves',                         type: 'money', def: 13807.12 },
      { key: 'qtdParcelas',    label: (v) => `Nº de parcelas (até ${v.maxParcelas || 60})`, type: 'int', def: 60 },
      // Informativo: só começa a ser paga na entrega das chaves (só existe no Plano Caixa).
      { key: 'parcelaCaixa',   label: 'Parcela Caixa (pós-chaves)',     type: 'money', def: 0, info: true,
        visivel: (v) => v.plano !== 'direto',
        autoDefault: (v) => Math.round((v.rendaAprovada || 0) * 0.30 * 100) / 100 },
    ],
    compute(i) {
      const f = barcelosFluxo(i);
      const LIMITE_RENDA = 0.20;
      const limiteParcela = f.renda * LIMITE_RENDA;
      const maxParcelavel = limiteParcela * i.qtdParcelas;
      const okParcela = f.parcela <= limiteParcela + 0.005;
      const parcelasOk = i.qtdParcelas > 0 && i.qtdParcelas <= f.maxParcelas;
      const okSinal = f.sinal >= f.sinalMin - 0.005;
      const okFecha = f.dividir >= -0.005;
      const ok = okParcela && parcelasOk && okSinal && okFecha;
      const comprometimento = f.renda ? f.parcela / f.renda : 0;
      // Prazo inválido vem antes no título: com 0 parcelas a parcela zera e passaria
      // no teste dos 20% sem significar nada.
      const titulo = !parcelasOk ? `Nº de parcelas fora do limite (máx. ${f.maxParcelas}x)`
        : !okFecha ? 'Aportes maiores que o imóvel'
        : !okSinal ? 'Sinal abaixo do mínimo do plano'
        : okParcela ? 'Parcela dentro do limite (20% da renda)'
        : 'Parcela acima de 20% da renda — ajustar';
      const excedente = Math.max(0, f.dividir - maxParcelavel);
      // sinal sugerido: cobre o mínimo do plano e o excedente acima dos 20%
      const faltaSinal = Math.max(0, f.sinalMin - f.sinal);
      const aVistaSug = i.aVista + Math.max(faltaSinal, okParcela ? 0 : excedente);
      return {
        status: {
          ok,
          titulo,
          checks: [
            { label: `Parcela ≤ 20% da renda (${fmtMoney(limiteParcela)})`, ok: okParcela },
            { label: `Parcelamento em até ${f.maxParcelas}x (atual: ${i.qtdParcelas}x)`, ok: parcelasOk },
            { label: `Sinal ≥ ${f.direto ? '30% do imóvel' : 'R$ 1.000'} (${fmtMoney(f.sinalMin)})`, ok: okSinal },
          ],
        },
        destaque: [
          { label: 'Saldo a dividir com a construtora', valor: f.dividir, fmt: 'money' },
          { label: `Parcela (${i.qtdParcelas}x)`, valor: f.parcela, fmt: 'money', forte: true },
          { label: 'Comprometimento de renda', valor: comprometimento, fmt: 'pct', forte: true },
        ],
        linhas: [
          { label: 'Plano', valor: f.direto ? 'Plano Direto (sem banco)' : 'Plano Caixa (MCMV)', fmt: 'text' },
          ...(!f.direto ? [{ label: 'Entrada em dinheiro (imóvel − financ. − FGTS − subsídio)', valor: f.entradaTotal, fmt: 'money' }] : []),
          { label: 'Sinal (1ª + 2ª parte)', valor: f.sinal, fmt: 'money' },
          { label: 'Intercaladas', valor: f.intercaladas, fmt: 'money' },
          { label: 'Chaves', valor: i.chave, fmt: 'money' },
          { label: 'Limite de parcela (20% da renda)', valor: limiteParcela, fmt: 'money' },
          { label: `Máximo parcelável em ${i.qtdParcelas}x`, valor: maxParcelavel, fmt: 'money' },
          ...(!parcelasOk
            ? [{ label: `Nº de parcelas informado (máx. ${f.maxParcelas}x)`, valor: `${i.qtdParcelas}x`, fmt: 'text', alerta: true }]
            : []),
          ...(!okSinal ? [{ label: 'Falta para o sinal mínimo', valor: faltaSinal, fmt: 'money', alerta: true }] : []),
          ...(!okParcela ? [{ label: 'Excedente acima de 20% da renda', valor: excedente, fmt: 'money', alerta: true }] : []),
          ...(!okParcela || !okSinal
            ? [{ label: 'Entrada à vista sugerida', valor: Math.ceil(aVistaSug), fmt: 'money', alerta: true }]
            : []),
        ],
      };
    },
    resumo(i, money) {
      const f = barcelosFluxo(i);
      return [
        { label: 'Plano', valor: f.direto ? 'Plano Direto' : 'Plano Caixa (MCMV)', fmt: 'text' },
        { label: 'Valor do imóvel', valor: i.valorImovel, fmt: 'money' },
        ...(!f.direto ? [
          { label: 'Avaliação da Caixa', valor: i.avaliacaoCaixa, fmt: 'money' },
          { label: 'Valor do financiamento', valor: i.financiamento, fmt: 'money' },
          { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
          ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
        ] : []),
        { label: 'Sinal / entrada à vista (1ª parte)', valor: i.aVista, fmt: 'money' },
        { label: 'Sinal intercalado (2ª parte)', valor: i.sinalIntercalado || 0, fmt: 'money' },
        { label: 'Intercaladas', valor: i.qtdIntercaladas > 0 ? `${i.qtdIntercaladas}x de ${money(i.intercalada)}` : '—', fmt: 'text' },
        { label: 'Chaves', valor: i.chave, fmt: 'money' },
        { label: 'Saldo com a construtora', valor: f.dividir, fmt: 'money' },
        { label: 'Mensais', valor: `${i.qtdParcelas}x de ${money(f.parcela)}`, fmt: 'text' },
        ...(!f.direto ? [{ label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' }] : []),
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
      { key: 'avaliacaoCaixa', label: 'Avaliação oficial Caixa',         type: 'money', def: 550000, info: true,
        hint: 'Vem da tipologia; editável.' },
      { key: 'financiamento',  label: 'Financiamento associativo',       type: 'money', def: 0,
        // a tabela arredonda o financiamento para baixo em reais inteiros (550.000,12 → 440.000,00)
        autoDefault: (v) => Math.floor(((v.valorTabela || 0) - (v.desconto || 0)) * 0.80),
        hint: 'Padrão da tabela: 80% do valor.' },
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
      const liquido = i.valorTabela - i.desconto;
      const semestrais = i.semestral * i.qtdSemestrais;
      const aportes = i.ato + semestrais + i.financiamento + i.fgts + i.subsidio;
      const totalMensais = liquido - aportes;
      const mensal = i.qtdMensais > 0 ? totalMensais / i.qtdMensais : 0;
      const capacidade = i.renda * 0.30;
      // Caixa financia até 80% do MENOR entre valor de compra e avaliação.
      const baseFin = Math.min(liquido, i.avaliacaoCaixa || liquido);
      const finMax = baseFin * 0.80;
      const okParcela = mensal <= capacidade;
      const okFin = i.financiamento <= finMax + 1; // tolerância de arredondamento
      const okFecha = totalMensais >= 0;
      const okPrazo = i.qtdMensais > 0 && i.qtdMensais <= 34;
      const ok = okParcela && okFin && okFecha && okPrazo;
      const pct = (x) => (liquido ? x / liquido : 0);
      return {
        status: {
          ok,
          titulo: !okFecha ? 'Aportes maiores que o imóvel'
            : !okPrazo ? 'Nº de mensais fora do limite (máx. 34x até o habite-se)'
            : ok ? 'Proposta dentro do fluxo' : 'Precisa ajustar a proposta',
          checks: [
            { label: 'Mensal ≤ 30% da renda', ok: okParcela },
            { label: 'Financiamento ≤ 80% do menor entre valor e avaliação', ok: okFin },
            { label: `Mensais em até 34x (atual: ${i.qtdMensais}x)`, ok: okPrazo },
            { label: 'Aportes não ultrapassam o valor do imóvel', ok: okFecha },
          ],
        },
        destaque: [
          { label: 'Total em mensais', valor: totalMensais, fmt: 'money' },
          { label: `Mensal (${i.qtdMensais}x)`, valor: mensal, fmt: 'money', forte: true },
          { label: 'Comprometimento de renda', valor: i.renda ? mensal / i.renda : 0, fmt: 'pct', forte: true },
        ],
        linhas: [
          { label: 'Valor líquido', valor: liquido, fmt: 'money' },
          { label: 'Avaliação oficial Caixa', valor: i.avaliacaoCaixa, fmt: 'money' },
          { label: `Ato (${fmtPct(pct(i.ato))})`, valor: i.ato, fmt: 'money' },
          { label: `Semestrais ${i.qtdSemestrais}x (${fmtPct(pct(semestrais))})`, valor: semestrais, fmt: 'money' },
          { label: `Mensais (${fmtPct(pct(totalMensais))})`, valor: totalMensais, fmt: 'money' },
          { label: `Financiamento (${fmtPct(pct(i.financiamento))})`, valor: i.financiamento, fmt: 'money' },
          { label: 'Financiamento máximo (80%)', valor: finMax, fmt: 'money', alerta: !okFin },
          { label: 'Capacidade de pagamento (30%)', valor: capacidade, fmt: 'money' },
          { label: 'Mês mais pesado (mensal + semestral)', valor: mensal + (i.qtdSemestrais > 0 ? i.semestral : 0), fmt: 'money' },
          ...(!okParcela && i.qtdMensais > 0
            ? [{ label: 'Aumentar ato/semestrais em', valor: (mensal - capacidade) * i.qtdMensais, fmt: 'money', alerta: true }]
            : []),
          ...(!okFin ? [{ label: 'Excedente do financiamento', valor: i.financiamento - finMax, fmt: 'money', alerta: true }] : []),
        ],
      };
    },
    resumo(i, money) {
      const liquido = i.valorTabela - i.desconto;
      const semestrais = i.semestral * i.qtdSemestrais;
      const totalMensais = liquido - i.ato - semestrais - i.financiamento - i.fgts - i.subsidio;
      const mensal = i.qtdMensais > 0 ? totalMensais / i.qtdMensais : 0;
      return [
        { label: 'Valor de tabela', valor: i.valorTabela, fmt: 'money' },
        ...(i.desconto > 0 ? [{ label: 'Desconto aplicado', valor: i.desconto, fmt: 'money' }] : []),
        { label: 'Valor líquido', valor: liquido, fmt: 'money' },
        // Avaliação fica só no card (referência do corretor); não vai para o resumo do cliente.
        { label: 'Ato', valor: i.ato, fmt: 'money' },
        { label: 'Mensais até o habite-se', valor: `${i.qtdMensais}x de ${money(mensal)}`, fmt: 'text' },
        { label: 'Semestrais', valor: i.qtdSemestrais > 0 ? `${i.qtdSemestrais}x de ${money(i.semestral)}` : '—', fmt: 'text' },
        { label: 'FGTS', valor: i.fgts || 0, fmt: 'money' },
        ...(i.subsidio > 0 ? [{ label: 'Subsídio', valor: i.subsidio, fmt: 'money' }] : []),
        { label: 'Financiamento associativo', valor: i.financiamento, fmt: 'money' },
        { label: 'Parcela Caixa (pós-chaves)', valor: i.parcelaCaixa || 0, fmt: 'money' },
      ];
    },
  },
  /* ---------------------------------------------------------------- MOURA DUBEUX */
  mouradubeux: {
    nome: 'Moura Dubeux',
    cor: '#0f766e',
    obs: 'Planos prontos das tabelas de vendas (set/2026). Escolha produto/plano, torre e unidade: o plano da tabela aparece pronto. Sinal maior abate primeiro as intercaladas, depois o financiamento MD (ou parcela de habite-se) e por último as mensais. O financiamento bancário não muda.',
    produtos: (typeof MD_PLANOS !== 'undefined' ? MD_PLANOS : []).reduce((acc, p) => {
      acc[p.id] = { nome: `${p.produto} — ${p.plano}`, plano: p.id };
      return acc;
    }, {}),
    fields: [
      { key: 'sinal', label: 'Sinal / entrada', type: 'money', def: 0,
        autoDefault: (v) => { const u = mdUnidade(v); return u ? u.v[0] : 0; },
        hint: 'Vem da tabela. Valor maior abate intercaladas → financiamento MD → mensais.' },
    ],
    // Garante torre/unidade válidas para o plano atual (troca de produto ou de torre).
    normalizar(v) {
      const p = mdPlano(v.plano);
      if (!p) return;
      const torres = Object.keys(p.torres);
      if (!torres.includes(v.torre)) v.torre = torres[0];
      const lista = p.torres[v.torre];
      if (!lista.some((u) => u.u === v.unidade)) v.unidade = lista[0].u;
    },
    seletores(v) {
      const p = mdPlano(v.plano);
      if (!p) return [];
      const out = [];
      const torres = Object.keys(p.torres);
      if (torres.length > 1) {
        out.push({ key: 'torre', label: 'Torre', options: torres.map((t) => ({ value: t, label: `Torre ${t}` })) });
      }
      const grupos = [];
      p.torres[v.torre].forEach((u) => {
        const g = mdAndar(u.u);
        let grupo = grupos.find((x) => x.label === g);
        if (!grupo) grupos.push((grupo = { label: g, options: [] }));
        grupo.options.push({ value: u.u, label: `${u.u} — ${u.a}${u.d ? ' · ' + u.d : ''} — ${fmtMoney(u.t)}` });
      });
      out.push({ key: 'unidade', label: 'Andar / unidade', grupos });
      return out;
    },
    compute(i) {
      const f = mdFluxo(i);
      if (!f) {
        return { status: { ok: false, titulo: 'Selecione produto, torre e unidade', checks: [] }, destaque: [], linhas: [] };
      }
      const okSinal = f.extra >= -0.005;
      const okExcesso = f.excesso <= 0.005;
      const ok = okSinal && okExcesso;
      const mensal = f.comps.find((c) => c.t === 'mensal');
      const pct = (x) => (f.un.t ? ` (${fmtPct(x / f.un.t)})` : '');
      const linhas = [
        { label: 'Unidade', valor: `${f.un.u} · ${f.p.torres[i.torre] && Object.keys(f.p.torres).length > 1 ? 'Torre ' + i.torre + ' · ' : ''}${f.un.a}${f.un.d ? ' · ' + f.un.d : ''}`, fmt: 'text' },
      ];
      f.comps.forEach((c) => {
        if (c.t === 'sinal') {
          linhas.push({ label: c.l + pct(c.total), valor: c.total, fmt: 'money' });
          return;
        }
        linhas.push({ label: c.l + pct(c.total), valor: mdDescreve(c), fmt: 'text' });
        if (c.prazo && c.total > 0.004) {
          linhas.push({ label: `↳ Parcela estimada em ${c.prazo}x`, valor: c.pmt, fmt: 'money' });
        }
      });
      if (f.un.av) linhas.push({ label: 'Valor de avaliação CEF', valor: f.un.av, fmt: 'money' });
      if (f.extra > 0.005) {
        linhas.push({ label: 'Sinal extra sobre a tabela', valor: f.extra, fmt: 'money' });
        // na mesma ordem em que o sinal extra foi aplicado
        MD_ORDEM_ABATE.forEach((tipo) => f.comps.filter((c) => c.t === tipo && c.abatido > 0.005).forEach((c) => {
          linhas.push({ label: `↳ abatido de ${c.l}`, valor: c.abatido, fmt: 'money' });
        }));
      }
      if (!okSinal) linhas.push({ label: 'Diferença somada às parcelas', valor: -f.extra, fmt: 'money', alerta: true });
      if (!okExcesso) linhas.push({ label: 'Sinal acima do saldo com a construtora', valor: f.excesso, fmt: 'money', alerta: true });
      return {
        status: {
          ok,
          titulo: !okSinal ? 'Sinal abaixo da tabela'
            : !okExcesso ? 'Sinal maior que o saldo a parcelar com a construtora'
            : f.extra > 0.005 ? 'Plano ajustado com sinal maior' : 'Plano da tabela',
          checks: [
            { label: `Sinal ≥ tabela (${fmtMoney(f.sinalTab)})`, ok: okSinal },
            { label: 'Sinal extra absorvido pelo plano', ok: okExcesso },
          ],
        },
        destaque: [
          { label: 'Valor total', valor: f.un.t, fmt: 'money' },
          { label: 'Sinal', valor: f.sinal, fmt: 'money', forte: true },
          mensal
            ? { label: `Mensal (${mensal.q}x)`, valor: mensal.parcela, fmt: 'money', forte: true }
            : { label: 'Sinal extra', valor: Math.max(0, f.extra), fmt: 'money' },
        ],
        linhas,
      };
    },
    resumo(i) {
      const f = mdFluxo(i);
      if (!f) return [];
      const torreTxt = Object.keys(f.p.torres).length > 1 ? `Torre ${i.torre} · ` : '';
      return [
        { label: 'Plano', valor: f.p.plano, fmt: 'text' },
        { label: 'Unidade', valor: `${torreTxt}${f.un.u} · ${f.un.a}${f.un.d ? ' · ' + f.un.d : ''}`, fmt: 'text' },
        { label: 'Valor total', valor: f.un.t, fmt: 'money' },
        ...f.comps.map((c) => (c.t === 'sinal'
          ? { label: c.l, valor: c.total, fmt: 'money' }
          : { label: c.l, valor: mdDescreve(c), fmt: 'text' })),
        ...f.comps.filter((c) => c.prazo && c.total > 0.004).map((c) => ({
          label: `Parcela estimada ${c.l.toLowerCase()} (${c.prazo}x)`, valor: c.pmt, fmt: 'money',
        })),
      ];
    },
  },
};

const ORDEM_CONSTRUTORAS = ['telesil', 'engenharq', 'engemat', 'barcelos', 'stanza', 'mouradubeux'];
