# Entrar e cadastrar com Google — servidor (09/11/2026)

Pacote para a versão online (`/srv/pronta/app/familia`). Junto com o site **v14.4** (`site-v14.4/`).
Ainda **não aplicado** e **não publicado**. Passo a passo em `PUBLICAR.md`.

## Plano (como funciona)
1. **Site (Google Identity Services):** o botão oficial "Continuar com Google" aparece no passo 1 e no passo 2 do `/teste-gratis`
   e na página nova `/entrar`. O Google devolve ao navegador um **token ID** (JWT assinado pelo Google com e-mail, nome, `email_verified`).
   O site manda esse token para `POST https://app.mesapronta.net/api/site/google`. Sem Client ID no `entrar-google.js`, nada do Google aparece (site igual a hoje).
2. **Servidor valida o token** (`nuvem/google.js`, sem dependências): assinatura RS256 com as chaves públicas do Google
   (`googleapis.com/oauth2/v3/certs`, com cache), emissor `accounts.google.com`, `aud` = nosso Client ID (`GOOGLE_CLIENT_ID` no `/etc/pronta-nuvem.env`),
   validade e **e-mail confirmado**. Nada de segredo: o Client ID é público e a "chave secreta do cliente" do Google **não é usada**.
3. **Conta existente (um e-mail = uma conta, regra da 3.9.2):** se o e-mail do Google já tem conta (online ou do computador), o servidor
   devolve o mesmo link de entrada de uso único do cadastro (`<loja>.mesapronta.net/entrar?t=…`, 10 min): libera o aparelho e entra como gerente.
   Conta do computador: o site avisa para abrir o programa e oferece "Abrir pela internet". Conta suspensa: 403.
4. **Conta nova:** o servidor devolve um **bilhete** de 30 min (HMAC com segredo próprio em `/srv/pronta/dados/google-segredo.txt`) com o e-mail confirmado.
   O site segue o formulário de sempre, só que sem pedir e-mail (e sem senha na forma Online). No envio, `/api/site/cadastro` recebe
   `google: <bilhete>`; o servidor troca o bilhete pelo e-mail do Google e segue **todas as validações de antes**.
5. **WhatsApp continua obrigatório:** o passo 1 (nome + WhatsApp) não muda; o Google só preenche o nome (se estiver vazio) e o e-mail.
   CPF/CNPJ, estabelecimento, endereço e consentimento também continuam. O aviso "Começou o cadastro" passa a levar o e-mail do Google.
6. **Senha:** Online com Google → o servidor cria uma senha aleatória (a pessoa entra sempre pelo Google em `mesapronta.net/entrar`;
   se quiser senha, o suporte cria em /admin). No computador → o site pede a senha do programa (o programa entra com e-mail + senha).
7. **Instagram/Facebook (navegador interno):** o Google bloqueia o login ali (`disallowed_useragent`). Nesses navegadores o botão **não é carregado**;
   o formulário normal fica como está. No Android aparece "Usar minha conta Google (abre no Chrome)" (link `intent://` que leva o utm, o nome e o WhatsApp
   já digitados); no iPhone, uma dica curta "toque em ••• › Abrir no navegador".
8. **Marcação:** a conta criada pelo Google leva `utm.cadastro = "google"` (aparece no /admin junto do utm). Eventos novos no pixel/Clarity:
   `CliqueGoogle`, `CadastroGoogle`, `EntrouGoogle`, `CliqueGoogleEntrar`, `GoogleAbrirChrome`.

## O que o `aplicar.js` muda no servidor
- Novo `nuvem/google.js`.
- `nuvem/orquestrador.js` (3 remendos, cada um precisa achar o trecho exatamente 1 vez, senão para sem mexer):
  A) `require('./google')` depois do `require('node:sqlite')`;
  B) rota `/api/site/google` logo antes da rota `/api/site/cadastro` em `rotasApp`;
  C) em `cadastroSite`, logo depois da linha do `botcheck`: troca o bilhete pelo e-mail (bilhete inválido/vencido → 400 `campo: email`).
  Opcionais (se o texto existir igual): "Criou a conta com o Google? Entre com o Google" na tela de liberar aparelho e na tela Entrar do app.
- Confere que existem `criarEntradaUnica`, `bloqueado`, `falhou`, `ipDe`, `lerJson`, `json`, `ESQ`, `PORTA_URL`, `db`.
- Testa numa cópia: sobe o orquestrador remendado numa pasta temporária com um "Google de mentira" e confere 16 casos (CORS; token mal formado,
  assinado por outra chave, de outro Client ID, de outro emissor, vencido e com e-mail não confirmado recusados; bilhete adulterado recusado;
  cadastro com Google cria a conta; conta existente entra; link só vale uma vez; cadastro com e-mail e senha igual a antes; telas abrem).
- `--client-id <ID>` grava `GOOGLE_CLIENT_ID=<ID>` no `/etc/pronta-nuvem.env` (cópia em `.antes-google`; confere que o serviço lê esse arquivo).
- Backup em `/srv/pronta/backups/antes-google-<data>.tgz`, pasta anterior em `familia.antigo`; se o serviço não voltar, desfaz sozinho (código e env).

## Testado aqui (09/11/2026)
- Ensaio do `aplicar.js` sobre o fonte legível 3.9.0 (`legado/familia-3.9.0`): remendos ok (inclusive os 2 opcionais), 16 verificações ok.
  Controle: com o `google.js` sabotado (sem conferir o Client ID) o ensaio **para**. Rodar de novo sobre a cópia remendada: "já está com o Google".
- Site v14.4 de ponta a ponta (Playwright, site real + orquestrador remendado + Google de mentira): **40 verificações ok** — cadastro novo pelo
  passo 1 e pelo passo 2, WhatsApp obrigatório, sem senha no Online, senha do programa no Computador, conta existente entra (no /teste-gratis e no /entrar),
  /entrar sem conta → "Criar minha conta com este Google", Instagram iPhone (sem Google, dica), Instagram Android (link do Chrome com utm/nome/WhatsApp),
  volta no Chrome com nome e WhatsApp, sem Client ID igual a antes, 390 px sem rolagem lateral, sem erro de script.
- **Não testado:** o botão real do Google (precisa do Client ID) e o código que está no ar (o legível de lá é mais novo que o 3.9.0; o ensaio na VPS confere).
