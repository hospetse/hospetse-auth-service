import { after, test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import axios from 'axios';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { FakeUserProvisioner } from '../src/user-provisioning/fake.user-provisioner.js';

// Segurança e sessão a partir do login (#301): o login.test.js cobre as respostas da rota,
// e aqui ficam o que liga login e refresh, os logs e o tempo de resposta.

const app = createApp({ emailSender: new FakeEmailSender(), userProvisioner: new FakeUserProvisioner() });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

const PASSWORD = 'senha-forte-123';

// cria a user_auth direto no banco, sem passar pelo cadastro
async function createUserAuth() {
    return prisma.userAuth.create({
        data: {
            email: `teste-loginflow-${crypto.randomUUID()}@example.com`,
            passwordHash: await argon2.hash(PASSWORD),
            termsVersion: 'v1',
            status: 'active'
        }
    });
}

function post(path, body) {
    return axios.post(`http://localhost:${port}/api/v1/auth/${path}`, body, { validateStatus: () => true });
}

const login = (email, password = PASSWORD) => post('login', { email, password });
const refresh = (refreshToken) => post('refresh', { refreshToken });

test('sessão: o refresh token do login renova e é rotacionado a cada uso', async () => {
    const { email } = await createUserAuth();
    const session = (await login(email)).data;

    const renewed = await refresh(session.refreshToken);
    assert.strictEqual(renewed.status, 200);
    assert.notStrictEqual(renewed.data.refreshToken, session.refreshToken);

    // o novo continua renovando
    const again = await refresh(renewed.data.refreshToken);
    assert.strictEqual(again.status, 200);
});

test('sessão: dois logins são duas sessões, e renovar uma não derruba a outra', async () => {
    const { email } = await createUserAuth();
    const phone = (await login(email)).data;
    const laptop = (await login(email)).data;

    assert.strictEqual((await refresh(phone.refreshToken)).status, 200);
    assert.strictEqual((await refresh(laptop.refreshToken)).status, 200);
});

test('sessão: reuso de um refresh token rotacionado derruba todas as sessões da conta', async () => {
    const userAuth = await createUserAuth();
    const phone = (await login(userAuth.email)).data;
    const laptop = (await login(userAuth.email)).data;

    const renewed = await refresh(phone.refreshToken);
    assert.strictEqual(renewed.status, 200);

    // alguém apresenta de novo o token já rotacionado: é uma cópia
    assert.strictEqual((await refresh(phone.refreshToken)).status, 401);

    // as duas sessões caem, inclusive a do outro aparelho; a senha volta a ser necessária
    assert.strictEqual((await refresh(renewed.data.refreshToken)).status, 401);
    assert.strictEqual((await refresh(laptop.refreshToken)).status, 401);
    const active = await prisma.refreshToken.count({ where: { userAuthId: userAuth.id, revokedAt: null } });
    assert.strictEqual(active, 0);

    // o dono loga de novo normalmente
    assert.strictEqual((await login(userAuth.email)).status, 200);
});

test('logs: senha, tokens e e-mail não aparecem durante logins com sucesso e com erro', async () => {
    const { email } = await createUserAuth();

    const logged = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logged.push(args.map(String).join(' '));
    console.error = (...args) => logged.push(args.map(String).join(' '));

    let tokens;
    try {
        tokens = (await login(email)).data;
        await login(email, 'senha-errada-456');
        await login(`teste-loginflow-${crypto.randomUUID()}@example.com`);
        await refresh(tokens.refreshToken);
        await refresh(tokens.refreshToken); // reuso
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }

    for (const secret of [PASSWORD, 'senha-errada-456', tokens.accessToken, tokens.refreshToken, email]) {
        assert.ok(logged.every((line) => !line.includes(secret)), 'dado sensível encontrado no log');
    }
});

// Medir o tempo não serve: com o banco remoto, a latência da consulta é maior que o argon2.verify e esconde a diferença.
// O que importa é o verify rodar também quando a conta não existe, então o teste confere a chamada.
test('tempo: e-mail inexistente também roda o argon2.verify, como a senha errada', async (t) => {
    const verify = t.mock.method(argon2, 'verify');

    const response = await login(`teste-loginflow-${crypto.randomUUID()}@example.com`);

    assert.strictEqual(response.status, 401);
    assert.strictEqual(verify.mock.callCount(), 1);
});

after(async () => {
    // o refresh_token sai junto (onDelete: Cascade)
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-loginflow-', endsWith: '@example.com' } }
    });
    server.close();
    await prisma.$disconnect();
});
