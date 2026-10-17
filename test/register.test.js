import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';

const emailSender = new FakeEmailSender();
const app = createApp({ emailSender });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

test('register: payload inválido retorna 400', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: 'nao-e-uuid', pin: '12', password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
    assert.ok(response.data.error);
});

test('register: termos não aceitos retorna 400', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: crypto.randomUUID(), pin: '123456', password: 'senha-forte-123', acceptedTerms: false, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
});

test('register: challenge inexistente retorna 404', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: crypto.randomUUID(), pin: '123456', password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 404);
});

test('register: PIN e payload válidos criam a user_auth pending e retornam 201 com authUserId', async () => {
    const email = `teste-register-${Date.now()}@example.com`;
    const password = 'senha-forte-123';

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password, acceptedTerms: true, termsVersion: 'v1' }
    );

    assert.strictEqual(response.status, 201);
    assert.ok(response.data.authUserId);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.id, response.data.authUserId);
    assert.strictEqual(userAuth.status, 'pending_provisioning');
    assert.strictEqual(userAuth.termsVersion, 'v1');
    assert.ok(userAuth.termsAcceptedAt);

    // Senha original não é persistida: só o hash Argon2id, que confere com a senha.
    assert.notStrictEqual(userAuth.passwordHash, password);
    assert.match(userAuth.passwordHash, /^\$argon2id\$/);
    assert.ok(await argon2.verify(userAuth.passwordHash, password));

    const challenge = await prisma.emailVerification.findUnique({
        where: { id: pinResponse.data.challengeId }
    });
    assert.ok(challenge.consumedAt);
});

test('register: PIN errado retorna 401, conta tentativa e não cria identidade', async () => {
    const email = `teste-register-401-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;
    const wrongPin = pin === '000000' ? '111111' : '000000';

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin: wrongPin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 401);

    const challenge = await prisma.emailVerification.findUnique({
        where: { id: pinResponse.data.challengeId }
    });
    assert.strictEqual(challenge.attempts, 1);
    assert.strictEqual(challenge.consumedAt, null);

    const userAuth = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuth, 0);
});

test('register: limite de tentativas retorna 429 mesmo com o PIN certo', async () => {
    const email = `teste-register-429-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    // Simula as 5 tentativas erradas sem precisar fazer 5 requisições.
    await prisma.emailVerification.update({
        where: { id: pinResponse.data.challengeId },
        data: { attempts: 5 }
    });

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 429);

    const userAuth = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuth, 0);
});

test('register: PIN expirado retorna 410 e não cria identidade', async () => {
    const email = `teste-register-expirado-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    // "Vence" o PIN, sem esperar os 15 min.
    await prisma.emailVerification.update({
        where: { id: pinResponse.data.challengeId },
        data: { expiresAt: new Date(Date.now() - 1_000) }
    });

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 410);

    const userAuth = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuth, 0);
});

test('register: PIN invalidado por um reenvio retorna 410', async () => {
    const email = `teste-register-invalidado-${Date.now()}@example.com`;

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const firstPin = emailSender.sent.find((message) => message.to === email).text;

    // "Envelhece" o primeiro pedido para o reenvio passar do 429.
    await prisma.emailVerification.update({
        where: { id: first.data.challengeId },
        data: { createdAt: new Date(Date.now() - 61_000) }
    });
    await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: first.data.challengeId, pin: firstPin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 410);

    const userAuth = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuth, 0);
});

test('register: reutilizar um PIN já consumido retorna 410', async () => {
    const email = `teste-register-reuso-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;
    const body = { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' };

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/register`, body);
    assert.strictEqual(first.status, 201);

    const second = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        body,
        { validateStatus: () => true }
    );

    assert.strictEqual(second.status, 410);

    const userAuth = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuth, 1);
});

test('register: e-mail com user_auth ativa retorna 409 e desfaz o consumo do PIN', async () => {
    const email = `teste-register-409-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    // Conta ativada depois do pedido do PIN (o request-pin já barra se estivesse ativa antes).
    await prisma.userAuth.create({
        data: { email, passwordHash: 'hash-de-teste', termsVersion: 'teste', status: 'active' }
    });

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 409);

    // O 409 é lançado dentro da transação: o consumedAt do challenge é desfeito...
    const challenge = await prisma.emailVerification.findUnique({
        where: { id: pinResponse.data.challengeId }
    });
    assert.strictEqual(challenge.consumedAt, null);

    // ...e a user_auth ativa continua intacta.
    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.passwordHash, 'hash-de-teste');
});

test('register: retentativa com user_auth pending reaproveita o mesmo authUserId', async () => {
    const email = `teste-register-retentativa-${Date.now()}@example.com`;

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const firstPin = emailSender.sent.find((message) => message.to === email).text;

    const firstRegister = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: first.data.challengeId, pin: firstPin, password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' }
    );

    // Pede um PIN novo (passando do 429) e cadastra de novo com outra senha.
    await prisma.emailVerification.update({
        where: { id: first.data.challengeId },
        data: { createdAt: new Date(Date.now() - 61_000) }
    });
    const second = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const secondPin = emailSender.sent.findLast((message) => message.to === email).text;

    const secondRegister = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: second.data.challengeId, pin: secondPin, password: 'outra-senha-456', acceptedTerms: true, termsVersion: 'v2' }
    );

    assert.strictEqual(secondRegister.status, 201);
    assert.strictEqual(secondRegister.data.authUserId, firstRegister.data.authUserId);

    const userAuths = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuths, 1);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.termsVersion, 'v2');
    assert.ok(await argon2.verify(userAuth.passwordHash, 'outra-senha-456'));
});

after(async () => {
    await prisma.emailVerification.deleteMany({
        where: { email: { startsWith: 'teste-register-', endsWith: '@example.com' } }
    });
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-register-', endsWith: '@example.com' } }
    });
    server.close();
    await prisma.$disconnect();
});
