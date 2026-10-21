# MesaPronta — status

Arquivo que o sistema MesaPronta consulta pela internet para saber se existe versão nova e se alguma licença foi cancelada.

- Arquivo: `mesapronta.json`
- Para editar: clique no arquivo, depois no lápis (Edit), altere e clique em "Commit changes".
- As mudanças chegam aos sistemas instalados na próxima verificação (ao abrir e a cada 6 horas, com internet).

Campos:
- `versao_atual` — versão mais nova disponível (ex.: `3.2.0`).
- `download` — link **https** para baixar o `MesaPronta.exe` novo.
- `mensagem` — o que mudou (aparece para o cliente).
- `revogados` — lista de códigos de computador cancelados, ex.: `{ "codigo": "MP-AAAA-BBBB-CCCC", "motivo": "Compra cancelada" }`.
