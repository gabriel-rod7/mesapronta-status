# Família Pronta — status

Arquivos que os sistemas consultam pela internet para saber se existe versão nova e se alguma licença foi cancelada. Um arquivo por produto:

| Produto | Arquivo | Códigos dos clientes |
|---|---|---|
| MesaPronta | `mesapronta.json` | `MP-XXXX-XXXX-XXXX` |
| BelezaPronta | `belezapronta.json` | `BP-XXXX-XXXX-XXXX` |
| OficinaPronta | `oficinapronta.json` | `OP-XXXX-XXXX-XXXX` |
| PetPronto | `petpronto.json` | `PP-XXXX-XXXX-XXXX` |

- Para editar: clique no arquivo do produto, depois no lápis (Edit), altere e clique em "Commit changes".
- As mudanças chegam aos sistemas instalados na próxima verificação (ao abrir e a cada 6 horas, com internet).

Campos:
- `versao_atual` — versão mais nova disponível (ex.: `3.2.0`).
- `download` — link **https** para baixar o `.exe` novo.
- `mensagem` — o que mudou (aparece para o cliente).
- `revogados` — lista de códigos de computador cancelados, ex.: `{ "codigo": "BP-AAAA-BBBB-CCCC", "motivo": "Compra cancelada" }`.
