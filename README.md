### Sistema IoT de monitoramento de movimentações em estoque

O projeto foi desenvolvido para monitorar movimentações em um ambiente de estoque utilizando Internet das Coisas (IoT). 
O sistema detecta movimentos por meio de um sensor PIR conectado a um ESP32, registra os eventos em um banco de dados e apresenta as informações em um dashboard web.

## Tecnologias utilizadas

- ESP32
- Sensor PIR
- MicroPython
- Wokwi
- Supabase
- HTML, CSS e JavaScript
- Cloudflare

## Arquitetura

O sistema funciona a partir da seguinte estrutura:

1. O sensor PIR detecta uma movimentação.
2. O ESP32 processa o sinal e registra o evento.
3. Os dados são enviados via Wi-Fi para uma API do Supabase.
4. O Supabase armazena os registros no banco de dados.
5. O dashboard consulta os dados e exibe as movimentações.

## Estrutura do banco de dados

A tabela `movimentacoes_estoque` armazena os registros do sistema.

| Campo | Descrição |
|---|---|
| id | Identificador do registro |
| dispositivo | Identificação do dispositivo ESP32 |
| evento | Tipo de evento detectado |
| total_movimentos | Total de movimentos registrados |
| created_at | Data e hora do registro |

## Como reproduzir o projeto

### 1. Circuito
Acesse o projeto no Wokwi e monte o circuito com ESP32, sensor PIR, dois LEDs e resistores de 220 ohms, seguindo as conexões disponibilizadas no arquivo `diagram.json`.

### 2. ESP32
Utilize o MicroPython no ESP32. Configure a conexão Wi-Fi e a comunicação com a API do Supabase, utilizando o token de autenticação configurado no ambiente.

### 3. Banco de dados
Crie a tabela `movimentacoes_estoque` no Supabase utilizando o script SQL disponibilizado neste repositório.

### 4. Dashboard
Abra o dashboard pelo link abaixo para visualizar o total de movimentações, a última movimentação e o histórico de registros.

## Dashboard online

https://dashboard.danileborges11.workers.dev

## Repositório

https://github.com/DanielebBorges/Monitoramento-estoque


