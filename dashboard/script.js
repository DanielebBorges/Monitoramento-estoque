/* =========================================================
   TempWatch — Monitoramento de estoque por sensor de presença
   ========================================================= */

const API_URL = "https://dtryptqiigbkozgewcoi.supabase.co/functions/v1/registrar-movimentacao";

const INTERVALO_ATUALIZACAO = 10000; // ms
const POR_PAGINA = 12;
const DIA_MS = 864e5;
const HORA_MS = 36e5;
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const TURNOS = [
    { nome: "Madrugada", de: 0, ate: 6 },
    { nome: "Manhã", de: 6, ate: 12 },
    { nome: "Tarde", de: 12, ate: 18 },
    { nome: "Noite", de: 18, ate: 24 }
];
const TIPOS = {
    sensor: "Saída (sensor)",
    entrada: "Entrada",
    saida: "Saída manual",
    contagem: "Contagem física"
};

/* ---------- ESTADO ---------- */

const estado = {
    dados: [],              // eventos vindos da API
    idsConhecidos: new Set(),
    novosIds: new Set(),
    primeiraCarga: true,
    pausado: false,
    erro: false,
    ultimaSync: null,
    periodoGrafico: "24h",
    periodoRelatorio: "hoje",
    pagina: 1,
    naoVistos: 0,
    calculos: new Map()     // produtoId → resultado de calcularProduto
};

let produtos = lerStorage("tw-produtos", []);
let lancamentos = lerStorage("tw-lancamentos", []);
let config = Object.assign({
    inicio: "08:00",
    fim: "18:00",
    dias: [1, 2, 3, 4, 5],
    minutosOcioso: 30,
    diasCobertura: 14,
    som: false
}, lerStorage("tw-config-v2", {}));

const graficos = {};
const $ = id => document.getElementById(id);

migrarConfigAntiga();

/* =========================================================
   UTILITÁRIOS
   ========================================================= */

function lerStorage(chave, padrao) {
    try {
        const valor = localStorage.getItem(chave);
        return valor ? JSON.parse(valor) : padrao;
    } catch {
        return padrao;
    }
}

function salvarStorage(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem storage */ }
}

function salvarTudo() {
    salvarStorage("tw-produtos", produtos);
    salvarStorage("tw-lancamentos", lancamentos);
    salvarStorage("tw-config-v2", config);
}

// A versão anterior guardava um único estoque em "tw-config"
function migrarConfigAntiga() {
    const antiga = lerStorage("tw-config", null);
    if (antiga && antiga.dataBase && !produtos.length) {
        produtos.push({
            id: gerarId(),
            nome: "Produto principal",
            sku: "",
            dispositivo: "ESP32-01",
            estoqueInicial: antiga.estoqueInicial,
            dataBase: antiga.dataBase,
            minimo: antiga.minimo,
            unidades: antiga.unidades,
            prazo: 3,
            custo: 0
        });
        salvarTudo();
    }
}

function gerarId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Evita que textos vindos da API ou digitados virem HTML
function esc(valor) {
    return String(valor ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function inicioDoDia(data = new Date()) {
    const d = new Date(data);
    d.setHours(0, 0, 0, 0);
    return d;
}

function dd(n) {
    return String(n).padStart(2, "0");
}

function num(n, casas = 0) {
    return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: 0 });
}

