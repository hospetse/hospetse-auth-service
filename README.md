# Hospetse — Auth Server

Serviço de autenticação do Hospetse, separado do back-end principal e com banco próprio.

Responsável por confirmar o e-mail com PIN no primeiro cadastro, criar a identidade, proteger a senha e emitir os tokens (JWT). O back-end principal nunca recebe nem armazena senha.

Work item: PBI #244 (HSP-PBI-078). Arquitetura e contratos: Task #249 (HSP-PBI-078-TSK-01). Base do projeto e banco: Task #250 (HSP-PBI-078-TSK-02). Solicitação de PIN e envio de e-mail: Task #251 (HSP-PBI-078-TSK-03). Emissão e validação do JWT: Task #254 (HSP-PBI-078-TSK-06).

## Estado atual

- Implementado: servidor Express, conexão com o banco via Prisma, as três tabelas (migrations `init` e `add_terms_to_user_auth`), rota `GET /health`, rota `POST /api/v1/auth/request-pin` (com interface de envio de e-mail), rota `POST /api/v1/auth/register` (cria a `user_auth` e o USER no back-end pela rota interna, com retry, e emite o access token JWT RS256 e o refresh token), rota `POST /api/v1/auth/refresh` (renova o access token com rotação do refresh token e detecção de reuso), rota `POST /api/v1/auth/login` (e-mail e senha, #296), contrato OpenAPI em `docs/openapi.yaml` e testes automatizados das rotas.
- Ainda não implementado: o logout (#297), descrito nas [pendências](#pendente-tbd).
- A rota interna `PUT /api/v1/internal/users/{authUserId}` existe no back-end (#261) e é autenticada pelo segredo compartilhado `INTERNAL_SERVICE_TOKEN` (#473). Sem o back-end no ar ou com o token diferente, o `register` responde `503` (ver [Provisionamento no back-end](#provisionamento-no-back-end)).
- O envio de e-mail ainda não tem provedor real: em desenvolvimento o e-mail aparece no terminal (ver [Envio de e-mail](#envio-de-e-mail)).

## Stack

- Node.js 22.9+ (usa a flag `--env-file-if-exists`), ES Modules
- Express 5
- `jose` para assinar e validar o JWT
- Prisma 6.19.0 (versão fixa, igual ao back-end) + PostgreSQL
- Testes: `node:test` + axios
- Lint: ESLint (mesma configuração do back-end)

## Primeira execução

Pré-requisito: acesso à `DATABASE_URL` do banco do Auth Server (instância própria no Railway). A URL fica só no `.env`.

```bash
npm install
cp .env.example .env          # preencher DATABASE_URL, PORT, PIN_HMAC_SECRET, BACKEND_URL, INTERNAL_SERVICE_TOKEN e as chaves JWT
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
| `BACKEND_URL` | URL base do back-end principal, usada na rota interna de criação do USER (ex.: `http://localhost:3000`) |
| `INTERNAL_SERVICE_TOKEN` | Segredo compartilhado com o back-end, enviado como `Authorization: Bearer` na rota interna. Mesmo valor nos dois serviços. Gerar com `openssl rand -hex 32` |
| `JWT_PRIVATE_KEY` | Chave privada RSA (PEM, PKCS#8) que assina os JWT. Existe só no Auth Server |
| `JWT_PUBLIC_KEY` | Chave pública RSA (PEM, SPKI) do mesmo par. É a única que vai para o back-end principal |

Para gerar um `PIN_HMAC_SECRET`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Para gerar o par de chaves do JWT (RSA 2048):

```bash
mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/private.pem   # privada
openssl pkey -in keys/private.pem -pubout -out keys/public.pem                        # pública, derivada da privada
chmod 600 keys/private.pem
printf '\nJWT_PRIVATE_KEY="%s"\nJWT_PUBLIC_KEY="%s"\n' "$(cat keys/private.pem)" "$(cat keys/public.pem)" >> .env
```

O PEM tem várias linhas: no `.env` ele fica entre aspas duplas, e o Node lê as quebras de linha corretamente. A pasta `keys/` está no `.gitignore`. Cada ambiente (desenvolvimento, produção) tem o seu par.

O `.env` não é versionado. Os scripts carregam o arquivo com `node --env-file-if-exists=.env`, antes de qualquer `import`: se ele não existir (deploy, CI), o Node segue e usa as variáveis já definidas no ambiente. Carregar antes dos imports é necessário porque o `src/lib/jwt.js` lê as chaves no momento em que é importado. Rodando `node` direto, passar a flag: `node --env-file=.env <arquivo>`.

Se as chaves estiverem faltando ou inválidas, o servidor não sobe (erro do `jose` no `importPKCS8`/`importSPKI`), em vez de falhar só no primeiro cadastro.

### Scripts

| Comando | O que faz |
| --- | --- |
| `npm start` | Sobe o servidor (`node --env-file-if-exists=.env index.js`) |
| `npm run dev` | Sobe com nodemon (reinicia ao salvar), com a mesma flag |
| `npm test` | Roda os testes (`node --env-file-if-exists=.env --test`) |
| `npm run lint` | Roda o ESLint |

### Estrutura

```text
index.js                 escolhe as implementações e sobe o servidor
src/app.js               createApp({ emailSender, userProvisioner }): monta o app Express e as rotas
src/lib/prisma.js        instância única do PrismaClient
src/lib/app-error.js     AppError: erro de regra de negócio com status HTTP
src/lib/jwt.js           carrega as chaves uma vez; signAccessToken e verifyAccessToken (jose, RS256)
src/email-verification/
  email-verification.controller.js   valida a entrada (Joi) e traduz o resultado em HTTP
  email-verification.service.js      regras do request-pin: 409, 429, transação e envio
  email-sender.interface.js          contrato EmailSender: send({ to, subject, text })
  console.email-sender.js            implementação de dev (mostra o e-mail no terminal)
  fake.email-sender.js               implementação de testes (guarda as mensagens)
src/user-auth/
  user-auth.controller.js            valida o payload do register e do login (Joi)
  user-auth.service.js               regras do register (PIN, tentativas, hash da senha, transação, provisionamento) e do login
src/refresh-token/
  refresh-token.controller.js        valida o payload do refresh (Joi)
  refresh-token.service.js           issueRefreshToken (gera e salva o hash) e refreshService (valida, rotaciona, detecta reuso)
src/user-provisioning/
  user-provisioner.interface.js      contrato UserProvisioner: provision({ authUserId, email, name })
  http.user-provisioner.js           implementação real (PUT na rota interna, timeout e retry)
  fake.user-provisioner.js           implementação de testes (guarda as chamadas, pode simular falha)
prisma/schema.prisma     modelos do banco
prisma/migrations/       histórico de migrations (versionado)
prisma.config.ts         configuração do Prisma CLI
docs/openapi.yaml        contrato OpenAPI 3.1 das rotas
test/app.test.js         testes do /health
test/request-pin.test.js testes do request-pin
test/register.test.js    testes do register
test/refresh-token.test.js  testes do refresh
test/login.test.js       testes do login
test/login-flow.test.js  sessão a partir do login, logs e o verify contra o hash falso
test/jwt.test.js         testes do access token: claims e o que o verify recusa (sem banco)
test/auth-flow.test.js   fluxo completo com o HttpUserProvisioner contra um back-end fake
test/http.user-provisioner.test.js  testes do HttpUserProvisioner contra um back-end fake
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

### Provisionamento no back-end

Depois de criar a `user_auth`, o `register` pede ao back-end principal para criar o USER e o TUTOR. O service depende só do contrato `UserProvisioner` (`user-provisioner.interface.js`): `provision({ authUserId, email, name })` resolve quando o back-end confirmou e lança `AppError` quando não.

| Implementação | Uso |
| --- | --- |
| `HttpUserProvisioner` | Faz o `PUT /api/v1/internal/users/{authUserId}` em `BACKEND_URL`, com timeout de 3 s e até 3 tentativas |
| `FakeUserProvisioner` | Testes: guarda as chamadas em `provisioned`; se `error` estiver definido, lança esse erro |

O `HttpUserProvisioner` traduz a resposta do back-end:

| Back-end | `provision` faz |
| --- | --- |
| `201` ou `200` | Resolve (USER criado agora ou já existia) |
| `409` | Lança `AppError` `409` na hora |
| `401` e outros `4xx` | Lança `AppError` `503` na hora (repetir daria o mesmo erro) |
| `5xx`, timeout ou back-end fora | Repete com espera de 200 ms e 400 ms; se as 3 falharem, lança `AppError` `503` |

O log da falha registra o `authUserId` e o status (ou o código do erro, como `ECONNABORTED`), nunca o e-mail ou o nome. O retry fica no adapter porque só ele sabe quais falhas de HTTP são passageiras; para o service, `provision` é uma chamada só.

A injeção segue o mesmo caminho do e-mail: `index.js` → `createApp({ userProvisioner })` → `createRegisterController(userProvisioner)` → `registerService(dados, userProvisioner)`.

### Erros

Regras de negócio lançam `AppError(message, statusCode)` no service. O controller responde com o status do `AppError`; qualquer outro erro vira `500` genérico, e só a mensagem vai para o log.

### Testes

Os testes sobem o app numa porta aleatória (`app.listen(0)`) com o `FakeEmailSender` e o `FakeUserProvisioner` e precisam do `.env` válido, porque usam o banco.

- `test/app.test.js`: chama o `/health` e confere status e corpo. Como o health consulta o banco, também prova a conexão.
- `test/request-pin.test.js`: cobre `400`, `201` (com só o hash no banco), `429`, invalidação do PIN anterior, rollback com `500` quando o envio falha, `409` e a retentativa com `pending_provisioning`. O teste de rollback sobe um segundo app com um sender que sempre falha.
- `test/register.test.js`: cobre `400` (payload e termos não aceitos), `404`, `401` contando a tentativa, `429` no limite (mesmo com o PIN certo), `410` para PIN expirado, invalidado e reutilizado, `201` com a `user_auth` `active`, um access token válido (conferido com o `verifyAccessToken`) com o `sub` da `user_auth`, `provisioned_at` preenchido, só o hash Argon2id no banco e o back-end recebendo exatamente `authUserId`, e-mail e nome, `409` com rollback do consumo do PIN, `409` do back-end mantendo a conta `pending`, e as duas retentativas depois de `503` (com PIN novo e com o mesmo challenge), reaproveitando o mesmo `authUserId` (que aparece no `sub` do token). O PIN vem do fluxo real: o teste chama o `request-pin` e lê o PIN no `FakeEmailSender`. Estados difíceis de reproduzir (5 tentativas, PIN vencido) são gravados direto no banco.
- `test/refresh-token.test.js`: cobre `400` (sem token e base64 comum), `401` para token não emitido, expirado e de conta que não está `active`, o `register` devolvendo o refresh token com só o SHA-256 no banco, `200` com access token válido (`sub` certo) e rotação (token novo, usado revogado), reuso (`401` e todos os tokens da conta revogados), duas renovações simultâneas (uma `200`, nunca dois tokens válidos) e o token fora dos logs. Para testar só o refresh, cria a `user_auth` direto no banco e emite com o `issueRefreshToken`; expirado é gravado direto no banco.
- `test/login.test.js`: cobre `400` (sem senha e e-mail inválido), `200` com access token válido (`sub` da `user_auth`) e refresh token que funciona no `refresh`, e-mail com maiúsculas e espaços normalizado, o mesmo `401` (corpo idêntico) para senha errada e e-mail inexistente, `403` sem token nem `refresh_token` para conta `pending_provisioning` com a senha certa e `401` para a mesma conta com a senha errada. Cria a `user_auth` direto no banco com o hash Argon2id da senha de teste.
- `test/login-flow.test.js` (#301): o refresh token do login renova e é rotacionado, dois logins são sessões independentes, reuso de um token rotacionado derruba todas as sessões da conta (e o dono loga de novo), senha, tokens e e-mail fora dos logs em logins com sucesso e com erro, e o `argon2.verify` rodando também para e-mail inexistente (o teste espiona a chamada: medir o tempo não funciona com o banco remoto, cuja latência esconde a diferença).
- `test/http.user-provisioner.test.js`: sobe um Express fake no lugar do back-end e cobre `201`, `200`, `409` e `401` sem repetir, `500` e timeout repetindo 3 vezes, falha passageira resolvida pelo retry e back-end fora do ar. Usa timeout e espera curtos no construtor para não demorar.
- `test/jwt.test.js`: confere que o access token tem só `sub`, `iss`, `aud`, `iat` e `exp` (15 min) com header `RS256`, e que o `verifyAccessToken` recusa payload adulterado, assinatura de outra chave, `alg: none`, `HS256` com a chave pública como segredo, token expirado e `iss`/`aud` diferentes. Não usa banco.
- `test/auth-flow.test.js`: integração com o `HttpUserProvisioner` de verdade, chamando por HTTP um Express fake que segue o contrato da rota interna (#259). Cobre o fluxo completo (PIN → cadastro → PUT no back-end com só e-mail e nome, com a conta ainda `pending` no momento da chamada → `201` → refresh), PIN errado sem chamar o back-end, back-end com erro e com timeout (`503`, conta `pending`, PIN consumido, nenhum token nem `refresh_token`) seguido da retentativa sem duplicar e com o mesmo `authUserId`, e um teste que captura o `console` durante o fluxo (com erros) e confere que PIN, senha, tokens, `PIN_HMAC_SECRET`, chave privada e e-mail não aparecem.

Os testes de falha do `register` também conferem que a resposta não traz `accessToken`.

O banco de desenvolvimento é compartilhado. Por isso os testes usam e-mails de teste (`teste-auth-*@example.com` no request-pin, `teste-register-*@example.com` no register, `teste-refresh-*@example.com` no refresh, `teste-login-*@example.com` no login, `teste-loginflow-*@example.com` na sessão a partir do login e `teste-flow-*@example.com` no fluxo completo) e apagam o que criaram (`email_verification` e `user_auth`) no `after()`, que também fecha os servidores e a conexão do Prisma. Os prefixos são separados porque o `node --test` roda os arquivos em paralelo: com o mesmo prefixo, a limpeza de um arquivo apagaria os dados do outro no meio do teste.

## Visão geral

```text
Front-end ──(rotas públicas)──> Auth Server ──(rota interna)──> Back-end principal
                                    │                                 │
                               Postgres (Auth)                  Postgres (back-end)
```

- **Auth Server:** e-mail, senha (hash), PIN e refresh tokens. Assina os JWT com a chave privada (RS256).
- **Back-end principal:** USER, TUTOR e o resto do domínio. Valida os JWT com a chave pública e identifica o USER pelo `sub` (`auth_user_id`).
- O JWT só é emitido depois que o back-end confirma a criação do USER.
- O Auth Server não guarda dados de perfil. O nome vem no `register` e é só repassado ao back-end, que cria o TUTOR com ele. O celular e o resto do perfil são informados depois, direto no back-end.

### Fluxo de cadastro

1. **Tela de e-mail + senha:** o front chama `request-pin` e guarda a senha em memória. O usuário recebe o PIN por e-mail.
2. **Tela de PIN:** o front chama `register` com `challengeId`, PIN, nome e a senha guardada. Se o PIN estiver errado, o erro aparece nesta tela.
3. O Auth Server consome o PIN, cria a `user_auth` (`pending_provisioning`) e chama a rota interna do back-end, que cria o USER (`account_type = tutor`) e o TUTOR com o nome.
4. Com a confirmação do back-end, o Auth marca a `user_auth` como `active` e devolve access token + refresh token.
5. **Tela logada:** a conclusão do perfil (celular e demais dados) fica no back-end (outra PBI).

## Rotas

Padrão (#56): prefixo `/api/v1/`, envelope de resposta e erro padronizado. Ações usam `POST` com o verbo no caminho.

O contrato de todas as rotas está em [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1). Para validar: `npx @redocly/cli lint docs/openapi.yaml`.

### Status HTTP usados

| Código | Quando |
| --- | --- |
| `200 OK` | Deu certo e devolve um resultado |
| `201 Created` | Criou algo novo |
| `400 Bad Request` | Payload inválido (validação Joi) |
| `401 Unauthorized` | Credencial ou token inválido |
| `403 Forbidden` | Credencial certa, mas a conta não pode entrar (cadastro não concluído) |
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
{ "email": "tutor@exemplo.com", "name": "Maria Silva" }
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
  "name": "Maria Silva",
  "pin": "012345",
  "password": "...",
  "acceptedTerms": true,
  "termsVersion": "2026-10-01"
}
```

O e-mail não vem no payload: ele vem da `email_verification`. `name` tem até 255 caracteres (igual a `tutors.name` no back-end) e não é gravado no Auth, só repassado. O PIN é string de 6 dígitos (preserva zeros à esquerda). `acceptedTerms` só aceita `true`. `termsVersion` identifica a versão dos termos aceita (até 64 caracteres). A confirmação de senha fica só no front.

| Status | Caso | Body |
| --- | --- | --- |
| `201` | Conta criada e USER confirmado no back-end | access token e refresh token (ver abaixo) |
| `400` | Payload inválido ou termos não aceitos | erro padrão |
| `401` | PIN errado (incrementa `attempts`) | erro padrão |
| `404` | `challengeId` não existe | erro padrão |
| `409` | E-mail já cadastrado com `user_auth` `active` (inclui corrida: `UNIQUE` / Prisma P2002) | erro padrão |
| `410` | PIN expirado, invalidado ou consumido (exceto na retentativa) | erro padrão |
| `429` | Limite de tentativas atingido | erro padrão |
| `503` | Back-end não confirmou a criação do USER | erro padrão |

Ordem das validações: challenge existe (`404`) → não consumido, invalidado nem expirado (`410`) → menos de 5 tentativas (`429`) → PIN confere (`401` e `attempts + 1`). Depois, numa transação: consome o challenge (update condicional) e cria a `user_auth`. Se o e-mail já tem `user_auth` em `pending_provisioning`, a linha é reaproveitada (mesmo `auth_user_id`) e recebe a senha e o aceite novos.

Depois do back-end confirmar, a `user_auth` vira `active` e só então os tokens são emitidos. Falha de PIN, de payload ou do back-end lança erro antes, então nenhum token sai nesses casos.

Resposta `201` (formato do OAuth 2.0, RFC 6749, em camelCase):

```json
{
  "accessToken": "eyJhbGciOiJSUzI1NiJ9...",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshToken": "q3J9vXk2..."
}
```

- `tokenType: "Bearer"`: o front envia o token como `Authorization: Bearer <accessToken>`.
- `expiresIn`: segundos até o token vencer, para o front saber quando renovar sem decodificar o token.
- `refreshToken`: usado só na rota [`refresh`](#post-apiv1authrefresh), nunca enviado ao back-end. O front guarda em secure storage (ADR-005).
- O `authUserId` não vem na resposta: ele já está no `sub` do token, e o front identifica o usuário chamando o back-end com o token.

### Access token (JWT)

Emitido pelo `signAccessToken` (`src/lib/jwt.js`), assinado com RS256 e a chave privada. Decisão registrada na ADR-012 (wiki).

| Parte | Conteúdo |
| --- | --- |
| Header | `{ "alg": "RS256" }` |
| `sub` | `authUserId` (`user_auth.id`), o identificador estável da identidade |
| `iss` | `hospetse-auth-service` |
| `aud` | `hospetse-backend` |
| `iat` | Momento da emissão (segundos Unix) |
| `exp` | `iat` + 900 (15 min, `ACCESS_TOKEN_TTL_SECONDS`) |

O payload é só base64, então qualquer um consegue ler: e-mail, nome e outros dados pessoais não vão no token. O back-end busca o USER pelo `sub`.

Um JWT não pode ser revogado antes do `exp`. Por isso a vida curta: um token roubado vale no máximo 15 minutos, e a renovação é feita pelo refresh token, que pode ser revogado.

#### Como o back-end principal valida

O back-end não chama o Auth Server para validar: ele tem a chave pública e confere o token sozinho, em toda requisição protegida. Ele **não consegue emitir** tokens, porque só a privada assina.

Ordem da validação (o `jwtVerify` do `jose` faz tudo numa chamada):

1. Header `Authorization: Bearer <token>` presente.
2. Assinatura confere com a chave pública e o `alg` é `RS256` (recusa `none`, `HS256` e outros).
3. `exp` não passou.
4. `iss` é `hospetse-auth-service` e `aud` é `hospetse-backend`.
5. Localiza o USER por `users.auth_user_id = sub`.

Qualquer falha nos passos 1 a 4 responde `401`. O back-end usa a mesma lógica do `verifyAccessToken` deste repositório, num middleware do Express. Exemplo:

```js
import { importSPKI, jwtVerify } from 'jose';

const publicKey = await importSPKI(process.env.JWT_PUBLIC_KEY, 'RS256');

export async function authenticate(req, res, next) {
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Token ausente' });
    }

    try {
        const { payload } = await jwtVerify(token, publicKey, {
            issuer: 'hospetse-auth-service',
            audience: 'hospetse-backend',
            algorithms: ['RS256'],
        });
        req.authUserId = payload.sub;
        next();
    } catch {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
}
```

O back-end recebe só o `JWT_PUBLIC_KEY` (o mesmo conteúdo de `keys/public.pem`). A chave privada nunca sai do Auth Server; se a pública vazar, ninguém consegue forjar tokens com ela.

Erros que o `jose` lança (`err.code`), úteis no log:

| Código | Quando |
| --- | --- |
| `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` | Token adulterado ou assinado com outra chave |
| `ERR_JWT_EXPIRED` | Passou do `exp` |
| `ERR_JWT_CLAIM_VALIDATION_FAILED` | `iss` ou `aud` diferente do esperado |

Neste repositório o `verifyAccessToken` é usado pelos testes, para provar que o token emitido é válido.

### `POST /api/v1/auth/refresh`

Troca um refresh token válido por um novo access token e um novo refresh token (rotação). O front chama quando o access token vence: o back-end responde `401`, o front renova e refaz a chamada.

Request (mobile, no body; o cookie httpOnly da web é [TBD](#pendente-tbd)):

```json
{
  "refreshToken": "q3J9vXk2..."
}
```

| Status | Caso | Body |
| --- | --- | --- |
| `200` | Token válido | `{ accessToken, tokenType, expiresIn, refreshToken }`, no mesmo formato do `register` |
| `400` | Payload sem `refreshToken` ou fora do formato base64url | erro padrão |
| `401` | Token não emitido pelo Auth, expirado, revogado, reusado ou de conta que não está `active` | erro padrão, com a mesma mensagem em todos os casos |

`401` no `refresh` significa que a sessão acabou: o front apaga os tokens e manda para o login. A mensagem é a mesma em todos os casos para não contar a quem tem um token roubado por que ele falhou.

#### Como o refresh token funciona

- **Geração:** 32 bytes de `crypto.randomBytes` em base64url (43 caracteres, 256 bits). Não é JWT: é um valor opaco que só o Auth entende.
- **Armazenamento:** o banco guarda só o SHA-256 em hex (`token_hash`). Se o banco vazar, os hashes não servem na rota, porque o Auth calcula o hash do que recebe. SHA-256 sem chave basta porque o token tem 256 bits aleatórios (não dá para testar combinações, como no PIN), e por ser determinístico permite buscar pelo `UNIQUE (token_hash)`.
- **Validade:** 30 dias (`REFRESH_TOKEN_TTL_DAYS`). Como cada renovação emite um token novo, quem usa o app pelo menos uma vez a cada 30 dias não precisa logar de novo.
- **Emissão:** no `register`, depois do `active`, e em cada renovação. O `issueRefreshToken(userAuthId, db)` recebe o cliente da transação quando roda dentro de uma.

Ordem das validações no `refresh`:

1. Busca pelo hash; não existe → `401`.
2. Já revogado → **reuso**: revoga todos os tokens da conta e responde `401`.
3. `expires_at` passou → `401`.
4. `user_auth` não está `active` → `401`.
5. Numa transação: revoga o token atual com update condicional (`WHERE id = ... AND revoked_at IS NULL`) e cria o novo. Se o update não alterar nenhuma linha (outra requisição usou o mesmo token antes), responde `401`.
6. Emite o access token e devolve os dois.

**Rotação:** cada refresh token vale uma vez. Revogar o atual e criar o novo ficam na mesma transação: se o servidor cair no meio, nada muda, e o usuário nunca fica sem token nem com dois.

**Detecção de reuso:** um token já rotacionado só volta se alguém tem uma cópia. O Auth não sabe quem é o dono e quem é o atacante, então revoga todos os tokens da conta e os dois precisam logar de novo; só o dono tem a senha. Essa revogação fica fora de transação de propósito: o `throw` logo depois desfaria a revogação num rollback.

**Renovações simultâneas:** duas requisições com o mesmo token nunca geram dois tokens válidos. Se a segunda lê o banco antes da primeira terminar, perde no update condicional (`401`, e o token da primeira continua valendo); se lê depois, cai no reuso e a sessão inteira cai. Por isso o front precisa de uma **fila de refresh**: se já tem uma renovação em andamento, as outras chamadas esperam por ela em vez de disparar outra (orientação registrada na #300).

```js
let refreshing = null;   // a promessa do refresh que está rodando

refreshing ??= doRefresh().finally(() => { refreshing = null });
const data = await refreshing;   // quem chegar depois espera o mesmo refresh
```

O refresh token nunca vai para o log: o controller registra só a mensagem do erro, e a mensagem do Joi não repete o valor recebido.

### `POST /api/v1/auth/login`

Autentica com e-mail e senha e emite os tokens (Task #296, HSP-PBI-005-TSK-02). Usado por quem já tem conta, depois que o access token e o refresh token acabaram (ou em outro aparelho).

Request:

```json
{ "email": "tutor@exemplo.com", "password": "..." }
```

O e-mail passa pela mesma normalização do `request-pin` (trim e minúsculas, até 255 caracteres).

| Status | Caso | Body |
| --- | --- | --- |
| `200` | Senha confere e a `user_auth` está `active` | `{ accessToken, tokenType, expiresIn, refreshToken }`, no mesmo formato do `register` |
| `400` | Payload sem e-mail válido ou sem senha | erro padrão |
| `401` | E-mail sem conta ou senha errada | erro padrão, com a mesma mensagem nos dois casos |
| `403` | Senha confere, mas a `user_auth` está `pending_provisioning` (o back-end não confirmou o cadastro) | erro padrão; o front orienta a pedir um novo PIN para terminar o cadastro (ver [Retentativa](#retentativa)) |
| `500` | Falha inesperada | erro padrão |

- **Sem enumeração de contas:** e-mail inexistente e senha errada respondem igual. Quando o e-mail não existe, o `argon2.verify` roda mesmo assim contra o hash de uma senha aleatória, para o tempo de resposta também não denunciar quais e-mails têm conta.
- **`403` só depois da senha:** quem não sabe a senha recebe `401` mesmo numa conta `pending`, então só o dono descobre que o cadastro ficou pela metade.
- Cada login emite um refresh token novo (sessão nova); os das outras sessões continuam valendo.
- Senha e tokens nunca vão para o log: o controller registra só a mensagem do erro.
- Papéis e dados do perfil não entram no token: o JWT leva só o `sub`, e o front consulta o `GET /api/v1/me` do back-end.

### Rota interna (no back-end principal): `PUT /api/v1/internal/users/{authUserId}`

Chamada só pelo Auth Server, depois de criar a `user_auth`. Não é usada pelo front.

`PUT` porque é idempotente: chamar de novo após um timeout não cria um segundo USER. O `authUserId` vai no caminho porque é o Auth que gera esse identificador. O back-end guarda ele na coluna `users.auth_user_id` (UNIQUE), separada do `users.id`, que continua gerado pelo back-end. O UNIQUE é o que garante que a retentativa não duplica o USER.

Request:

```json
{ "email": "tutor@exemplo.com", "name": "Maria Silva" }
```

Autenticação: `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`, segredo compartilhado com o back-end (#473). É provisório: o alvo é um token de serviço (JWT curto assinado pelo Auth com a chave privada RS256, `aud: "hospetse-backend-internal"`), que o back-end valida com a chave pública que já tem, no mesmo cabeçalho.

| Status | Caso |
| --- | --- |
| `201` | USER (`account_type = tutor`) e TUTOR (com o `name`) criados agora |
| `200` | USER já existia para esse `authUserId` (retentativa) |
| `401` | Token de serviço ausente ou inválido |
| `409` | E-mail já usado por outro USER |

## Tratamento de falhas no `register`

O PIN é consumido e a `user_auth` é criada (`pending_provisioning`) antes da chamada ao back-end. Se a chamada falhar, essa linha continua lá.

| Resposta do back-end | Auth Server faz | Front recebe |
| --- | --- | --- |
| `201` ou `200` | Marca `active`, preenche `provisioned_at`, emite tokens (#254) | `201` + tokens |
| `409` | Mantém `pending_provisioning` e registra o erro | `409` |
| `401` | Erro de configuração; registra o erro | `503` |
| Timeout ou `5xx` | Retenta dentro da requisição; se todas falharem, mantém `pending_provisioning` | `503` |

### Retentativa

Duas camadas:

1. **Auth retenta dentro da requisição:** até 3 tentativas do `PUT` (timeout de 3 s cada, espera de 200 ms e 400 ms), antes de devolver `503`. Seguro porque o `PUT` é idempotente. Cobre falhas rápidas (deploy, oscilação de rede).
2. **Front oferece "tentar de novo":** se ainda vier `503`, o front reenvia o `register` com o mesmo `challengeId`, PIN e senha.

Regra do `register` para a retentativa: se a `user_auth` do e-mail está em `pending_provisioning`, o `register` aceita o mesmo `challengeId` + PIN de novo, desde que o PIN não tenha expirado nem sido invalidado. O limite de tentativas e a comparação do PIN continuam valendo. Se a conta já está `active`, o challenge consumido responde `410`. Nesse caso:

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

O Auth Server não guarda referência ao USER: o back-end principal guarda o `auth_user_id` numa coluna própria (`users.auth_user_id`, UNIQUE) e localiza o USER pelo `sub` do JWT. O `users.id` é do back-end e não sai dele, então as FKs internas não dependem do Auth.

O cadastro recebe só `challengeId`, nome, PIN, senha, aceite e versão dos termos; o e-mail vem da `email_verification`. Ao back-end principal são enviados apenas `auth_user_id`, e-mail confirmado e nome (nunca a senha).

### `refresh_token`

Permite renovar o access token (JWT) sem pedir a senha de novo e revogar o acesso.

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | UUID, PK | Gerado pelo banco |
| `user_auth_id` | UUID, FK → `user_auth.id` | Dono do token |
| `token_hash` | VARCHAR(255), UNIQUE | SHA-256 (hex) do refresh token. O token original nunca é salvo |
| `expires_at` | TIMESTAMPTZ | 30 dias após a emissão. Refresh token expirado é rejeitado |
| `revoked_at` | TIMESTAMPTZ, nulo | Preenchido na rotação (token usado), no reuso (todos da conta) e, na #297, no logout. Token revogado é rejeitado |
| `created_at` | TIMESTAMPTZ | |

Índices: `UNIQUE (token_hash)` para localizar o token na renovação; `(user_auth_id)` para revogar todos os tokens de um usuário.

### Regras importantes

- Consumir o PIN e criar a `user_auth` acontecem na mesma transação.
- O PIN é consumido com update condicional (`WHERE consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`), para que duas requisições simultâneas não usem o mesmo PIN. A exceção é a [retentativa](#retentativa) com `user_auth` em `pending_provisioning`.
- O refresh token é revogado com o mesmo tipo de update condicional (`WHERE revoked_at IS NULL`), na mesma transação que cria o próximo.
- PIN, senha, tokens e segredos nunca aparecem em logs.

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
- **Biblioteca do JWT:** `jose` (ADR-012): ES Modules, `async/await`, sem dependências, e amarra cada chave a um algoritmo.
- **Login:** mesma resposta para e-mail inexistente e senha errada, com `argon2.verify` contra um hash falso quando a conta não existe (sem enumeração por mensagem nem por tempo). Conta `pending_provisioning` recebe `403` só depois da senha conferir. MFA fora do escopo (#296).
- **Access token:** 15 min, claims `sub`, `iss`, `aud`, `iat` e `exp`, sem dados pessoais (ADR-012).
- **Tokens:** access token curto + refresh token (Task #256). Armazenamento por plataforma conforme ADR-005: mobile em secure storage; web com refresh em cookie httpOnly/Secure/SameSite e access token em memória.
- **Refresh token:** valor aleatório de 256 bits (não JWT), guardado só como SHA-256, validade de 30 dias, rotação a cada renovação e detecção de reuso revogando todos os tokens da conta. O access token não é revogável; o refresh é, no banco.
- **Comunicação Auth → back-end:** rota interna `PUT` idempotente, autenticada hoje por segredo compartilhado (`INTERNAL_SERVICE_TOKEN`) e, no futuro, por token de serviço RS256 com `aud` próprio. A chamada fica fora da transação do `register`, para a `user_auth` `pending` sobreviver à falha e permitir a retentativa com o mesmo `authUserId`.
- **Vínculo USER ↔ identidade:** o back-end guarda o `authUserId` em `users.auth_user_id` (UNIQUE), separado do `users.id`.
- **Nome no cadastro:** o `register` recebe o `name` e só repassa ao back-end, que cria o TUTOR com ele. O Auth não guarda o nome.
- **Cliente HTTP:** axios, o mesmo dos testes. Fica em `dependencies`, porque o `HttpUserProvisioner` usa em produção.

### Pendente (TBD)

- Regras da senha: tamanho mínimo, máximo e composição (decisão da PO na #252). Por enquanto a API só exige a senha.
- Mover tamanho do PIN (6), expiração (15 min) e intervalo de reenvio (60 s) do código para variáveis de ambiente.
- Provedor real de e-mail e a escolha da implementação por ambiente no `index.js`. Até lá, o `ConsoleEmailSender` mostra o PIN no terminal de propósito (é a única exceção à regra de PIN fora dos logs, e só em desenvolvimento).
- Teste do fluxo contra o back-end real: o `auth-flow.test.js` usa um back-end fake com o contrato da #259 e o mesmo `401` sem token. A rota interna já existe (#261): falta validar o fluxo ponta a ponta com o back-end de verdade.
- Refresh token na web por cookie httpOnly (ADR-005): hoje a rota lê só do body, que é o caso do mobile.
- Logout com revogação do refresh token (#297) e revogação de todas as sessões na troca de senha (#286). A coluna `revoked_at` e a checagem no `refresh` já existem.
- Janela de tolerância para o reuso: hoje, se a resposta do `refresh` se perde na rede e o front reenvia o mesmo token, cai no reuso e a sessão cai. Alternativa: aceitar o token recém-rotacionado por alguns segundos.
- Limpeza dos refresh tokens vencidos ou revogados (job periódico).
- Mover a validade do refresh token (30 dias) do código para variável de ambiente, se precisar variar por ambiente.
- Se a checagem de e-mail duplicado fica no `request-pin` (como acima) ou numa rota separada. Em ambos os casos, precisa de rate limit.
- Confirmação da PO de que a `passwordConfirmation` fica só no front (recomendação técnica registrada na #252).
- Se o `termsVersion` aceito precisa ser a versão vigente (ex.: env `TERMS_VERSION`) ou qualquer versão.
- Formato exato do erro padrão (#56) e lista de códigos de erro.
- Token de serviço RS256 na rota interna: hoje o `HttpUserProvisioner` envia o segredo compartilhado `INTERNAL_SERVICE_TOKEN` (#473). As chaves RS256 já existem (#254); falta emitir o token com `aud: "hospetse-backend-internal"` e o back-end validar na rota interna.
- Rotação das chaves do JWT: como trocar o par sem invalidar de uma vez os tokens que ainda valem (ex.: `kid` no header e o back-end aceitando duas chaves públicas durante a troca).
- Entrega da chave pública ao back-end: copiar o PEM para o `.env` do back-end (forma atual) ou publicar um JWKS no Auth Server para o back-end buscar.
- Mover `iss`, `aud` e a validade do access token do código para variáveis de ambiente, se precisar variar por ambiente.
- Rota interna no back-end (`PUT /api/v1/internal/users/{authUserId}`), com `users.auth_user_id` UNIQUE, criação do TUTOR com o nome e `users.password` deixando de ser obrigatório.
- Mover o timeout (3 s) e as tentativas (3) do `HttpUserProvisioner` para variáveis de ambiente, se precisar ajustar por ambiente.
- User agent / dados do dispositivo na sessão (depois).
- Limite de tentativas de login por e-mail ou IP (força bruta na senha): funcionalidade nova, fora da #301 (que só cobre testes); pedido de task registrado na #301.
