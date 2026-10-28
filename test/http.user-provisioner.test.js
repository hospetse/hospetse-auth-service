import { after, test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { HttpUserProvisioner } from '../src/user-provisioning/http.user-provisioner.js';

// Back-end fake: imita a rota interna. O authUserId escolhe a resposta, e `calls` conta as chamadas.
const SERVICE_TOKEN = 'token-de-servico-teste';
const calls = {};
let flakyCount = 0;

const backend = express();
backend.use(express.json());
backend.put('/api/v1/internal/users/:authUserId', (req, res) => {
    const { authUserId } = req.params;
    calls[authUserId] = (calls[authUserId] ?? 0) + 1;

    // Igual ao back-end real: sem o token de serviço certo, para aqui
    if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
        return res.sendStatus(401);
    }

    if (authUserId === 'criado') {
        return res.status(201).json(req.body);
    }
    if (authUserId === 'ja-existia') {
        return res.sendStatus(200);
    }
    if (authUserId === 'email-em-uso') {
        return res.sendStatus(409);
    }
    if (authUserId === 'instavel') {
        flakyCount++;
        return res.sendStatus(flakyCount < 3 ? 503 : 201);
    }
    if (authUserId === 'lento') {
        return setTimeout(() => res.sendStatus(201), 300);
    }
    return res.sendStatus(500);
});

const server = backend.listen(0);
const { port } = server.address();

// Timeout e espera curtos para o teste não demorar
const provisioner = new HttpUserProvisioner(`http://localhost:${port}`, SERVICE_TOKEN, { timeout: 100, retryDelayMs: 10 });

test('http-provisioner: 201 do back-end resolve sem erro e envia email e nome', async () => {
    await provisioner.provision({ authUserId: 'criado', email: 'tutor@example.com', name: 'Tutor Teste' });

    assert.strictEqual(calls['criado'], 1);
});

test('http-provisioner: 200 (USER já existia) também resolve sem erro', async () => {
    await provisioner.provision({ authUserId: 'ja-existia', email: 'tutor@example.com', name: 'Tutor Teste' });

    assert.strictEqual(calls['ja-existia'], 1);
});

test('http-provisioner: 409 vira AppError 409 e não repete', async () => {
    await assert.rejects(
        provisioner.provision({ authUserId: 'email-em-uso', email: 'tutor@example.com', name: 'Tutor Teste' }),
        { statusCode: 409 }
    );

    assert.strictEqual(calls['email-em-uso'], 1);
});

test('http-provisioner: token de serviço errado recebe 401, vira 503 e não repete', async () => {
    const wrongToken = new HttpUserProvisioner(`http://localhost:${port}`, 'token-errado', { timeout: 100, retryDelayMs: 10 });

    await assert.rejects(
        wrongToken.provision({ authUserId: 'token-invalido', email: 'tutor@example.com', name: 'Tutor Teste' }),
        { statusCode: 503 }
    );

    assert.strictEqual(calls['token-invalido'], 1);
});

test('http-provisioner: 500 repete 3 vezes e depois vira 503', async () => {
    await assert.rejects(
        provisioner.provision({ authUserId: 'erro-interno', email: 'tutor@example.com', name: 'Tutor Teste' }),
        { statusCode: 503 }
    );

    assert.strictEqual(calls['erro-interno'], 3);
});

test('http-provisioner: falha passageira é resolvida pelo retry', async () => {
    await provisioner.provision({ authUserId: 'instavel', email: 'tutor@example.com', name: 'Tutor Teste' });

    assert.strictEqual(calls['instavel'], 3);
});

test('http-provisioner: timeout repete 3 vezes e depois vira 503', async () => {
    await assert.rejects(
        provisioner.provision({ authUserId: 'lento', email: 'tutor@example.com', name: 'Tutor Teste' }),
        { statusCode: 503 }
    );

    assert.strictEqual(calls['lento'], 3);
});

test('http-provisioner: back-end fora do ar vira 503', async () => {
    // Porta 1: ninguém escuta, a conexão é recusada (ECONNREFUSED)
    const offline = new HttpUserProvisioner('http://localhost:1', SERVICE_TOKEN, { retryDelayMs: 10 });

    await assert.rejects(
        offline.provision({ authUserId: 'qualquer', email: 'tutor@example.com', name: 'Tutor Teste' }),
        { statusCode: 503 }
    );
});

after(() => {
    server.close();
});
