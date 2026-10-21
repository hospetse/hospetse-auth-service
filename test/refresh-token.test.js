import { after, test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import axios from 'axios';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { FakeUserProvisioner } from '../src/user-provisioning/fake.user-provisioner.js';
import { issueRefreshToken } from '../src/refresh-token/refresh-token.service.js';
import { verifyAccessToken } from '../src/lib/jwt.js';

const emailSender = new FakeEmailSender();
const userProvisioner = new FakeUserProvisioner();
const app = createApp({ emailSender, userProvisioner });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

// cria a user_auth direto no banco, sem passar pelo cadastro, para testar só o refresh
async function createUserAuth(status = 'active') {
    return prisma.userAuth.create({
        data: { email: `teste-refresh-${crypto.randomUUID()}@example.com`, passwordHash: 'hash-de-teste', termsVersion: 'v1', status }
    });
}

function refresh(refreshToken) {
    return axios.post(`http://localhost:${port}/api/v1/auth/refresh`,
        { refreshToken },
        { validateStatus: () => true }
    );
}

test('refresh: payload inválido retorna 400', async () => {
    const semToken = await axios.post(`http://localhost:${port}/api/v1/auth/refresh`, {}, { validateStatus: () => true });
    const base64Comum = await refresh('abc+/=');

    assert.strictEqual(semToken.status, 400);
    assert.strictEqual(base64Comum.status, 400);
});

test('refresh: token que o Auth não emitiu retorna 401', async () => {
    const response = await refresh(crypto.randomBytes(32).toString('base64url'));

    assert.strictEqual(response.status, 401);
    assert.ok(!response.data.accessToken);
});

test('refresh: o cadastro devolve o refresh token e o banco guarda só o hash', async () => {
    const email = `teste-refresh-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' }
    );

    assert.strictEqual(response.status, 201);
    assert.ok(response.data.refreshToken);

    // o refresh token original não é persistido: só o SHA-256 dele
    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    const stored = await prisma.refreshToken.findMany({ where: { userAuthId: userAuth.id } });
    assert.strictEqual(stored.length, 1);
    assert.notStrictEqual(stored[0].tokenHash, response.data.refreshToken);
    assert.strictEqual(stored[0].tokenHash, crypto.createHash('sha256').update(response.data.refreshToken).digest('hex'));
    assert.ok(stored[0].expiresAt > new Date());
});

test('refresh: token válido retorna 200 com um access token novo e rotaciona o refresh', async () => {
    const userAuth = await createUserAuth();
    const refreshToken = await issueRefreshToken(userAuth.id);

    const response = await refresh(refreshToken);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.tokenType, 'Bearer');
    assert.strictEqual(response.data.expiresIn, 900);

    const { sub } = await verifyAccessToken(response.data.accessToken);
    assert.strictEqual(sub, userAuth.id);

    // rotação: veio um refresh novo e o usado foi revogado
    assert.ok(response.data.refreshToken);
    assert.notStrictEqual(response.data.refreshToken, refreshToken);

    const tokens = await prisma.refreshToken.findMany({ where: { userAuthId: userAuth.id } });
    assert.strictEqual(tokens.length, 2);
    assert.strictEqual(tokens.filter((token) => token.revokedAt).length, 1);
});

test('refresh: token já usado retorna 401 e revoga todos os tokens da conta (reuso)', async () => {
    const userAuth = await createUserAuth();
    const firstToken = await issueRefreshToken(userAuth.id);

    const first = await refresh(firstToken);
    assert.strictEqual(first.status, 200);

    // alguém usa de novo o token que já foi rotacionado: é uma cópia
    const reuse = await refresh(firstToken);
    assert.strictEqual(reuse.status, 401);
    assert.ok(!reuse.data.accessToken);

    // o token novo (de quem rotacionou primeiro) também morre
    const afterReuse = await refresh(first.data.refreshToken);
    assert.strictEqual(afterReuse.status, 401);

    const active = await prisma.refreshToken.count({ where: { userAuthId: userAuth.id, revokedAt: null } });
    assert.strictEqual(active, 0);
});

test('refresh: token expirado retorna 401', async () => {
    const userAuth = await createUserAuth();
    const refreshToken = await issueRefreshToken(userAuth.id);
    await prisma.refreshToken.updateMany({
        where: { userAuthId: userAuth.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
    });

    const response = await refresh(refreshToken);

    assert.strictEqual(response.status, 401);
    assert.ok(!response.data.accessToken);
});

test('refresh: conta que não está active retorna 401', async () => {
    const userAuth = await createUserAuth('pending_provisioning');
    const refreshToken = await issueRefreshToken(userAuth.id);

    const response = await refresh(refreshToken);

    assert.strictEqual(response.status, 401);
    assert.ok(!response.data.accessToken);
});

test('refresh: duas renovações ao mesmo tempo com o mesmo token nunca geram dois tokens válidos', async () => {
    const userAuth = await createUserAuth();
    const refreshToken = await issueRefreshToken(userAuth.id);

    const responses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);

    const statuses = responses.map((response) => response.status).sort();
    assert.deepStrictEqual(statuses, [200, 401]);

    // depende de quando a segunda lê o banco: antes do commit da primeira, perde no count (sobra 1 token);
    // depois, vê o token revogado e cai no reuso (sobra 0). Nos dois casos, nunca 2
    const active = await prisma.refreshToken.count({ where: { userAuthId: userAuth.id, revokedAt: null } });
    assert.ok(active <= 1);
});

test('refresh: o refresh token não aparece nos logs', async () => {
    const userAuth = await createUserAuth();
    const refreshToken = await issueRefreshToken(userAuth.id);

    // captura tudo o que for logado durante as chamadas (sucesso, reuso e payload inválido)
    const logged = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logged.push(args.join(' '));
    console.error = (...args) => logged.push(args.join(' '));
    try {
        await refresh(refreshToken);
        await refresh(refreshToken);
        await refresh(`${refreshToken}+/=`);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }

    assert.ok(logged.every((line) => !line.includes(refreshToken)));
});

after(async () => {
    await prisma.emailVerification.deleteMany({
        where: { email: { startsWith: 'teste-refresh-', endsWith: '@example.com' } }
    });
    // o refresh_token sai junto (onDelete: Cascade)
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-refresh-', endsWith: '@example.com' } }
    });
    server.close();
    await prisma.$disconnect();
});
