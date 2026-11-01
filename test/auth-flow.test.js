import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import express from 'express';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { HttpUserProvisioner } from '../src/user-provisioning/http.user-provisioner.js';
import { verifyAccessToken } from '../src/lib/jwt.js';

// Fluxo completo com o HttpUserProvisioner de verdade: o Auth chama, por HTTP, um Express fake
// no papel do back-end principal, seguindo o contrato da rota interna (#259).
// A rota real ainda não existe no back-end (#261); quando existir, este teste aponta para ela.

// Back-end fake. `backendMode` escolhe a resposta; `backendCalls` guarda o que chegou
// e o status da user_auth no momento da chamada.
let backendMode = 'ok';
const backendCalls = [];
const SERVICE_TOKEN = 'token-de-servico-teste';

const backend = express();
backend.use(express.json());
backend.put('/api/v1/internal/users/:authUserId', async (req, res) => {
    // Igual ao back-end real: sem o token de serviço certo, para aqui
    if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
        return res.sendStatus(401);
    }
    if (backendMode === 'slow') {
        return setTimeout(() => res.sendStatus(201), 2500);
    }

    const userAuth = await prisma.userAuth.findUnique({ where: { id: req.params.authUserId } });
    backendCalls.push({ authUserId: req.params.authUserId, body: req.body, userAuthStatus: userAuth?.status });

    if (backendMode === 'down') {
        return res.sendStatus(500);
    }
    return res.status(201).json({ authUserId: req.params.authUserId });
});
const backendServer = backend.listen(0);

// Timeout de 2 s (o fake consulta o banco de dev, que é remoto) e espera curta entre as tentativas
const userProvisioner = new HttpUserProvisioner(`http://localhost:${backendServer.address().port}`, SERVICE_TOKEN, { timeout: 2000, retryDelayMs: 10 });
const emailSender = new FakeEmailSender();
const app = createApp({ emailSender, userProvisioner });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

const password = 'senha-forte-123';

async function requestPin(email) {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`, { email });
    const pin = emailSender.sent.find((message) => message.to === email).text.match(/\d{6}/)[0];
    return { challengeId: response.data.challengeId, pin };
}

function register(body) {
    return axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { password, name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1', ...body },
        { validateStatus: () => true }
    );
}

async function refreshTokensOf(email) {
    return prisma.refreshToken.count({ where: { userAuth: { email } } });
}

test('fluxo: PIN, cadastro, USER no back-end, tokens e renovação', async () => {
    const email = `teste-flow-${Date.now()}@example.com`;

    const { challengeId, pin } = await requestPin(email);
    const response = await register({ challengeId, pin });

    assert.strictEqual(response.status, 201);
    const { sub } = await verifyAccessToken(response.data.accessToken);
    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(sub, userAuth.id);
    assert.strictEqual(userAuth.status, 'active');

    // o back-end recebeu um PUT, pelo authUserId, só com e-mail e nome (nunca a senha)
    const calls = backendCalls.filter((call) => call.authUserId === userAuth.id);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].body, { email, name: 'Tutor Teste' });

    // no momento em que o back-end cria o USER, a conta ainda não está active: só fica depois da confirmação
    assert.strictEqual(calls[0].userAuthStatus, 'pending_provisioning');

    // o refresh token do cadastro renova a sessão
    const refreshed = await axios.post(`http://localhost:${port}/api/v1/auth/refresh`,
        { refreshToken: response.data.refreshToken }
    );
    assert.strictEqual(refreshed.status, 200);
    assert.strictEqual((await verifyAccessToken(refreshed.data.accessToken)).sub, userAuth.id);
});

test('fluxo: PIN errado não chama o back-end nem emite tokens', async () => {
    const email = `teste-flow-pin-${Date.now()}@example.com`;

    const { challengeId, pin } = await requestPin(email);
    const response = await register({ challengeId, pin: pin === '000000' ? '111111' : '000000' });

    assert.strictEqual(response.status, 401);
    assert.ok(!response.data.accessToken);
    assert.ok(!response.data.refreshToken);
    assert.strictEqual(await prisma.userAuth.count({ where: { email } }), 0);
    assert.ok(backendCalls.every((call) => call.body.email !== email));
});

