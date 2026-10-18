import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { FakeUserProvisioner } from '../src/user-provisioning/fake.user-provisioner.js';
import { AppError } from '../src/lib/app-error.js';

const emailSender = new FakeEmailSender();
const userProvisioner = new FakeUserProvisioner();
const app = createApp({ emailSender, userProvisioner });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

test('register: payload inválido retorna 400', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: 'nao-e-uuid', pin: '12', password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
    assert.ok(response.data.error);
});

test('register: termos não aceitos retorna 400', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: crypto.randomUUID(), pin: '123456', password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: false, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
});

test('register: sem nome retorna 400', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: crypto.randomUUID(), pin: '123456', password: 'senha-forte-123', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
});

test('register: challenge inexistente retorna 404', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: crypto.randomUUID(), pin: '123456', password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 404);
});

test('register: PIN e payload válidos criam o USER no back-end, ativam a user_auth e retornam 201', async () => {
    const email = `teste-register-${Date.now()}@example.com`;
    const password = 'senha-forte-123';

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password, name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' }
    );

    assert.strictEqual(response.status, 201);
    assert.ok(response.data.authUserId);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.id, response.data.authUserId);
    assert.strictEqual(userAuth.status, 'active');
    assert.ok(userAuth.provisionedAt);
    assert.strictEqual(userAuth.termsVersion, 'v1');

    // O back-end recebe só authUserId, e-mail e nome (nunca a senha).
    const provisioned = userProvisioner.provisioned.find((user) => user.email === email);
    assert.deepStrictEqual(provisioned, { authUserId: userAuth.id, email, name: 'Tutor Teste' });
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
        { challengeId: pinResponse.data.challengeId, pin: wrongPin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
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
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
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
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
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
        { challengeId: first.data.challengeId, pin: firstPin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
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
    const body = { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' };

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
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
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

test('register: back-end responde 409 retorna 409 e a user_auth fica pending', async () => {
    const email = `teste-register-backend-409-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;

    userProvisioner.error = new AppError("E-mail já cadastrado", 409);
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );
    userProvisioner.error = null;

    assert.strictEqual(response.status, 409);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.status, 'pending_provisioning');
    assert.strictEqual(userAuth.provisionedAt, null);
});

test('register: retentativa depois de falha no back-end reaproveita o mesmo authUserId e ativa', async () => {
    const email = `teste-register-retentativa-${Date.now()}@example.com`;

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const firstPin = emailSender.sent.find((message) => message.to === email).text;

    // Primeira tentativa: back-end fora (503). A user_auth fica pending.
    userProvisioner.error = new AppError("Não foi possível concluir o cadastro. Tente novamente", 503);
    const firstRegister = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        { challengeId: first.data.challengeId, pin: firstPin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' },
        { validateStatus: () => true }
    );
    userProvisioner.error = null;

    assert.strictEqual(firstRegister.status, 503);
    const pending = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(pending.status, 'pending_provisioning');

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
        { challengeId: second.data.challengeId, pin: secondPin, password: 'outra-senha-456', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v2' }
    );

    assert.strictEqual(secondRegister.status, 201);
    assert.strictEqual(secondRegister.data.authUserId, pending.id);

    const userAuths = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuths, 1);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.status, 'active');
    assert.strictEqual(userAuth.termsVersion, 'v2');
    assert.ok(await argon2.verify(userAuth.passwordHash, 'outra-senha-456'));
});

test('register: retentativa com o mesmo challenge depois de falha no back-end retorna 201', async () => {
    const email = `teste-register-mesmo-challenge-${Date.now()}@example.com`;

    const pinResponse = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    const pin = emailSender.sent.find((message) => message.to === email).text;
    const body = { challengeId: pinResponse.data.challengeId, pin, password: 'senha-forte-123', name: 'Tutor Teste', acceptedTerms: true, termsVersion: 'v1' };

    // Primeira tentativa: back-end fora. O challenge é consumido e a user_auth fica pending.
    userProvisioner.error = new AppError("Não foi possível concluir o cadastro. Tente novamente", 503);
    const first = await axios.post(`http://localhost:${port}/api/v1/auth/register`,
        body,
        { validateStatus: () => true }
    );
    userProvisioner.error = null;
    assert.strictEqual(first.status, 503);

    // "Tentar de novo" do front: mesmo challenge e PIN, sem pedir PIN novo.
    const second = await axios.post(`http://localhost:${port}/api/v1/auth/register`, body);

    assert.strictEqual(second.status, 201);

    const userAuths = await prisma.userAuth.count({ where: { email } });
    assert.strictEqual(userAuths, 1);

    const userAuth = await prisma.userAuth.findUnique({ where: { email } });
    assert.strictEqual(userAuth.id, second.data.authUserId);
    assert.strictEqual(userAuth.status, 'active');
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