function moeda(n) {
    return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function hora(data, comSegundos = false) {
    return data.toLocaleTimeString("pt-BR", {
        hour: "2-digit", minute: "2-digit", ...(comSegundos ? { second: "2-digit" } : {})
    });
}

function tempoRelativo(data) {
    const seg = Math.floor((Date.now() - data) / 1000);
    if (seg < 0) return "agendado";
    if (seg < 60) return "agora mesmo";
    const min = Math.floor(seg / 60);
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.floor(h / 24);
    return `há ${d} dia${d > 1 ? "s" : ""}`;
}

function formatarDias(dias) {
    if (!isFinite(dias)) return "—";
    if (dias < 1) return `${Math.max(1, Math.round(dias * 24))} h`;
    return `${num(dias, dias < 10 ? 1 : 0)} dias`;
}

function inicioPeriodo(periodo) {
    if (periodo === "hoje") return inicioDoDia();
    if (periodo === "7d") return new Date(Date.now() - 7 * DIA_MS);
    if (periodo === "30d") return new Date(Date.now() - 30 * DIA_MS);
    return null;
}

function corCSS(variavel) {
    return getComputedStyle(document.documentElement).getPropertyValue(variavel).trim();
}

function minutosDoDia(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function foraDoExpediente(data) {
    if (!config.dias.includes(data.getDay())) return true;
    const m = data.getHours() * 60 + data.getMinutes();
    const ini = minutosDoDia(config.inicio);
    const fim = minutosDoDia(config.fim);
    // Suporta expediente que vira a noite (ex.: 22:00 → 06:00)
    return ini <= fim ? (m < ini || m >= fim) : (m < ini && m >= fim);
}

function dataLocalInput(data = new Date()) {
    return new Date(data - data.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function produtoDoDispositivo(dispositivo) {
    return produtos.find(p => p.dispositivo === dispositivo);
}

/* =========================================================
   CÁLCULO DE ESTOQUE
   ========================================================= */

// Reconstrói a linha do tempo de um produto: saldo inicial,
// saídas do sensor e lançamentos manuais, em ordem cronológica.
function calcularProduto(p) {
    const base = new Date(p.dataBase);

    const eventosSensor = estado.dados
        .filter(m => m.dispositivo === p.dispositivo && m._data >= base)
        .map(m => ({ t: m._data, tipo: "sensor", qtd: p.unidades }));

    const manuais = lancamentos
        .filter(l => l.produtoId === p.id && new Date(l.data) >= base)
        .map(l => ({ t: new Date(l.data), tipo: l.tipo, qtd: l.qtd, ref: l }));

    const linha = [...eventosSensor, ...manuais].sort((a, b) => a.t - b.t);

    let saldo = p.estoqueInicial;
    const serie = [{ t: base, v: saldo }];
    const contagens = [];

    for (const e of linha) {
        if (e.tipo === "sensor" || e.tipo === "saida") saldo -= e.qtd;
        else if (e.tipo === "entrada") saldo += e.qtd;
        else if (e.tipo === "contagem") {
            const esperado = Math.max(0, saldo);
            contagens.push({ data: e.t, produto: p, esperado, contado: e.qtd, ref: e.ref });
            saldo = e.qtd;
        }
        serie.push({ t: e.t, v: Math.max(0, saldo) });
    }

    saldo = Math.max(0, saldo);
    serie.push({ t: new Date(), v: saldo });

    // Consumo médio diário: saídas (sensor + manuais) dos últimos 7 dias
    const inicioJanela = Math.max(Date.now() - 7 * DIA_MS, base.getTime());
    const diasJanela = Math.max((Date.now() - inicioJanela) / DIA_MS, 1 / 24);
    const consumido = linha
        .filter(e => (e.tipo === "sensor" || e.tipo === "saida") && e.t.getTime() >= inicioJanela)
        .reduce((s, e) => s + e.qtd, 0);
    const consumoDia = consumido / diasJanela;

    const cobertura = consumoDia > 0 ? saldo / consumoDia : Infinity;
    const pontoPedido = Math.ceil(p.minimo + consumoDia * p.prazo);

    let status = "ok";
    if (saldo <= 0) status = "esgotado";
    else if (saldo <= p.minimo) status = "critico";
    else if (saldo <= pontoPedido) status = "atencao";

    const sugestao = saldo <= pontoPedido
        ? Math.max(p.minimo, Math.ceil(consumoDia * (p.prazo + config.diasCobertura) + p.minimo - saldo))
        : 0;

    const saidasHoje = linha.filter(e => (e.tipo === "sensor" || e.tipo === "saida") && e.t >= inicioDoDia())
        .reduce((s, e) => s + e.qtd, 0);

    return { saldo, serie, contagens, consumoDia, cobertura, pontoPedido, status, sugestao, saidasHoje };
}

function recalcular() {
    estado.calculos = new Map(produtos.map(p => [p.id, calcularProduto(p)]));
}

function todasContagens() {
    return [...estado.calculos.values()]
        .flatMap(c => c.contagens)
        .sort((a, b) => b.data - a.data);
}

function acuracidade(c) {
    const maior = Math.max(c.esperado, c.contado);
    return maior === 0 ? 1 : 1 - Math.abs(c.contado - c.esperado) / maior;
}

/* =========================================================
   BUSCA DE DADOS
   ========================================================= */

async function carregarMovimentacoes() {
    try {
        const resposta = await fetch(API_URL);
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);

        const dados = await resposta.json();
        if (!Array.isArray(dados)) throw new Error("Resposta inesperada da API");

        dados.forEach(m => { m._data = new Date(m.created_at); });
        dados.sort((a, b) => b._data - a._data);

        detectarNovos(dados);
        estado.dados = dados;
        estado.erro = false;
        estado.ultimaSync = new Date();
    } catch (erro) {
        console.error("Erro ao carregar movimentações:", erro);
        estado.erro = true;
    }
    renderizarTudo();
}

function detectarNovos(dados) {
    const novos = dados.filter(m => !estado.idsConhecidos.has(m.id));
    dados.forEach(m => estado.idsConhecidos.add(m.id));
    estado.novosIds = new Set();

    if (estado.primeiraCarga) {
        estado.primeiraCarga = false;
        return;
    }
    if (!novos.length) return;

    novos.forEach(m => estado.novosIds.add(m.id));
    const prod = produtoDoDispositivo(novos[0].dispositivo);
    mostrarToast(novos.length === 1
        ? `Movimento detectado${prod ? ` · ${prod.nome}` : ` em ${novos[0].dispositivo ?? "sensor"}`}`
        : `${novos.length} novas movimentações detectadas`);

    if (config.som) tocarBip();

    if (document.hidden) {
        estado.naoVistos += novos.length;
        document.title = `(${estado.naoVistos}) TempWatch | Monitoramento de Estoque`;
    }
}

/* =========================================================
   RENDERIZAÇÃO
   ========================================================= */

function renderizarTudo() {
    recalcular();
    renderHero();
    renderProdutos();
    renderReposicao();
    renderFeed();
    renderGraficoEventos();
    renderGraficoNivel();
    renderGraficoTurnos();
    renderGraficoSemana();
    renderHeatmap();
    renderForaExpediente();
    renderHistorico();
    renderRelatorio();
    renderAuditoria();
    renderSensores();
    renderAlertas();
    renderStatus();
    renderSync();
}

/* ---------- STATUS DO SENSOR ---------- */

function statusSensor() {
    if (estado.erro) return "offline";
    const ultima = estado.dados[0]?._data;
    const minutos = ultima ? (Date.now() - ultima) / 60000 : Infinity;
    return minutos <= config.minutosOcioso ? "online" : "ocioso";
}

function renderStatus() {
    const el = $("deviceStatus");
    const nome = estado.dados[0]?.dispositivo || "ESP32-01";
    const status = statusSensor();
    el.dataset.status = status;
    $("deviceTexto").textContent = {
        online: `${nome} · ativo`,
        ocioso: `${nome} · parado`,
        offline: `${nome} · offline`
    }[status];
}

function renderSync() {
    const el = $("syncTexto");
    if (estado.pausado) el.textContent = "⏸ Atualização pausada";
    else if (estado.erro) el.textContent = "⚠ Falha ao sincronizar, tentando novamente...";
    else if (estado.ultimaSync) {
        const seg = Math.floor((Date.now() - estado.ultimaSync) / 1000);
        el.textContent = seg < 5 ? "● Atualizado agora" : `● Atualizado há ${seg}s`;
    }
}

/* ---------- INÍCIO ---------- */

function renderHero() {
    const dados = estado.dados;
    const calcs = [...estado.calculos.values()];

    // Itens e valor
    if (produtos.length) {
        const total = calcs.reduce((s, c) => s + c.saldo, 0);
        const valor = produtos.reduce((s, p) => s + estado.calculos.get(p.id).saldo * (p.custo || 0), 0);
        $("kpiItens").textContent = num(total);
        $("kpiItensDet").textContent = `${produtos.length} produto${produtos.length > 1 ? "s" : ""} monitorado${produtos.length > 1 ? "s" : ""}`;
        $("kpiValor").textContent = moeda(valor);
    } else {
        $("kpiItens").textContent = "--";
        $("kpiItensDet").textContent = "Nenhum produto cadastrado";
        $("kpiValor").textContent = "--";
    }

    // Hoje x ontem até o mesmo horário
    const hoje = inicioDoDia();
    const ontem = new Date(hoje.getTime() - DIA_MS);
    const mesmoHorarioOntem = new Date(Date.now() - DIA_MS);
    const qtdHoje = dados.filter(m => m._data >= hoje).length;
    const qtdOntem = dados.filter(m => m._data >= ontem && m._data <= mesmoHorarioOntem).length;
    $("kpiHoje").textContent = num(qtdHoje);

    const det = $("kpiHojeDet");
    if (!qtdOntem) {
        det.textContent = qtdHoje ? "Sem registros ontem até este horário" : "Nenhum evento hoje ainda";
        det.className = "trend";
    } else {
        const pct = Math.round(((qtdHoje - qtdOntem) / qtdOntem) * 100);
        det.textContent = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs. ontem até agora`;
        det.className = `trend ${pct >= 0 ? "up" : "down"}`;
    }

    // Última
    const ultima = dados[0];
    if (ultima) {
        $("kpiUltima").textContent = hora(ultima._data);
        $("kpiUltimaDet").textContent = tempoRelativo(ultima._data);
    }

    // Acuracidade
    const contagens = todasContagens();
    if (contagens.length) {
        const media = contagens.reduce((s, c) => s + acuracidade(c), 0) / contagens.length;
        $("kpiAcuracidade").textContent = `${num(media * 100, 1)}%`;
        $("kpiAcuracidadeDet").textContent = `Média de ${contagens.length} contage${contagens.length > 1 ? "ns" : "m"}`;
    } else {
        $("kpiAcuracidade").textContent = "--";
        $("kpiAcuracidadeDet").textContent = "Faça uma contagem física";
    }

    // Frase de destaque
    let frase;
    if (estado.erro && !dados.length) {
        frase = "Não foi possível falar com o sensor. Tentando novamente...";
    } else if (!produtos.length) {
        frase = `${num(qtdHoje)} movimento${qtdHoje !== 1 ? "s" : ""} detectado${qtdHoje !== 1 ? "s" : ""} hoje. Cadastre um produto para transformar movimentos em estoque.`;
    } else {
        const criticos = calcs.filter(c => c.status === "critico" || c.status === "esgotado").length;
        frase = criticos
            ? `${criticos} produto${criticos > 1 ? "s precisam" : " precisa"} de reposição urgente. ${num(qtdHoje)} movimento${qtdHoje !== 1 ? "s" : ""} hoje.`
            : `Estoque sob controle. ${num(qtdHoje)} movimento${qtdHoje !== 1 ? "s" : ""} detectado${qtdHoje !== 1 ? "s" : ""} hoje.`;
    }
    $("heroFrase").textContent = frase;
}

/* ---------- PRODUTOS ---------- */

const ROTULO_STATUS = {
    ok: "Em dia",
    atencao: "Repor em breve",
    critico: "Abaixo do mínimo",
    esgotado: "Esgotado"
};

function renderProdutos() {
    const grid = $("produtosGrid");

    if (!produtos.length) {
        grid.innerHTML = `
            <div class="panel vazio-produtos">
                <div class="vazio-icone">📦</div>
                <h3>Nenhum produto cadastrado</h3>
                <p>Cadastre o produto que o sensor monitora para ver saldo, previsão de ruptura e sugestão de compra.</p>
                <button class="btn btn-primary" data-novo-produto>+ Cadastrar primeiro produto</button>
            </div>`;
        return;
    }

    grid.innerHTML = produtos.map(p => {
        const c = estado.calculos.get(p.id);
        const ref = Math.max(c.pontoPedido * 2, p.minimo * 3, c.saldo, 1);
        const pct = Math.min(100, (c.saldo / ref) * 100);
        const ultimoLanc = estado.dados.find(m => m.dispositivo === p.dispositivo);

        return `
        <article class="produto-card" data-status="${c.status}">
            <header>
                <div>
                    <h3>${esc(p.nome)}</h3>
                    <small>${p.sku ? `SKU ${esc(p.sku)} · ` : ""}📡 ${esc(p.dispositivo)}</small>
                </div>
                <span class="status-tag" data-status="${c.status}">${ROTULO_STATUS[c.status]}</span>
            </header>

            <div class="produto-saldo">
                <strong>${num(c.saldo)}</strong><span>un.</span>
            </div>

            <div class="progress" title="Mínimo: ${p.minimo} · Ponto de pedido: ${c.pontoPedido}">
                <div class="progress-bar" data-nivel="${c.status}" style="width:${pct}%"></div>
                <i class="marca" style="left:${Math.min(100, (p.minimo / ref) * 100)}%" title="Estoque mínimo"></i>
            </div>

            <dl class="produto-metricas">
                <div><dt>Saídas hoje</dt><dd>${num(c.saidasHoje)}</dd></div>
                <div><dt>Consumo/dia</dt><dd>${num(c.consumoDia, 1)}</dd></div>
                <div><dt>Dura cerca de</dt><dd>${formatarDias(c.cobertura)}</dd></div>
                <div><dt>Valor</dt><dd>${p.custo ? moeda(c.saldo * p.custo) : "—"}</dd></div>
            </dl>

            <small class="produto-rodape">Último movimento: ${ultimoLanc ? tempoRelativo(ultimoLanc._data) : "nenhum ainda"}</small>

            <div class="produto-acoes">
                <button class="btn btn-sm" data-mov="entrada" data-id="${p.id}">+ Entrada</button>
                <button class="btn btn-sm" data-mov="saida" data-id="${p.id}">− Saída</button>
                <button class="btn btn-sm" data-mov="contagem" data-id="${p.id}">Contar</button>
                <button class="btn btn-sm btn-icone" data-editar="${p.id}" title="Editar produto">✎</button>
            </div>
        </article>`;
    }).join("");
}

function renderReposicao() {
    const lista = produtos
        .map(p => ({ p, c: estado.calculos.get(p.id) }))
        .filter(({ c }) => c.sugestao > 0)
        .sort((a, b) => a.c.cobertura - b.c.cobertura);

    const tbody = $("tabelaReposicao");
    if (!lista.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="vazio">${produtos.length
            ? "✓ Nenhum produto precisa de reposição agora."
            : "Cadastre produtos para receber sugestões de compra."}</td></tr>`;
        $("btnCopiarPedido").disabled = true;
        return;
    }

    $("btnCopiarPedido").disabled = false;
    tbody.innerHTML = lista.map(({ p, c }) => `
        <tr>
            <td><strong>${esc(p.nome)}</strong>${p.sku ? `<small class="relativo">SKU ${esc(p.sku)}</small>` : ""}</td>
            <td><span class="status-tag" data-status="${c.status}">${num(c.saldo)} un.</span></td>
            <td>${num(c.pontoPedido)}</td>
            <td>${num(c.consumoDia, 1)}</td>
            <td><strong>${num(c.sugestao)} un.</strong></td>
            <td>${p.custo ? moeda(c.sugestao * p.custo) : "—"}</td>
        </tr>`).join("");
}

function copiarPedido() {
    const linhas = produtos
        .map(p => ({ p, c: estado.calculos.get(p.id) }))
        .filter(({ c }) => c.sugestao > 0)
        .map(({ p, c }) => `- ${p.nome}${p.sku ? ` (${p.sku})` : ""}: ${c.sugestao} un.`);

    const texto = `Pedido de compra (${new Date().toLocaleDateString("pt-BR")})\n${linhas.join("\n")}`;
    navigator.clipboard?.writeText(texto)
        .then(() => mostrarToast("Lista de compra copiada."))
        .catch(() => mostrarToast("Não foi possível copiar a lista."));
}

/* ---------- FEED ---------- */

function renderFeed() {
    const recentes = estado.dados.slice(0, 8);
    const feed = $("feed");

    if (!recentes.length) {
        feed.innerHTML = `<li class="feed-vazio">${estado.erro ? "Sem conexão com o sensor." : "Nenhuma movimentação registrada ainda."}</li>`;
        return;
    }

    feed.innerHTML = recentes.map(m => {
        const prod = produtoDoDispositivo(m.dispositivo);
        const fora = foraDoExpediente(m._data);
        return `
        <li class="${estado.novosIds.has(m.id) ? "novo" : ""}">
            <span class="feed-dot ${fora ? "fora" : ""}"></span>
            <div class="feed-info">
                <strong>${esc(prod ? prod.nome : (m.evento || "Movimento detectado"))}</strong>
                <small>${esc(m.dispositivo)} · ${hora(m._data, true)}${fora ? " · fora do expediente" : ""}</small>
            </div>
            <span class="feed-tempo">${tempoRelativo(m._data)}</span>
        </li>`;
    }).join("");
}

/* ---------- GRÁFICOS ---------- */

function opcoesBase(extra = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { display: false }, ...extra.plugins },
        scales: {
            x: {
                grid: { display: false },
                ticks: { color: corCSS("--muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
                ...extra.x
            },
            y: {
                beginAtZero: true,
                ticks: { color: corCSS("--muted"), precision: 0 },
                grid: { color: corCSS("--border") },
                ...extra.y
            }
        }
    };
}

function desenhar(nome, canvasId, config) {
    if (typeof Chart === "undefined") return;
    if (graficos[nome]) {
        graficos[nome].data = config.data;
        graficos[nome].update("none");
    } else {
        graficos[nome] = new Chart($(canvasId), config);
    }
}

function serieEventos(periodo) {
    const labels = [];
    const valores = [];

    if (periodo === "24h") {
        const inicio = new Date();
        inicio.setMinutes(0, 0, 0);
        inicio.setHours(inicio.getHours() - 23);
        for (let i = 0; i < 24; i++) {
            labels.push(`${dd(new Date(inicio.getTime() + i * HORA_MS).getHours())}h`);
            valores.push(0);
        }
        estado.dados.forEach(m => {
            const idx = Math.floor((m._data - inicio) / HORA_MS);
            if (idx >= 0 && idx < 24) valores[idx]++;
        });
    } else {
        const dias = periodo === "7d" ? 7 : 30;
        const inicio = inicioDoDia();
        inicio.setDate(inicio.getDate() - (dias - 1));
        for (let i = 0; i < dias; i++) {
            const t = new Date(inicio);
            t.setDate(inicio.getDate() + i);
            labels.push(t.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }));
            valores.push(0);
        }
        estado.dados.forEach(m => {
            const idx = Math.round((inicioDoDia(m._data) - inicio) / DIA_MS);
            if (idx >= 0 && idx < dias) valores[idx]++;
        });
    }
    return { labels, valores };
}

function renderGraficoEventos() {
    const { labels, valores } = serieEventos(estado.periodoGrafico);
    desenhar("eventos", "graficoEventos", {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Movimentações",
                data: valores,
                borderColor: corCSS("--accent"),
                backgroundColor: corCSS("--accent-soft"),
                fill: true,
                tension: 0.35,
                cubicInterpolationMode: "monotone",
                pointRadius: 3,
                pointHoverRadius: 6
            }]
        },
        options: opcoesBase()
    });
}

