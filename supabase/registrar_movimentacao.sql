CREATE TABLE movimentacoes_estoque (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispositivo VARCHAR(50) NOT NULL,
    evento VARCHAR(50) NOT NULL,
    total_movimentos INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
