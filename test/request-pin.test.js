import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { EmailSender } from '../src/email-verification/email-sender.interface.js';

const emailSender = new FakeEmailSender();
const app = createApp({ emailSender });
const server = app.listen(0);
const { port } = server.address();

// Sender que sempre falha, para testar o rollback da transação.
class FailingEmailSender extends EmailSender {
    async send() {
        throw new Error('Falha simulada no envio');
    }
}

const failingApp = createApp({ emailSender: new FailingEmailSender() });
const failingServer = failingApp.listen(0);
const failingPort = failingServer.address().port;

test('request-pin: e-mail inválido retorna 400 e não envia e-mail', async () => {
    const response = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email: 'nao-e-email' },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 400);
    assert.strictEqual(emailSender.sent.length, 0);
});

test('request-pin: e-mail válido retorna 201 com challengeId e envia o PIN', async () => {
    const email = `teste-auth-${Date.now()}@example.com`;

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );

    assert.strictEqual(response.status, 201);
    assert.ok(response.data.challengeId);
    assert.strictEqual(response.data.pin, undefined);

    const message = emailSender.sent[0];
    assert.strictEqual(message.to, email);
    assert.match(message.text, /\d{6}/);

    const challenge = await prisma.emailVerification.findUnique({
        where: { id: response.data.challengeId }
    });
    assert.strictEqual(challenge.email, email);
    assert.notStrictEqual(challenge.pinHash, message.text);
});

test('request-pin: pedir de novo antes de 60 s retorna 429 e não envia outro e-mail', async () => {
    const email = `teste-auth-429-${Date.now()}@example.com`;

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    assert.strictEqual(first.status, 201);
    const sentBefore = emailSender.sent.length;

    const second = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email },
        { validateStatus: () => true }
    );

    assert.strictEqual(second.status, 429);
    assert.strictEqual(emailSender.sent.length, sentBefore);

    const challenges = await prisma.emailVerification.count({ where: { email } });
    assert.strictEqual(challenges, 1);
});

test('request-pin: reenvio depois do intervalo invalida o PIN anterior', async () => {
    const email = `teste-auth-reenvio-${Date.now()}@example.com`;

    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );

    // "Envelhece" o primeiro pedido para 61 s atrás, sem precisar esperar.
    await prisma.emailVerification.update({
        where: { id: first.data.challengeId },
        data: { createdAt: new Date(Date.now() - 61_000) }
    });

    const second = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    assert.strictEqual(second.status, 201);
    assert.notStrictEqual(second.data.challengeId, first.data.challengeId);

    const oldChallenge = await prisma.emailVerification.findUnique({
        where: { id: first.data.challengeId }
    });
    const newChallenge = await prisma.emailVerification.findUnique({
        where: { id: second.data.challengeId }
    });
    assert.ok(oldChallenge.invalidatedAt);
    assert.strictEqual(newChallenge.invalidatedAt, null);
});

test('request-pin: falha no envio retorna 500 e desfaz a transação', async () => {
    const email = `teste-auth-rollback-${Date.now()}@example.com`;

    // PIN anterior aberto e "velho", para o próximo pedido passar do 429.
    const first = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );
    await prisma.emailVerification.update({
        where: { id: first.data.challengeId },
        data: { createdAt: new Date(Date.now() - 61_000) }
    });

    const response = await axios.post(`http://localhost:${failingPort}/api/v1/auth/request-pin`,
        { email },
        { validateStatus: () => true }
    );
    assert.strictEqual(response.status, 500);

    // Nenhuma linha nova ficou gravada (o create foi desfeito)...
    const challenges = await prisma.emailVerification.count({ where: { email } });
    assert.strictEqual(challenges, 1);

    // ...e o PIN anterior continua aberto (o updateMany também foi desfeito).
    const oldChallenge = await prisma.emailVerification.findUnique({
        where: { id: first.data.challengeId }
    });
    assert.strictEqual(oldChallenge.invalidatedAt, null);
});

test('request-pin: e-mail com user_auth ativa retorna 409 e não envia e-mail', async () => {
    const email = `teste-auth-409-${Date.now()}@example.com`;

    await prisma.userAuth.create({
        data: { email, passwordHash: 'hash-de-teste', termsVersion: 'teste', status: 'active' }
    });
    const sentBefore = emailSender.sent.length;

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email },
        { validateStatus: () => true }
    );

    assert.strictEqual(response.status, 409);
    assert.strictEqual(emailSender.sent.length, sentBefore);

    const challenges = await prisma.emailVerification.count({ where: { email } });
    assert.strictEqual(challenges, 0);
});

test('request-pin: e-mail com user_auth pending_provisioning pode pedir PIN (retentativa)', async () => {
    const email = `teste-auth-pending-${Date.now()}@example.com`;

    await prisma.userAuth.create({
        data: { email, passwordHash: 'hash-de-teste', termsVersion: 'teste', status: 'pending_provisioning' }
    });

    const response = await axios.post(`http://localhost:${port}/api/v1/auth/request-pin`,
        { email }
    );

    assert.strictEqual(response.status, 201);
    assert.ok(response.data.challengeId);
});

after(async () => {
    await prisma.emailVerification.deleteMany({
        where: { email: { startsWith: 'teste-auth-', endsWith: '@example.com' } }
    });
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-auth-', endsWith: '@example.com' } }
    });
    server.close();
    failingServer.close();
    await prisma.$disconnect();
});