function renderGraficoNivel() {
    const sel = $("selProdutoNivel");
    const atual = sel.value;
    sel.innerHTML = produtos.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join("");
    if (produtos.some(p => p.id === atual)) sel.value = atual;

    const vazio = !produtos.length;
    sel.classList.toggle("hidden", vazio);
    $("nivelVazio").classList.toggle("hidden", !vazio);
    $("graficoNivel").parentElement.classList.toggle("hidden", vazio);
    if (vazio) return;

    const p = produtos.find(x => x.id === sel.value) || produtos[0];
    const c = estado.calculos.get(p.id);

    // Limita aos últimos 300 pontos para manter o gráfico leve
    const serie = c.serie.slice(-300);
    const formato = { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" };

    desenhar("nivel", "graficoNivel", {
        type: "line",
        data: {
            labels: serie.map(s => s.t.toLocaleString("pt-BR", formato)),
            datasets: [
                {
                    label: "Saldo",
                    data: serie.map(s => s.v),
                    borderColor: corCSS("--accent"),
                    backgroundColor: corCSS("--accent-soft"),
                    fill: true,
                    stepped: true,
                    pointRadius: 0,
                    pointHoverRadius: 5
                },
                {
                    label: "Mínimo",
                    data: serie.map(() => p.minimo),
                    borderColor: corCSS("--danger"),
                    borderDash: [6, 5],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: opcoesBase({
            plugins: { legend: { display: true, labels: { color: corCSS("--muted"), boxWidth: 12 } } },
            x: { ticks: { color: corCSS("--muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } }
        })
    });
}

function renderGraficoTurnos() {
    const limite = new Date(Date.now() - 30 * DIA_MS);
    const valores = TURNOS.map(() => 0);
    estado.dados.filter(m => m._data >= limite).forEach(m => {
        const h = m._data.getHours();
        valores[TURNOS.findIndex(t => h >= t.de && h < t.ate)]++;
    });

    desenhar("turnos", "graficoTurnos", {
        type: "bar",
        data: {
            labels: TURNOS.map(t => `${t.nome} (${dd(t.de)}h–${dd(t.ate % 24)}h)`),
            datasets: [{
                label: "Eventos",
                data: valores,
                backgroundColor: valores.map(v => v === Math.max(...valores) && v > 0 ? corCSS("--accent") : corCSS("--bar-muted")),
                borderRadius: 6
            }]
        },
        options: { ...opcoesBase(), indexAxis: "y", scales: {
            x: { beginAtZero: true, ticks: { color: corCSS("--muted"), precision: 0 }, grid: { color: corCSS("--border") } },
            y: { grid: { display: false }, ticks: { color: corCSS("--muted") } }
        } }
    });
}

function renderGraficoSemana() {
    const limite = new Date(Date.now() - 30 * DIA_MS);
    const valores = Array(7).fill(0);
    estado.dados.filter(m => m._data >= limite).forEach(m => valores[m._data.getDay()]++);
    const hoje = new Date().getDay();

    desenhar("semana", "graficoSemana", {
        type: "bar",
        data: {
            labels: DIAS_SEMANA,
            datasets: [{
                label: "Eventos",
                data: valores,
                backgroundColor: valores.map((_, i) => i === hoje ? corCSS("--accent") : corCSS("--bar-muted")),
                borderRadius: 6
            }]
        },
        options: opcoesBase()
    });
}

function recriarGraficos() {
    Object.keys(graficos).forEach(k => { graficos[k].destroy(); delete graficos[k]; });
    renderGraficoEventos();
    renderGraficoNivel();
    renderGraficoTurnos();
    renderGraficoSemana();
}

function renderHeatmap() {
    const limite = new Date(Date.now() - 30 * DIA_MS);
    const matriz = Array.from({ length: 7 }, () => Array(24).fill(0));
    estado.dados.filter(m => m._data >= limite)
        .forEach(m => matriz[m._data.getDay()][m._data.getHours()]++);

    const max = Math.max(1, ...matriz.flat());
    let html = `<div></div>`;
    for (let h = 0; h < 24; h++) html += `<div class="hm-hora">${h % 3 === 0 ? dd(h) : ""}</div>`;

    matriz.forEach((linha, dia) => {
        html += `<div class="hm-dia">${DIAS_SEMANA[dia]}</div>`;
        linha.forEach((qtd, h) => {
            const estilo = qtd ? `background: rgba(var(--accent-rgb), ${(0.15 + 0.85 * (qtd / max)).toFixed(2)})` : "";
            html += `<div class="hm-cel" style="${estilo}" title="${DIAS_SEMANA[dia]}, ${dd(h)}h: ${qtd} evento${qtd !== 1 ? "s" : ""}"></div>`;
        });
    });
    $("heatmap").innerHTML = html;
}

/* ---------- FORA DO EXPEDIENTE ---------- */

function eventosForaExpediente(dias = 7) {
    const limite = new Date(Date.now() - dias * DIA_MS);
    return estado.dados.filter(m => m._data >= limite && foraDoExpediente(m._data));
}

function renderForaExpediente() {
    const lista = eventosForaExpediente();
    const diasTxt = config.dias.length === 7 ? "todos os dias" : config.dias.map(d => DIAS_SEMANA[d]).join(", ");
    $("foraExpedienteDesc").textContent =
        `Expediente: ${config.inicio}–${config.fim}, ${diasTxt}. Detecções fora disso nos últimos 7 dias.`;

    const ul = $("listaForaExpediente");
    if (!lista.length) {
        ul.innerHTML = `<li class="ok-msg">✓ Nenhum movimento fora do expediente nos últimos 7 dias.</li>`;
        return;
    }
    ul.innerHTML = lista.slice(0, 12).map(m => {
        const prod = produtoDoDispositivo(m.dispositivo);
        return `
        <li>
            <span class="fora-data">${DIAS_SEMANA[m._data.getDay()]} ${m._data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</span>
            <strong>${hora(m._data)}</strong>
            <span>${esc(prod ? prod.nome : m.dispositivo)}</span>
            <small>${tempoRelativo(m._data)}</small>
        </li>`;
    }).join("") + (lista.length > 12 ? `<li class="mais">+ ${lista.length - 12} outros</li>` : "");
}

/* ---------- HISTÓRICO UNIFICADO ---------- */

function registrosHistorico() {
    const doSensor = estado.dados.map(m => {
        const prod = produtoDoDispositivo(m.dispositivo);
        return {
            data: m._data,
            tipo: "sensor",
            produto: prod ? prod.nome : "—",
            qtd: prod ? -prod.unidades : -1,
            origem: m.dispositivo,
            detalhes: `${m.evento ?? ""}${m.id != null ? ` · #${m.id}` : ""}`,
            novo: estado.novosIds.has(m.id),
            fora: foraDoExpediente(m._data)
        };
    });

    const manuais = lancamentos.map(l => {
        const prod = produtos.find(p => p.id === l.produtoId);
        let qtd = l.tipo === "entrada" ? l.qtd : l.tipo === "saida" ? -l.qtd : l.qtd;
        let detalhes = l.obs || "";
        if (l.tipo === "contagem") {
            const c = todasContagens().find(x => x.ref === l);
            if (c) {
                const div = c.contado - c.esperado;
                detalhes = `Sistema: ${c.esperado} · divergência ${div > 0 ? "+" : ""}${div}${l.obs ? ` · ${l.obs}` : ""}`;
            }
        }
        return {
            data: new Date(l.data),
            tipo: l.tipo,
            produto: prod ? prod.nome : "(produto excluído)",
            qtd,
            origem: "Manual",
            detalhes,
            lancId: l.id
        };
    });

    return [...doSensor, ...manuais].sort((a, b) => b.data - a.data);
}

function historicoFiltrado() {
    const termo = $("busca").value.trim().toLowerCase();
    const tipo = $("filtroTipo").value;
    const inicio = inicioPeriodo($("filtroPeriodo").value);

    return registrosHistorico().filter(r =>
        (tipo === "todos" || r.tipo === tipo) &&
        (!inicio || r.data >= inicio) &&
        (!termo || `${r.produto} ${r.origem} ${r.detalhes} ${TIPOS[r.tipo]}`.toLowerCase().includes(termo))
    );
}

function renderHistorico() {
    const lista = historicoFiltrado();
    const totalPaginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    estado.pagina = Math.min(Math.max(1, estado.pagina), totalPaginas);
    const pagina = lista.slice((estado.pagina - 1) * POR_PAGINA, estado.pagina * POR_PAGINA);

    const tbody = $("tabelaHistorico");
    if (!pagina.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="vazio">${registrosHistorico().length
            ? "Nenhum registro encontrado para esse filtro."
            : estado.erro ? "Não foi possível carregar as movimentações." : "Nenhuma movimentação registrada ainda."}</td></tr>`;
    } else {
        tbody.innerHTML = pagina.map(r => `
            <tr class="${r.novo ? "novo" : ""}">
                <td>${r.data.toLocaleString("pt-BR")}<small class="relativo">${tempoRelativo(r.data)}${r.fora ? " · 🌙 fora do expediente" : ""}</small></td>
                <td><span class="tipo-tag" data-tipo="${r.tipo}">${TIPOS[r.tipo]}</span></td>
                <td>${esc(r.produto)}</td>
                <td class="qtd ${r.tipo === "contagem" ? "" : r.qtd > 0 ? "pos" : "neg"}">${r.tipo === "contagem" ? "= " + num(r.qtd) : (r.qtd > 0 ? "+" : "") + num(r.qtd)}</td>
                <td>${esc(r.origem)}</td>
                <td class="detalhes">${esc(r.detalhes)}</td>
                <td>${r.lancId ? `<button class="btn btn-sm btn-icone" data-excluir-lanc="${r.lancId}" title="Excluir lançamento">🗑</button>` : ""}</td>
            </tr>`).join("");
    }

    $("infoPagina").textContent = `Página ${estado.pagina} de ${totalPaginas} · ${num(lista.length)} registro(s)`;
    $("btnAnterior").disabled = estado.pagina <= 1;
    $("btnProxima").disabled = estado.pagina >= totalPaginas;
}

function exportarCSV() {
    const lista = historicoFiltrado();
    if (!lista.length) return mostrarToast("Não há registros para exportar com esse filtro.");

    const linhas = [
        ["Data e horário", "Tipo", "Produto", "Quantidade", "Origem", "Detalhes", "Fora do expediente"],
        ...lista.map(r => [r.data.toLocaleString("pt-BR"), TIPOS[r.tipo], r.produto, r.qtd, r.origem, r.detalhes, r.fora ? "Sim" : ""])
    ];
    baixarArquivo(
        "﻿" + linhas.map(l => l.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n"),
        `movimentacoes-${new Date().toISOString().slice(0, 10)}.csv`,
        "text/csv;charset=utf-8"
    );
}

function baixarArquivo(conteudo, nome, tipo) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    link.download = nome;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* ---------- RELATÓRIO ---------- */

function renderRelatorio() {
    const periodo = estado.periodoRelatorio;
    const inicio = inicioPeriodo(periodo);
    const nomePeriodo = { hoje: "Hoje", "7d": "Últimos 7 dias", "30d": "Últimos 30 dias" }[periodo];
    const eventos = estado.dados.filter(m => m._data >= inicio);
    const manuais = lancamentos.filter(l => new Date(l.data) >= inicio);
    const dias = periodo === "hoje" ? 1 : periodo === "7d" ? 7 : 30;

    const porHora = Array(24).fill(0);
    eventos.forEach(m => porHora[m._data.getHours()]++);
    const maxHora = Math.max(...porHora);
    const pico = maxHora ? `${dd(porHora.indexOf(maxHora))}h–${dd((porHora.indexOf(maxHora) + 1) % 24)}h` : "—";

    const entradas = manuais.filter(l => l.tipo === "entrada").reduce((s, l) => s + l.qtd, 0);
    const saidasManuais = manuais.filter(l => l.tipo === "saida").reduce((s, l) => s + l.qtd, 0);
    const fora = eventos.filter(m => foraDoExpediente(m._data)).length;
    const contagens = todasContagens().filter(c => c.data >= inicio);

    const linhasProdutos = produtos.map(p => {
        const c = estado.calculos.get(p.id);
        const saidas = eventos.filter(m => m.dispositivo === p.dispositivo && m._data >= new Date(p.dataBase)).length * p.unidades
            + manuais.filter(l => l.produtoId === p.id && l.tipo === "saida").reduce((s, l) => s + l.qtd, 0);
        const ent = manuais.filter(l => l.produtoId === p.id && l.tipo === "entrada").reduce((s, l) => s + l.qtd, 0);
        return `<tr>
            <td>${esc(p.nome)}</td>
            <td class="qtd pos">+${num(ent)}</td>
            <td class="qtd neg">−${num(saidas)}</td>
            <td>${num(c.saldo)}</td>
            <td><span class="status-tag" data-status="${c.status}">${ROTULO_STATUS[c.status]}</span></td>
        </tr>`;
    }).join("");

    $("relatorio").innerHTML = `
        <div class="relatorio-topo">
            <div>
                <h3>Relatório de movimentação · ${nomePeriodo}</h3>
                <p>Gerado em ${new Date().toLocaleString("pt-BR")}</p>
            </div>
        </div>
        <div class="relatorio-numeros">
            <div><span>Movimentos (sensor)</span><strong>${num(eventos.length)}</strong></div>
            <div><span>Média por dia</span><strong>${num(eventos.length / dias, 1)}</strong></div>
            <div><span>Horário de pico</span><strong>${pico}</strong></div>
            <div><span>Entradas manuais</span><strong>+${num(entradas)}</strong></div>
            <div><span>Saídas manuais</span><strong>−${num(saidasManuais)}</strong></div>
            <div><span>Fora do expediente</span><strong class="${fora ? "txt-alerta" : ""}">${num(fora)}</strong></div>
            <div><span>Contagens físicas</span><strong>${num(contagens.length)}</strong></div>
        </div>
        ${produtos.length ? `
        <div class="table-container">
            <table>
                <thead><tr><th>Produto</th><th>Entradas</th><th>Saídas</th><th>Saldo atual</th><th>Situação</th></tr></thead>
                <tbody>${linhasProdutos}</tbody>
            </table>
        </div>` : `<p class="vazio-msg">Cadastre produtos para ver o resumo por item.</p>`}
    `;
}

function renderAuditoria() {
    const contagens = todasContagens();
    const tbody = $("tabelaAuditoria");
    if (!contagens.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="vazio">Nenhuma contagem física registrada. Conte o estoque na prateleira e lance o resultado para medir a precisão do sensor.</td></tr>`;
        return;
    }
    tbody.innerHTML = contagens.slice(0, 20).map(c => {
        const div = c.contado - c.esperado;
        const ac = acuracidade(c) * 100;
        return `<tr>
            <td>${c.data.toLocaleString("pt-BR")}</td>
            <td>${esc(c.produto.nome)}</td>
            <td>${num(c.esperado)}</td>
            <td>${num(c.contado)}</td>
            <td class="qtd ${div === 0 ? "" : div > 0 ? "pos" : "neg"}">${div > 0 ? "+" : ""}${num(div)}</td>
            <td><span class="status-tag" data-status="${ac >= 98 ? "ok" : ac >= 90 ? "atencao" : "critico"}">${num(ac, 1)}%</span></td>
        </tr>`;
    }).join("");
}

/* ---------- CONFIGURAÇÕES ---------- */

function renderSensores() {
    const vistos = new Map();
    estado.dados.forEach(m => {
        if (!vistos.has(m.dispositivo)) vistos.set(m.dispositivo, { ultima: m._data, total: 0 });
        vistos.get(m.dispositivo).total++;
    });
    produtos.forEach(p => { if (!vistos.has(p.dispositivo)) vistos.set(p.dispositivo, { ultima: null, total: 0 }); });

    $("listaDispositivos").innerHTML = [...vistos.keys()].map(d => `<option value="${esc(d)}">`).join("");

    const ul = $("listaSensores");
    if (!vistos.size) {
        ul.innerHTML = `<li class="vazio-msg">Nenhum sensor enviou dados ainda.</li>`;
        return;
    }
    ul.innerHTML = [...vistos.entries()].map(([disp, info]) => {
        const ligados = produtos.filter(p => p.dispositivo === disp).map(p => p.nome);
        return `<li>
            <span class="sensor-icone">📡</span>
            <div>
                <strong>${esc(disp)}</strong>
                <small>${num(info.total)} evento(s) · último ${info.ultima ? tempoRelativo(info.ultima) : "nunca"}</small>
                <small>${ligados.length ? `Ligado a: ${esc(ligados.join(", "))}` : `<span class="txt-alerta">Sem produto vinculado</span>`}</small>
            </div>
        </li>`;
    }).join("");
}

function preencherConfig() {
    $("cfgInicio").value = config.inicio;
    $("cfgFim").value = config.fim;
    $("cfgOcioso").value = config.minutosOcioso;
    $("cfgCobertura").value = config.diasCobertura;
    $("cfgDias").innerHTML = DIAS_SEMANA.map((d, i) => `
        <label class="dia ${config.dias.includes(i) ? "on" : ""}">
            <input type="checkbox" value="${i}" ${config.dias.includes(i) ? "checked" : ""}> ${d}
        </label>`).join("");
}

/* ---------- ALERTAS ---------- */

function calcularAlertas() {
    const alertas = [];

    produtos.forEach(p => {
        const c = estado.calculos.get(p.id);
        if (c.status === "esgotado") alertas.push({ nivel: "critico", texto: `${p.nome} está esgotado`, alvo: "#estoque" });
        else if (c.status === "critico") alertas.push({ nivel: "critico", texto: `${p.nome} abaixo do mínimo (${c.saldo} un.)`, alvo: "#estoque" });
        else if (c.status === "atencao") alertas.push({ nivel: "atencao", texto: `${p.nome} chegou ao ponto de pedido`, alvo: "#estoque" });
    });

    const status = statusSensor();
    if (status === "offline") alertas.push({ nivel: "critico", texto: "Sem conexão com a API do sensor", alvo: "#configuracoes" });
    else if (status === "ocioso" && estado.dados[0] && !foraDoExpediente(new Date()))
        alertas.push({ nivel: "atencao", texto: `Sensor sem movimento ${tempoRelativo(estado.dados[0]._data)} durante o expediente`, alvo: "#analises" });

    const foraHoje = estado.dados.filter(m => m._data >= inicioDoDia() && foraDoExpediente(m._data)).length;
    if (foraHoje) alertas.push({ nivel: "atencao", texto: `${foraHoje} movimento(s) fora do expediente hoje`, alvo: "#analises" });

    const semProduto = [...new Set(estado.dados.map(m => m.dispositivo))].filter(d => d && !produtoDoDispositivo(d));
    if (semProduto.length && produtos.length)
        alertas.push({ nivel: "info", texto: `Sensor ${semProduto[0]} sem produto vinculado`, alvo: "#configuracoes" });

    return alertas;
}

function renderAlertas() {
    const alertas = calcularAlertas();
    const criticos = alertas.filter(a => a.nivel === "critico").length;

    const badge = $("alertasCount");
    badge.textContent = alertas.length;
    badge.classList.toggle("hidden", !alertas.length);
    badge.dataset.nivel = criticos ? "critico" : "atencao";

    $("alertasResumo").textContent = alertas.length ? `${alertas.length} ativo(s)` : "Tudo certo";
    $("alertasLista").innerHTML = alertas.length
        ? alertas.map(a => `<li data-nivel="${a.nivel}"><a href="${a.alvo}">${esc(a.texto)}</a></li>`).join("")
        : `<li class="ok-msg">✓ Nenhum alerta no momento.</li>`;

    $("kpiAlertas").textContent = alertas.length;
    $("kpiAlertasDet").textContent = alertas.length
        ? (criticos ? `${criticos} crítico(s)` : "Requer atenção")
        : "Tudo certo";
    $("kpiAlertas").parentElement.dataset.nivel = criticos ? "critico" : alertas.length ? "atencao" : "";
}

/* =========================================================
   MODAIS
   ========================================================= */

let produtoEditando = null;
let tipoMovimento = "entrada";

function abrirProduto(id = null) {
    produtoEditando = id ? produtos.find(p => p.id === id) : null;
    const p = produtoEditando;
    const dispositivoPadrao = estado.dados[0]?.dispositivo || "ESP32-01";

    $("tituloProduto").textContent = p ? "Editar produto" : "Novo produto";
    $("prodNome").value = p?.nome ?? "";
    $("prodSku").value = p?.sku ?? "";
    $("prodDispositivo").value = p?.dispositivo ?? dispositivoPadrao;
    $("prodEstoque").value = p ? estado.calculos.get(p.id).saldo : 100;
    $("prodUnidades").value = p?.unidades ?? 1;
    $("prodMinimo").value = p?.minimo ?? 20;
    $("prodPrazo").value = p?.prazo ?? 3;
    $("prodCusto").value = p?.custo || "";

    // Ao editar, o estoque só muda por lançamento (para manter o histórico)
    $("prodEstoque").disabled = !!p;
    $("prodEstoque").title = p ? "Para corrigir o saldo, use “Contar” no card do produto" : "";
    $("btnExcluirProduto").classList.toggle("hidden", !p);
    $("modalProduto").showModal();
}

function salvarProduto() {
    const dados = {
        nome: $("prodNome").value.trim(),
        sku: $("prodSku").value.trim(),
        dispositivo: $("prodDispositivo").value.trim(),
        unidades: Math.max(1, Number($("prodUnidades").value) || 1),
        minimo: Math.max(0, Number($("prodMinimo").value) || 0),
        prazo: Math.max(0, Number($("prodPrazo").value) || 0),
        custo: Math.max(0, Number($("prodCusto").value) || 0)
    };

    if (produtoEditando) {
        Object.assign(produtoEditando, dados);
        mostrarToast(`${dados.nome} atualizado.`);
    } else {
        produtos.push({
            id: gerarId(),
            ...dados,
            estoqueInicial: Math.max(0, Number($("prodEstoque").value) || 0),
            dataBase: new Date().toISOString()
        });
        mostrarToast(`${dados.nome} cadastrado. As próximas detecções de ${dados.dispositivo} serão descontadas.`);
    }
    salvarTudo();
    renderizarTudo();
}

function excluirProduto() {
    if (!produtoEditando) return;
    if (!confirm(`Excluir "${produtoEditando.nome}" e seus lançamentos manuais?`)) return;
    const id = produtoEditando.id;
    produtos = produtos.filter(p => p.id !== id);
    lancamentos = lancamentos.filter(l => l.produtoId !== id);
    salvarTudo();
    $("modalProduto").close();
    renderizarTudo();
    mostrarToast("Produto excluído.");
}

function abrirMovimento(tipo = "entrada", produtoId = null) {
    if (!produtos.length) {
        mostrarToast("Cadastre um produto antes de lançar movimentações.");
        abrirProduto();
        return;
    }
    $("movProduto").innerHTML = produtos.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join("");
    if (produtoId) $("movProduto").value = produtoId;
    $("movQtd").value = "";
    $("movObs").value = "";
    $("movData").value = dataLocalInput();
    definirTipoMovimento(tipo);
    $("modalMovimento").showModal();
    $("movQtd").focus();
}

function definirTipoMovimento(tipo) {
    tipoMovimento = tipo;
    document.querySelectorAll("#tipoMovimento button").forEach(b => b.classList.toggle("active", b.dataset.tipo === tipo));
    $("movQtdLabel").firstChild.textContent = tipo === "contagem" ? "Quantidade contada " : "Quantidade ";
    $("movQtd").min = tipo === "contagem" ? 0 : 1;
    atualizarDicaMovimento();
}

function atualizarDicaMovimento() {
    const c = estado.calculos.get($("movProduto").value);
    if (!c) return;
    $("movDica").textContent = {
        entrada: `Saldo atual: ${c.saldo} un. A quantidade será somada.`,
        saida: `Saldo atual: ${c.saldo} un. Use para perdas, avarias ou saídas que o sensor não registrou.`,
        contagem: `O sistema calcula ${c.saldo} un. Informe o que você contou na prateleira; o saldo será corrigido.`
    }[tipoMovimento];
}

function salvarMovimento() {
    const produtoId = $("movProduto").value;
    const qtd = Math.max(0, Math.round(Number($("movQtd").value) || 0));
    const data = new Date($("movData").value);
    if (isNaN(data)) return mostrarToast("Data inválida.");

    const lanc = { id: gerarId(), produtoId, tipo: tipoMovimento, qtd, data: data.toISOString(), obs: $("movObs").value.trim() };
    lancamentos.push(lanc);
    salvarTudo();
    renderizarTudo();

    const nome = produtos.find(p => p.id === produtoId)?.nome;
    if (tipoMovimento === "contagem") {
        const c = todasContagens().find(x => x.ref === lanc);
        const div = c ? c.contado - c.esperado : 0;
        mostrarToast(div === 0
            ? `Contagem de ${nome} bateu com o sistema. 👏`
            : `Contagem registrada: divergência de ${div > 0 ? "+" : ""}${div} un. em ${nome}.`);
    } else {
        mostrarToast(`${TIPOS[tipoMovimento]} de ${qtd} un. em ${nome} registrada.`);
    }
}

function excluirLancamento(id) {
    if (!confirm("Excluir este lançamento manual?")) return;
    lancamentos = lancamentos.filter(l => l.id !== id);
    salvarTudo();
    renderizarTudo();
    mostrarToast("Lançamento excluído.");
}

/* =========================================================
   BACKUP
   ========================================================= */

function baixarBackup() {
    baixarArquivo(
        JSON.stringify({ versao: 2, exportadoEm: new Date().toISOString(), produtos, lancamentos, config }, null, 2),
        `tempwatch-backup-${new Date().toISOString().slice(0, 10)}.json`,
        "application/json"
    );
}

function restaurarBackup(arquivo) {
    const leitor = new FileReader();
    leitor.onload = () => {
        try {
            const dados = JSON.parse(leitor.result);
            if (!Array.isArray(dados.produtos) || !Array.isArray(dados.lancamentos)) throw new Error();
            if (!confirm(`Restaurar ${dados.produtos.length} produto(s) e ${dados.lancamentos.length} lançamento(s)? Os dados atuais serão substituídos.`)) return;
            produtos = dados.produtos;
            lancamentos = dados.lancamentos;
            config = Object.assign(config, dados.config || {});
            salvarTudo();
            preencherConfig();
            renderizarTudo();
            mostrarToast("Backup restaurado.");
        } catch {
            mostrarToast("Arquivo de backup inválido.");
        }
    };
    leitor.readAsText(arquivo);
}

function limparDados() {
    if (!confirm("Apagar produtos, lançamentos manuais e configurações deste navegador? Os dados do sensor no Supabase não são afetados.")) return;
    produtos = [];
    lancamentos = [];
    ["tw-produtos", "tw-lancamentos", "tw-config", "tw-config-v2"].forEach(k => {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
    });
    renderizarTudo();
    mostrarToast("Dados locais apagados.");
}

/* =========================================================
   NOTIFICAÇÕES, SOM E TEMA
   ========================================================= */

function mostrarToast(mensagem) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = mensagem;
    $("toasts").appendChild(el);
    setTimeout(() => el.classList.add("saindo"), 3800);
    setTimeout(() => el.remove(), 4300);
}

function tocarBip() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const ganho = ctx.createGain();
        osc.frequency.value = 880;
        ganho.gain.setValueAtTime(0.15, ctx.currentTime);
        ganho.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.connect(ganho).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
        setTimeout(() => ctx.close(), 500);
    } catch { /* áudio indisponível */ }
}

function aplicarTema(tema) {
    document.documentElement.dataset.theme = tema;
    $("btnTema").textContent = tema === "dark" ? "☀️" : "🌙";
    salvarStorage("tw-tema", tema);
}

/* =========================================================
   NAVEGAÇÃO
   ========================================================= */

function configurarNavegacao() {
    const links = [...document.querySelectorAll(".nav-links a")];
    const secoes = links.map(a => document.querySelector(a.getAttribute("href")));

    // Destaca o item do menu da seção visível
    const observador = new IntersectionObserver(entradas => {
        entradas.forEach(e => {
            if (e.isIntersecting) {
                links.forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${e.target.id}`));
            }
        });
    }, { rootMargin: "-45% 0px -50% 0px" });
    secoes.forEach(s => s && observador.observe(s));

    // Menu no celular
    const toggle = $("navToggle");
    toggle.addEventListener("click", () => {
        const aberto = $("navLinks").classList.toggle("aberto");
        toggle.setAttribute("aria-expanded", aberto);
        toggle.textContent = aberto ? "✕" : "☰";
    });
    links.forEach(a => a.addEventListener("click", () => {
        $("navLinks").classList.remove("aberto");
        toggle.textContent = "☰";
        toggle.setAttribute("aria-expanded", "false");
    }));

    // Sombra no menu ao rolar
    window.addEventListener("scroll", () => {
        $("navbar").classList.toggle("rolado", window.scrollY > 10);
    }, { passive: true });
}

/* =========================================================
   EVENTOS
   ========================================================= */

function configurarEventos() {
    // Ações delegadas (botões gerados dinamicamente)
    document.addEventListener("click", e => {
        const alvo = e.target.closest("[data-acao], [data-mov], [data-editar], [data-novo-produto], [data-excluir-lanc], [data-fechar]");
        if (!alvo) {
            if (!e.target.closest(".alertas-wrap")) $("alertasPainel").classList.add("hidden");
            return;
        }
        if (alvo.dataset.fechar !== undefined) return alvo.closest("dialog").close();
        if (alvo.dataset.novoProduto !== undefined) return abrirProduto();
        if (alvo.dataset.editar) return abrirProduto(alvo.dataset.editar);
        if (alvo.dataset.excluirLanc) return excluirLancamento(alvo.dataset.excluirLanc);
        if (alvo.dataset.mov) return abrirMovimento(alvo.dataset.mov, alvo.dataset.id);
        if (alvo.dataset.acao) {
            const acao = alvo.dataset.acao;
            abrirMovimento(acao === "movimento" ? "entrada" : acao);
        }
    });

    $("btnNovoProduto").addEventListener("click", () => abrirProduto());
    $("formProduto").addEventListener("submit", salvarProduto);
    $("btnExcluirProduto").addEventListener("click", excluirProduto);

    $("formMovimento").addEventListener("submit", salvarMovimento);
    $("tipoMovimento").addEventListener("click", e => {
        const b = e.target.closest("button");
        if (b) definirTipoMovimento(b.dataset.tipo);
    });
    $("movProduto").addEventListener("change", atualizarDicaMovimento);

    $("btnCopiarPedido").addEventListener("click", copiarPedido);

    // Alertas
    $("btnAlertas").addEventListener("click", () => $("alertasPainel").classList.toggle("hidden"));
    $("alertasLista").addEventListener("click", e => {
        if (e.target.closest("a")) $("alertasPainel").classList.add("hidden");
    });

    // Gráficos
    $("seletorPeriodo").addEventListener("click", e => {
        const b = e.target.closest("button");
        if (!b) return;
        document.querySelectorAll("#seletorPeriodo button").forEach(x => x.classList.toggle("active", x === b));
        estado.periodoGrafico = b.dataset.periodo;
        renderGraficoEventos();
    });
    $("selProdutoNivel").addEventListener("change", () => {
        graficos.nivel?.destroy();
        delete graficos.nivel;
        renderGraficoNivel();
    });

    // Histórico
    $("busca").addEventListener("input", () => { estado.pagina = 1; renderHistorico(); });
    $("filtroTipo").addEventListener("change", () => { estado.pagina = 1; renderHistorico(); });
    $("filtroPeriodo").addEventListener("change", () => { estado.pagina = 1; renderHistorico(); });
    $("btnAnterior").addEventListener("click", () => { estado.pagina--; renderHistorico(); });
    $("btnProxima").addEventListener("click", () => { estado.pagina++; renderHistorico(); });
    $("btnExportar").addEventListener("click", exportarCSV);

    // Relatórios
    $("seletorRelatorio").addEventListener("click", e => {
        const b = e.target.closest("button");
        if (!b) return;
        document.querySelectorAll("#seletorRelatorio button").forEach(x => x.classList.toggle("active", x === b));
        estado.periodoRelatorio = b.dataset.periodo;
        renderRelatorio();
    });
    $("btnImprimir").addEventListener("click", () => {
        document.body.classList.add("imprimindo");
        window.print();
    });
    window.addEventListener("afterprint", () => document.body.classList.remove("imprimindo"));

    // Configurações
    $("cfgDias").addEventListener("change", e => {
        e.target.closest(".dia")?.classList.toggle("on", e.target.checked);
    });
    $("formConfig").addEventListener("submit", e => {
        e.preventDefault();
        const dias = [...$("cfgDias").querySelectorAll("input:checked")].map(i => Number(i.value));
        config.inicio = $("cfgInicio").value;
        config.fim = $("cfgFim").value;
        config.dias = dias;
        config.minutosOcioso = Math.max(1, Number($("cfgOcioso").value) || 30);
        config.diasCobertura = Math.max(1, Number($("cfgCobertura").value) || 14);
        salvarTudo();
        renderizarTudo();
        mostrarToast("Configurações salvas.");
    });

    $("btnBackup").addEventListener("click", baixarBackup);
    $("inputBackup").addEventListener("change", e => {
        if (e.target.files[0]) restaurarBackup(e.target.files[0]);
        e.target.value = "";
    });
    $("btnLimpar").addEventListener("click", limparDados);

    $("btnPausar").addEventListener("click", () => {
        estado.pausado = !estado.pausado;
        $("btnPausar").textContent = estado.pausado ? "▶ Retomar atualização" : "⏸ Pausar atualização";
        if (!estado.pausado) carregarMovimentacoes();
        renderSync();
    });

    $("btnSom").addEventListener("click", () => {
        config.som = !config.som;
        $("btnSom").textContent = config.som ? "🔔" : "🔕";
        if (config.som) tocarBip();
        salvarTudo();
    });

    $("btnTema").addEventListener("click", () => {
        aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
        recriarGraficos();
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            estado.naoVistos = 0;
            document.title = "TempWatch | Monitoramento de Estoque";
        }
    });
}

/* =========================================================
   INICIALIZAÇÃO
   ========================================================= */

function iniciar() {
    const temaSalvo = lerStorage("tw-tema", null);
    const prefereEscuro = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    aplicarTema(temaSalvo || (prefereEscuro ? "dark" : "light"));
    $("btnSom").textContent = config.som ? "🔔" : "🔕";

    preencherConfig();
    configurarNavegacao();
    configurarEventos();
    carregarMovimentacoes();

    setInterval(() => { if (!estado.pausado) carregarMovimentacoes(); }, INTERVALO_ATUALIZACAO);
    setInterval(renderSync, 1000);
}

iniciar();