test('fluxo: back-end com erro deixa a conta pending, sem tokens, e a retentativa conclui sem duplicar', async () => {
    const email = `teste-flow-falha-${Date.now()}@example.com`;
    const { challengeId, pin } = await requestPin(email);

    backendMode = 'down';
    const failed = await register({ challengeId, pin });
    backendMode = 'ok';

    assert.strictEqual(failed.status, 503);
    assert.ok(!failed.data.accessToken);
    assert.ok(!failed.data.refreshToken);

    // estado consistente depois da falha: PIN consumido, conta pending, nenhum refresh token
    const pending = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(pending.status, 'pending_provisioning');
    assert.strictEqual(pending.provisionedAt, null);
    assert.ok((await prisma.emailVerification.findUnique({ where: { id: challengeId } })).consumedAt);
    assert.strictEqual(await refreshTokensOf(email), 0);
    assert.strictEqual(backendCalls.filter((call) => call.authUserId === pending.id).length, 3);

    // "tentar de novo" do front: mesmo challenge e PIN
    const retried = await register({ challengeId, pin });

    assert.strictEqual(retried.status, 201);
    assert.strictEqual(await prisma.userAuth.count({ where: { email } }), 1);
    assert.strictEqual(await refreshTokensOf(email), 1);

    // o back-end recebeu sempre o mesmo authUserId (PUT idempotente), que é o sub do token
    const ids = new Set(backendCalls.filter((call) => call.body.email === email).map((call) => call.authUserId));
    assert.deepStrictEqual([...ids], [pending.id]);
    assert.strictEqual((await verifyAccessToken(retried.data.accessToken)).sub, pending.id);
});

test('fluxo: timeout do back-end responde 503 sem tokens e sem refresh token no banco', async () => {
    const email = `teste-flow-timeout-${Date.now()}@example.com`;
    const { challengeId, pin } = await requestPin(email);

    backendMode = 'slow';
    const response = await register({ challengeId, pin });
    backendMode = 'ok';

    assert.strictEqual(response.status, 503);
    assert.ok(!response.data.accessToken);
    assert.strictEqual((await prisma.userAuth.findUnique({ where: { email } })).status, 'pending_provisioning');
    assert.strictEqual(await refreshTokensOf(email), 0);
});

test('fluxo: PIN, senha, tokens e segredos não aparecem nos logs', async () => {
    const email = `teste-flow-logs-${Date.now()}@example.com`;

    // captura tudo o que for logado durante o fluxo, incluindo os caminhos de erro
    const logged = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logged.push(args.map(String).join(' '));
    console.error = (...args) => logged.push(args.map(String).join(' '));

    let pin;
    let tokens;
    try {
        const pinData = await requestPin(email);
        pin = pinData.pin;
        await register({ challengeId: pinData.challengeId, pin: pin === '000000' ? '111111' : '000000' });

        backendMode = 'down';
        await register({ challengeId: pinData.challengeId, pin });
        backendMode = 'ok';

        tokens = (await register({ challengeId: pinData.challengeId, pin })).data;
        await axios.post(`http://localhost:${port}/api/v1/auth/refresh`, { refreshToken: tokens.refreshToken });
        await axios.post(`http://localhost:${port}/api/v1/auth/refresh`, { refreshToken: tokens.refreshToken }, { validateStatus: () => true });
    } finally {
        backendMode = 'ok';
        console.log = originalLog;
        console.error = originalError;
    }

    // houve log (as falhas do back-end), então o teste não passa por não logar nada
    assert.ok(logged.length > 0);

    const secrets = [
        pin,
        password,
        tokens.accessToken,
        tokens.refreshToken,
        process.env.PIN_HMAC_SECRET,
        process.env.JWT_PRIVATE_KEY.split('\n')[1], // uma linha do meio da chave
        email // o log do provisionamento usa só o authUserId
    ];
    for (const secret of secrets) {
        assert.ok(logged.every((line) => !line.includes(secret)), 'segredo encontrado no log');
    }
});

after(async () => {
    await prisma.emailVerification.deleteMany({
        where: { email: { startsWith: 'teste-flow-', endsWith: '@example.com' } }
    });
    // o refresh_token sai junto (onDelete: Cascade)
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-flow-', endsWith: '@example.com' } }
    });
    server.close();
    backendServer.close();
    await prisma.$disconnect();
});
