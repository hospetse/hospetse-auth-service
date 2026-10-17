# Hospetse — Auth Server

Serviço de autenticação do Hospetse, separado do back-end principal e com banco próprio.

Responsável por confirmar o e-mail com PIN no primeiro cadastro, criar a identidade, proteger a senha e emitir os tokens (JWT). O back-end principal nunca recebe nem armazena senha.

Work item: PBI #244 (HSP-PBI-078). Arquitetura e contratos: Task #249 (HSP-PBI-078-TSK-01). Base do projeto e banco: Task #250 (HSP-PBI-078-TSK-02). Solicitação de PIN e envio de e-mail: Task #251 (HSP-PBI-078-TSK-03).

## Estado atual

- Implementado: servidor Express, conexão com o banco via Prisma, as três tabelas (migration `init`), rota `GET /health`, rota `POST /api/v1/auth/request-pin` (com interface de envio de e-mail) e testes automatizados das duas rotas.
- Ainda não implementado: `register`, `refresh` e a comunicação com o back-end, descritos em [Rotas](#rotas). Elas são o contrato que as próximas Tasks implementam.
- O envio de e-mail ainda não tem provedor real: em desenvolvimento o e-mail aparece no terminal (ver [Envio de e-mail](#envio-de-e-mail)).

## Stack

- Node.js 20.12+ (usa `process.loadEnvFile`), ES Modules
- Express 5
- Prisma 6.19.0 (versão fixa, igual ao back-end) + PostgreSQL
- Testes: `node:test` + axios
- Lint: ESLint (mesma configuração do back-end)

## Primeira execução

Pré-requisito: acesso à `DATABASE_URL` do banco do Auth Server (instância própria no Railway). A URL fica só no `.env`.

```bash
npm install
cp .env.example .env          # preencher DATABASE_URL, PORT e PIN_HMAC_SECRET
npx prisma migrate deploy     # aplica as migrations no banco
npx prisma generate           # gera o Prisma Client
npm run dev
```

Conferir: `GET http://localhost:<PORT>/health` deve responder `200`.

### Variáveis de ambiente

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | URL de conexão do PostgreSQL do Auth Server |
| `PORT` | Porta do servidor |
| `PIN_HMAC_SECRET` | Chave secreta do HMAC-SHA256 usado no hash do PIN. Trocar a chave invalida os PINs abertos |

Para gerar um `PIN_HMAC_SECRET`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

O `.env` não é versionado. Se ele não existir (deploy, CI), o `index.js` segue sem quebrar e usa as variáveis já definidas no ambiente; qualquer outro erro ao ler o arquivo interrompe a inicialização.

### Scripts

| Comando | O que faz |
| --- | --- |
| `npm start` | Sobe o servidor (`node index.js`) |
| `npm run dev` | Sobe com nodemon (reinicia ao salvar) |
| `npm test` | Roda os testes (`node --test`) |
| `npm run lint` | Roda o ESLint |

### Estrutura

```text
index.js                 carrega o .env, escolhe as implementações e sobe o servidor
src/app.js               createApp({ emailSender }): monta o app Express e as rotas
src/lib/prisma.js        instância única do PrismaClient
src/lib/app-error.js     AppError: erro de regra de negócio com status HTTP
src/email-verification/
  email-verification.controller.js   valida a entrada (Joi) e traduz o resultado em HTTP
  email-verification.service.js      regras do request-pin: 409, 429, transação e envio
  email-sender.interface.js          contrato EmailSender: send({ to, subject, text })
  console.email-sender.js            implementação de dev (mostra o e-mail no terminal)
  fake.email-sender.js               implementação de testes (guarda as mensagens)
src/user-auth/
  user-auth.controller.js            valida o payload do register (Joi)
  user-auth.service.js               regras do register: PIN, tentativas, hash da senha, transação
prisma/schema.prisma     modelos do banco
prisma/migrations/       histórico de migrations (versionado)
prisma.config.ts         configuração do Prisma CLI
test/app.test.js         testes do /health
test/request-pin.test.js testes do request-pin
```

### Banco e migrations

O banco é exclusivo do Auth Server, então em desenvolvimento dá para criar migrations com `npx prisma migrate dev --name <nome>` depois de alterar o `schema.prisma`. Antes, confirmar que a `DATABASE_URL` aponta para o banco do Auth, e não para o do back-end. Em deploy, usar só `npx prisma migrate deploy`.

Para checar a conexão pelo terminal:

```bash
echo "SELECT 1;" | npx prisma db execute --stdin --schema prisma/schema.prisma
```

### Health check

`GET /health` executa um `SELECT` no banco:

| Status | Caso |
| --- | --- |
| `200` | Servidor e banco respondendo |
| `503` | Servidor de pé, banco indisponível (detalhe do erro só no log) |

### Envio de e-mail

O service não conhece o provedor de e-mail. Ele depende só do contrato `EmailSender` (`email-sender.interface.js`): um objeto com `send({ to, subject, text })` que devolve uma Promise e lança erro se o envio falhar. A classe base lança erro se a implementação não sobrescrever o `send`.

| Implementação | Uso |
| --- | --- |
| `ConsoleEmailSender` | Desenvolvimento: mostra o e-mail (com o PIN) no terminal. Nunca usar em produção |
| `FakeEmailSender` | Testes: guarda as mensagens em `sent`, para o teste ler o PIN |

O sender é injetado de cima para baixo: `index.js` → `createApp({ emailSender })` → `createRequestPinController(emailSender)` → `requestPinService(email, emailSender)`. O `index.js` é o único lugar que escolhe a implementação (composition root). Para ligar um provedor real, basta criar uma classe que estende `EmailSender` e passá-la no `index.js`, sem mudar o service.

### Erros

Regras de negócio lançam `AppError(message, statusCode)` no service. O controller responde com o status do `AppError`; qualquer outro erro vira `500` genérico, e só a mensagem vai para o log.

### Testes

Os testes sobem o app numa porta aleatória (`app.listen(0)`) com o `FakeEmailSender` e precisam do `.env` válido, porque usam o banco.

- `test/app.test.js`: chama o `/health` e confere status e corpo. Como o health consulta o banco, também prova a conexão.
- `test/request-pin.test.js`: cobre `400`, `201` (com só o hash no banco), `429`, invalidação do PIN anterior, rollback com `500` quando o envio falha, `409` e a retentativa com `pending_provisioning`. O teste de rollback sobe um segundo app com um sender que sempre falha.

O banco de desenvolvimento é compartilhado. Por isso os testes usam e-mails `teste-auth-*@example.com` e apagam o que criaram (`email_verification` e `user_auth`) no `after()`, que também fecha os servidores e a conexão do Prisma.

## Visão geral

```text
Front-end ──(rotas públicas)──> Auth Server ──(rota interna)──> Back-end principal
                                    │                                 │
                               Postgres (Auth)                  Postgres (back-end)
```

- **Auth Server:** e-mail, senha (hash), PIN e refresh tokens. Assina os JWT com a chave privada (RS256).
- **Back-end principal:** USER, TUTOR e o resto do domínio. Valida os JWT com a chave pública e identifica o USER pelo `sub` (`auth_user_id`).
- O JWT só é emitido depois que o back-end confirma a criação do USER.
- O Auth Server não guarda dados de perfil. O nome e o celular são informados depois, na conclusão do perfil do Tutor, direto no back-end.

### Fluxo de cadastro

1. **Tela de e-mail + senha:** o front chama `request-pin` e guarda a senha em memória. O usuário recebe o PIN por e-mail.
2. **Tela de PIN:** o front chama `register` com `challengeId`, PIN e a senha guardada. Se o PIN estiver errado, o erro aparece nesta tela.
3. O Auth Server consome o PIN, cria a `user_auth` (`pending_provisioning`) e chama a rota interna do back-end, que cria o USER (`account_type = tutor`).
4. Com a confirmação do back-end, o Auth marca a `user_auth` como `active` e devolve access token + refresh token.
5. **Tela logada:** a conclusão do perfil (nome, celular) é obrigatória para usar o app e fica no back-end (outra PBI). Até lá, o usuário é um USER sem TUTOR ("perfil incompleto").

## Rotas

Padrão (#56): prefixo `/api/v1/`, envelope de resposta e erro padronizado. Ações usam `POST` com o verbo no caminho.

### Status HTTP usados

| Código | Quando |
| --- | --- |
| `200 OK` | Deu certo e devolve um resultado |
| `201 Created` | Criou algo novo |
| `400 Bad Request` | Payload inválido (validação Joi) |
| `401 Unauthorized` | Credencial ou token inválido |
| `404 Not Found` | Recurso não existe |
| `409 Conflict` | Conflito, ex.: e-mail já cadastrado |
| `410 Gone` | O recurso existia, mas não vale mais (PIN expirado, consumido ou invalidado) |
| `429 Too Many Requests` | Excedeu tentativas ou reenvios |
| `500 Internal Server Error` | Erro inesperado |
| `503 Service Unavailable` | Dependência (back-end) indisponível |

### `POST /api/v1/auth/request-pin`

Gera um PIN, envia por e-mail e cria uma `email_verification`.

Request:

```json
{ "email": "tutor@exemplo.com" }
```

| Status | Caso | Body |
| --- | --- | --- |
| `201` | PIN enviado | `{ "challengeId": "uuid" }` |
| `400` | E-mail inválido | erro padrão |
| `409` | E-mail já cadastrado em `user_auth` com status `active` | erro padrão (front redireciona para o login) |
| `429` | Pediu reenvio antes do intervalo mínimo | erro padrão |
| `500` | Falha inesperada, inclusive no envio do e-mail | erro padrão |

- E-mail com `user_auth` em `pending_provisioning` não é duplicado: pode pedir PIN novo (ver [Retentativa](#retentativa)).
- Gerar um PIN novo invalida o anterior do mesmo e-mail (`invalidated_at`).
- Invalidar os PINs abertos, criar o novo e enviar o e-mail acontecem na mesma transação, com o envio por último. Se o envio falhar, nada fica gravado.
- Valores atuais: PIN de 6 dígitos, expiração de 15 min e intervalo de reenvio de 60 s (fixos no código por enquanto).
- O `challengeId` não aparece na tela; o front guarda até o `register`.

### `POST /api/v1/auth/register`

Valida o PIN, cria a `user_auth`, chama a rota interna do back-end e emite os tokens.

Request:

```json
{
  "challengeId": "uuid",
  "pin": "012345",
  "password": "...",
  "acceptedTerms": true,
  "termsVersion": "2026-10-01"
}
```

O e-mail não vem no payload: ele vem da `email_verification`. O PIN é string de 6 dígitos (preserva zeros à esquerda). `acceptedTerms` só aceita `true`. `termsVersion` identifica a versão dos termos aceita (até 64 caracteres). A confirmação de senha fica só no front.

| Status | Caso | Body |
| --- | --- | --- |
| `201` | Conta criada e USER confirmado no back-end | access token + refresh token |
| `400` | Payload inválido ou termos não aceitos | erro padrão |
| `401` | PIN errado (incrementa `attempts`) | erro padrão |
| `404` | `challengeId` não existe | erro padrão |
| `409` | E-mail já cadastrado com `user_auth` `active` (inclui corrida: `UNIQUE` / Prisma P2002) | erro padrão |
| `410` | PIN expirado, invalidado ou consumido (exceto na retentativa) | erro padrão |
| `429` | Limite de tentativas atingido | erro padrão |
| `503` | Back-end não confirmou a criação do USER | erro padrão |

Ordem das validações: challenge existe (`404`) → não consumido, invalidado nem expirado (`410`) → menos de 5 tentativas (`429`) → PIN confere (`401` e `attempts + 1`). Depois, numa transação: consome o challenge (update condicional) e cria a `user_auth`. Se o e-mail já tem `user_auth` em `pending_provisioning`, a linha é reaproveitada (mesmo `auth_user_id`) e recebe a senha e o aceite novos.

**Etapa atual (#252):** o `register` ainda não chama o back-end nem emite tokens. Ele responde `201 { "authUserId": "uuid" }` e a `user_auth` fica em `pending_provisioning`. O back-end entra na #253 (junto com a exceção da retentativa para challenge já consumido) e os tokens na #254, quando a resposta passa a ser a da tabela acima.

### `POST /api/v1/auth/refresh`

Troca um refresh token válido por um novo access token.

Request: refresh token (mobile no body; web no cookie httpOnly, conforme ADR-005).

| Status | Caso | Body |
| --- | --- | --- |
| `200` | Token válido | access token (e novo refresh, se houver rotação) |
| `401` | Refresh inválido, expirado ou revogado | erro padrão |

### `POST /api/v1/auth/login` (fora da #244)

Fica para outra PBI. Sucesso: `200` + tokens. Credencial inválida: `401`.

### Rota interna (no back-end principal): `PUT /api/v1/internal/users/{authUserId}`

Chamada só pelo Auth Server, depois de criar a `user_auth`. Não é usada pelo front.

`PUT` porque é idempotente: chamar de novo após um timeout não cria um segundo USER. O `authUserId` vai no caminho porque é o Auth que define o id.

Request:

```json
{ "email": "tutor@exemplo.com" }
```

Autenticação: token de serviço (JWT curto assinado pelo Auth com a chave privada RS256, `aud: "hospetse-backend-internal"`). O back-end valida com a chave pública que já tem. A claim `aud` impede o uso de um token de usuário nesta rota.

| Status | Caso |
| --- | --- |
| `201` | USER criado agora (`account_type = tutor`) |
| `200` | USER já existia para esse `authUserId` (retentativa) |
| `401` | Token de serviço ausente ou inválido |
| `409` | E-mail já usado por outro USER |

## Tratamento de falhas no `register`

O PIN é consumido e a `user_auth` é criada (`pending_provisioning`) antes da chamada ao back-end. Se a chamada falhar, essa linha continua lá.

| Resposta do back-end | Auth Server faz | Front recebe |
| --- | --- | --- |
| `201` ou `200` | Marca `active`, preenche `provisioned_at`, emite tokens | `201` + tokens |
| `409` | Mantém `pending_provisioning` e registra o erro | `409` |
| `401` | Erro de configuração; registra o erro | `503` |
| Timeout ou `5xx` | Retenta dentro da requisição; se todas falharem, mantém `pending_provisioning` | `503` |

### Retentativa

Duas camadas:

1. **Auth retenta dentro da requisição:** poucas tentativas do `PUT`, com espera curta entre elas, antes de devolver `503`. Seguro porque o `PUT` é idempotente. Cobre falhas rápidas (deploy, oscilação de rede).
2. **Front oferece "tentar de novo":** se ainda vier `503`, o front reenvia o `register` com o mesmo `challengeId`, PIN e senha.

Regra do `register` para a retentativa: se a `user_auth` do e-mail está em `pending_provisioning`, o `register` aceita o mesmo `challengeId` + PIN de novo, desde que o PIN não tenha expirado. Nesse caso:

- não cria outra `user_auth`: reaproveita a linha existente (mesmo `auth_user_id`, mantém o vínculo caso o back-end já tenha criado o USER);
- atualiza a senha com a enviada;
- chama o `PUT` do back-end de novo; com `201`/`200`, marca `active` e emite os tokens.

Se o PIN expirar antes de dar certo, o usuário pede um PIN novo pelo `request-pin` (permitido porque o status é `pending_provisioning`) e refaz o fluxo, caindo na mesma regra.

## Modelo de dados

Banco PostgreSQL próprio, acessado via Prisma. Definido em `prisma/schema.prisma` e criado pela migration `init`. Três tabelas: `email_verification` não tem FK, porque a verificação acontece antes da identidade existir e o vínculo é o e-mail; `refresh_token` pertence a uma `user_auth`.

### `email_verification`

Confirma que quem está se cadastrando é dono do e-mail. Cada linha é um PIN enviado (o `id` é o `challengeId` devolvido ao cliente).

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | UUID, PK | `challengeId`, gerado pelo banco |
| `email` | VARCHAR(255) | Normalizado (trim + minúsculas) |
| `pin_hash` | VARCHAR(255) | HMAC-SHA256 do PIN com chave secreta. O PIN original nunca é salvo |
| `expires_at` | TIMESTAMPTZ | PIN expirado é rejeitado |
| `attempts` | INT, default 0 | Tentativas erradas; acima do limite, o PIN é bloqueado |
| `consumed_at` | TIMESTAMPTZ, nulo | Preenchido quando o PIN é usado; impede reutilização |
| `invalidated_at` | TIMESTAMPTZ, nulo | Preenchido quando um novo PIN é solicitado para o mesmo e-mail |
| `created_at` | TIMESTAMPTZ | Também controla o intervalo mínimo entre reenvios |

Índices: `(email, created_at)` para localizar a verificação mais recente do e-mail; `(expires_at)` para limpeza das vencidas.

### `user_auth`

Identidade autenticável, usada no cadastro e no login.

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | UUID, PK | `auth_user_id`. Vai no `sub` do JWT e é enviado ao back-end principal |
| `email` | VARCHAR(255), UNIQUE | Normalizado. O índice único impede e-mail duplicado |
| `password_hash` | VARCHAR(255) | Hash seguro da senha. A senha original nunca é salva |
| `status` | ENUM | `pending_provisioning` (USER ainda não confirmado pelo back-end) ou `active` |
| `provisioned_at` | TIMESTAMPTZ, nulo | Quando o back-end confirmou a criação do USER |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `terms_accepted_at` | TIMESTAMPTZ, default `now()` | Quando os termos foram aceitos (hora do servidor, na criação da conta) |
| `terms_version` | VARCHAR(64) | Versão dos termos aceita, enviada no `register` |

O Auth Server não guarda referência ao USER: o back-end principal guarda o `auth_user_id` e localiza o USER pelo `sub` do JWT.

O cadastro recebe só `challengeId`, PIN, senha, aceite e versão dos termos; o e-mail vem da `email_verification`. Ao back-end principal são enviados apenas `auth_user_id` e e-mail confirmado.

### `refresh_token`

Permite renovar o access token (JWT) sem pedir a senha de novo e revogar o acesso.

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | UUID, PK | Gerado pelo banco |
| `user_auth_id` | UUID, FK → `user_auth.id` | Dono do token |
| `token_hash` | VARCHAR(255), UNIQUE | Hash do refresh token. O token original nunca é salvo |
| `expires_at` | TIMESTAMPTZ | Refresh token expirado é rejeitado |
| `revoked_at` | TIMESTAMPTZ, nulo | Preenchido na revogação (ex.: logout); token revogado é rejeitado |
| `created_at` | TIMESTAMPTZ | |

Índices: `UNIQUE (token_hash)` para localizar o token na renovação; `(user_auth_id)` para revogar todos os tokens de um usuário.

### Regras importantes

- Consumir o PIN e criar a `user_auth` acontecem na mesma transação.
- O PIN é consumido com update condicional (`WHERE consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`), para que duas requisições simultâneas não usem o mesmo PIN. A exceção é a [retentativa](#retentativa) com `user_auth` em `pending_provisioning`.
- PIN, senha e segredos nunca aparecem em logs.

## Decisões técnicas

- **Banco:** instância PostgreSQL própria no Railway, separada da do back-end (isolamento do microserviço).
- **ORM:** Prisma 6.19.0 com versão exata (sem `^`), gerador `prisma-client-js`, igual ao back-end. Atualizar para a 7 só junto com o back-end, numa Task própria.
- **Hash da senha:** Argon2id, pacote `argon2` (Task #54).
- **Hash do PIN:** HMAC-SHA256 com `PIN_HMAC_SECRET`. O PIN tem só 6 dígitos, então um hash sem chave seria quebrado testando as 1 milhão de combinações; com a chave, quem tiver só o banco não consegue.
- **Limite de tentativas do PIN:** 5. Na 6ª, o `register` responde `429` antes de comparar o PIN.
- **Aceite dos termos:** o payload traz `acceptedTerms: true` e `termsVersion`; o servidor grava a versão e a hora (`now()`) na mesma transação que cria a `user_auth`. Não existe conta sem aceite nem aceite sem conta.
- **Confirmação de senha:** só no front. Ela evita erro de digitação, mas não traz segurança na API.
- **Envio de e-mail:** interface `EmailSender` injetada a partir do `index.js`, para trocar o provedor (ou usar um fake nos testes) sem mudar o caso de uso.
- **Assinatura do JWT:** RS256. A chave privada fica só no Auth Server e assina os tokens; o back-end principal recebe só a chave pública e apenas valida. Nenhuma das chaves é versionada.
- **Tokens:** access token curto + refresh token (Task #256). Armazenamento por plataforma conforme ADR-005: mobile em secure storage; web com refresh em cookie httpOnly/Secure/SameSite e access token em memória.
- **Comunicação Auth → back-end:** rota interna `PUT` idempotente, autenticada por token de serviço RS256 com `aud` próprio.

### Pendente (TBD)

- Regras da senha: tamanho mínimo, máximo e composição (decisão da PO na #252). Por enquanto a API só exige a senha.
- Mover tamanho do PIN (6), expiração (15 min) e intervalo de reenvio (60 s) do código para variáveis de ambiente.
- Provedor real de e-mail e a escolha da implementação por ambiente no `index.js`.
- Expiração do access token (~15 min, conforme #56) e do refresh token.
- Se o refresh token é rotacionado (trocado por um novo) a cada renovação.
- Se a checagem de e-mail duplicado fica no `request-pin` (como acima) ou numa rota separada. Em ambos os casos, precisa de rate limit.
- Confirmação da PO de que a `passwordConfirmation` fica só no front (recomendação técnica registrada na #252).
- Se o `termsVersion` aceito precisa ser a versão vigente (ex.: env `TERMS_VERSION`) ou qualquer versão.
- Formato exato do erro padrão (#56) e lista de códigos de erro.
- Claims do JWT de usuário (`sub`, `iss`, `aud`, `iat`, `exp`).
- Timeout por tentativa e número de retentativas do Auth na chamada da rota interna (manter baixo: o usuário espera a resposta).
- User agent / dados do dispositivo na sessão (depois).
