const API_URL = "https://dtryptqiigbkozgewcoi.supabase.co/functions/v1/registrar-movimentacao";

async function carregarMovimentacoes() {
    try {
        const resposta = await fetch(API_URL);
        const dados = await resposta.json();

        atualizarDashboard(dados);

    } catch (erro) {
        console.error("Erro ao carregar movimentações:", erro);
    }
}

function atualizarDashboard(movimentacoes) {
    const total = movimentacoes.length;

    document.getElementById("totalMovimentos").textContent = total;

    const ultima = movimentacoes[0];

    if (ultima) {
        const data = new Date(ultima.created_at);

        document.getElementById("ultimaMovimentacao").textContent =
            data.toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            });
    }

    const tabela = document.getElementById("tabelaMovimentacoes");

    tabela.innerHTML = "";

    movimentacoes.forEach(mov => {
        const linha = document.createElement("tr");

        linha.innerHTML = `
            <td>${mov.id}</td>
            <td>${mov.dispositivo}</td>
            <td>${mov.evento}</td>
            <td>${mov.total_movimentos}</td>
            <td>${new Date(mov.created_at).toLocaleString("pt-BR")}</td>
        `;

        tabela.appendChild(linha);
    });
}

carregarMovimentacoes();
setInterval(carregarMovimentacoes, 10000);
