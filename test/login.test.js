import { after, test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import axios from 'axios';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';
import { FakeUserProvisioner } from '../src/user-provisioning/fake.user-provisioner.js';
import { verifyAccessToken } from '../src/lib/jwt.js';

const emailSender = new FakeEmailSender();
const userProvisioner = new FakeUserProvisioner();
const app = createApp({ emailSender, userProvisioner });
const server = app.listen(0);
const { port } = server.address();

// Prefixo próprio: o after() do request-pin apaga "teste-auth-*" e os arquivos rodam em paralelo.

const PASSWORD = 'senha-forte-123';

// cria a user_auth direto no banco, sem passar pelo cadastro, para testar só o login
async function createUserAuth(status = 'active') {
    return prisma.userAuth.create({
        data: {
            email: `teste-login-${crypto.randomUUID()}@example.com`,
            passwordHash: await argon2.hash(PASSWORD),
            termsVersion: 'v1',
            status
        }
    });
}

function login(body) {
    return axios.post(`http://localhost:${port}/api/v1/auth/login`, body, { validateStatus: () => true });
}

test('login: payload inválido retorna 400', async () => {
    const semSenha = await login({ email: 'teste-login-x@example.com' });
    const emailInvalido = await login({ email: 'nao-e-email', password: PASSWORD });

    assert.strictEqual(semSenha.status, 400);
    assert.strictEqual(emailInvalido.status, 400);
});

test('login: credenciais válidas retornam 200 com access token e refresh token', async () => {
    const userAuth = await createUserAuth();

    const response = await login({ email: userAuth.email, password: PASSWORD });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.tokenType, 'Bearer');
    assert.strictEqual(response.data.expiresIn, 900);

    // o token precisa ser válido e ter no sub a user_auth
    const { sub } = await verifyAccessToken(response.data.accessToken);
    assert.strictEqual(sub, userAuth.id);

    // o refresh token emitido no login funciona na rota de refresh
    const refresh = await axios.post(`http://localhost:${port}/api/v1/auth/refresh`, { refreshToken: response.data.refreshToken });
    assert.strictEqual(refresh.status, 200);
});

test('login: e-mail com maiúsculas e espaços é normalizado como no cadastro', async () => {
    const userAuth = await createUserAuth();

    const response = await login({ email: `  ${userAuth.email.toUpperCase()}  `, password: PASSWORD });

    assert.strictEqual(response.status, 200);
});

test('login: senha errada e e-mail inexistente retornam o mesmo 401', async () => {
    const userAuth = await createUserAuth();

    const senhaErrada = await login({ email: userAuth.email, password: 'senha-errada' });
    const emailInexistente = await login({ email: `teste-login-${crypto.randomUUID()}@example.com`, password: PASSWORD });

    assert.strictEqual(senhaErrada.status, 401);
    assert.strictEqual(emailInexistente.status, 401);
    // a mesma mensagem: o cliente não descobre quais e-mails têm conta
    assert.deepStrictEqual(senhaErrada.data, emailInexistente.data);
    assert.strictEqual(senhaErrada.data.accessToken, undefined);
});

test('login: conta pending_provisioning com a senha certa retorna 403 e nenhum token', async () => {
    const userAuth = await createUserAuth('pending_provisioning');

    const response = await login({ email: userAuth.email, password: PASSWORD });

    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.data.accessToken, undefined);
    const tokens = await prisma.refreshToken.count({ where: { userAuthId: userAuth.id } });
    assert.strictEqual(tokens, 0);
});

test('login: conta pending_provisioning com a senha errada retorna 401, sem revelar o cadastro', async () => {
    const userAuth = await createUserAuth('pending_provisioning');

    const response = await login({ email: userAuth.email, password: 'senha-errada' });

    assert.strictEqual(response.status, 401);
});

after(async () => {
    await prisma.userAuth.deleteMany({
        where: { email: { startsWith: 'teste-login-', endsWith: '@example.com' } }
    });
    server.close();
    await prisma.$disconnect();
});
