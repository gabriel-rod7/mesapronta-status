# MesaPronta 3.12.0 no servidor (versão online)

O programa do computador (`build/MesaPronta-3.12.0.exe`) já tem tudo. A versão online roda o código legível da família
na VPS (`/srv/pronta/app/familia`), que não está nesta pasta, então aqui vão as duas partes para aplicar lá:

## 1. Telas (`publico.tgz`)
Arquivos de `public/` que mudaram em relação à 3.11.0 (desempacotar por cima de `familia/.../public`):
`index.html`, `js/caixa.js`, `js/comum.js`, `js/guia.js`, `js/online.js`, `cardapio-online.html`, `css/app.css` e o novo `css/ux312.css`.
Os arquivos são os mesmos do programa do computador (a família compartilha o `public/`).

## 2. Servidor (portar para o fonte legível)
As trocas abaixo estão em `ferramentas/remendo-3.12.py` (sobre o minificado); no fonte legível entram nos módulos correspondentes.

1. **Versão**: `3.11.0` → `3.12.0`.
2. **Configurações novas em `CONFIG_PADRAO`** (para o `PUT /api/config` aceitar): `toque_direto: "1"`, `balcao_receber_junto: "1"`, `balcao_f3_direto: "1"`, `online_divulgado: "0"`. Padrão de `obs_rapidas_gerais` vira `"Para viagem;Sem talheres"`.
3. **Exemplos (seed) de um sistema novo**: Lanches `"Sem cebola;Sem tomate;Sem maionese;Bem passado;Mal passado"`, Pratos ganha `;Bem passado`, Bebidas ganha `;Com canudo`.
4. **Coluna nova** `itens.sugestao INTEGER NOT NULL DEFAULT 0` (migração `_e("itens","sugestao",...)`).
5. **Inserir itens** (função que grava os itens do pedido, a do `INSERT INTO itens (... origem, profissional_id, entregue_em)`): depois do insert, `if (item.sugestao) UPDATE itens SET sugestao = 1 WHERE id = ?`.
6. **Pedido do cardápio online** (`criarPedidoOnline`, mapeamento dos itens da sacola): levar `sugestao: Ce.sugestao ? 1 : 0` junto de `produto_id, tamanho, qtd, obs, adicionais, opcoes`.
7. **`GET /api/online/resumo`**: acrescentar
   - `total`: `SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM pedidos WHERE origem = 'online' AND status = 'fechado'`
   - `sugestoes_mes`: `SELECT COUNT(*) n, COALESCE(SUM((i.preco_unit + i.adicionais_total) * i.qtd),0) t FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE i.sugestao = 1 AND i.cancelado = 0 AND p.status != 'cancelado' AND substr(p.aberto_em,1,7) = <mês atual>`
8. **Relatórios** (função que monta `/api/relatorios`, retorno): acrescentar
   - `online`: `SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM pedidos p WHERE p.origem = 'online' AND <mesmo filtro de período/fechado>`
   - `sugestoes`: `SELECT COUNT(*) n, COALESCE(SUM((i.preco_unit + i.adicionais_total) * i.qtd),0) t FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE i.sugestao = 1 AND i.cancelado = 0 AND <mesmo filtro>`
9. **Rota nova** `GET /api/clientes/parados?dias=30` (perfil caixa; dias entre 7 e 365):
   ```sql
   SELECT c.id, c.nome, c.telefone, c.pedidos, c.ultimo_pedido_em,
     (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE cliente_id = c.id AND status = 'fechado') total,
     (SELECT i.nome FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE p.cliente_id = c.id AND i.cancelado = 0
        GROUP BY i.nome ORDER BY SUM(i.qtd) DESC LIMIT 1) favorito
   FROM clientes c
   WHERE COALESCE(c.telefone,'') != '' AND c.pedidos >= 1 AND c.ultimo_pedido_em IS NOT NULL AND c.ultimo_pedido_em < <agora - dias>
   ORDER BY total DESC LIMIT 60
   ```
10. **`GET /api/inicio`**: acrescentar `clientes_parados` = `SELECT COUNT(*) FROM clientes WHERE COALESCE(telefone,'') != '' AND pedidos >= 1 AND ultimo_pedido_em < <agora - 30 dias>`.
11. **Cardápio online ligado por padrão num sistema novo**: na partida (depois de montar o schema e as configs do delivery), se não existe a chave `online_ativo` em `config` e não há pedido `fechado` com `teste = 0`, gravar `online_ativo = '1'`. Lojas existentes não mudam.

12. (Só no programa do Windows, não se aplica à nuvem) abrir o exe de novo traz a janela do navegador já aberta em vez de abrir outra.

Depois: `node aplicar.js <commit>` como nas versões anteriores (o pacote da 3.9.15 serve de modelo), e publicar o programa com `vendedor/status.js versao 3.12.0`.
