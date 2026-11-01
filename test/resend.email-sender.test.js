import { after, test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { ResendEmailSender } from '../src/email-verification/resend.email-sender.js';

// Resend fake: imita o POST /emails. O destinatário escolhe a resposta, e `received` guarda o que chegou.
const API_KEY = 're_teste';
const FROM = 'Hospetse <no-reply@hospetse.com.br>';
const received = [];

const resend = express();
resend.use(express.json());
resend.post('/emails', (req, res) => {
    received.push(req.body);

    // Igual ao Resend real: chave errada responde 401
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        return res.sendStatus(401);
    }
    if (req.body.to === 'invalido@example.com') {
        return res.sendStatus(422);
    }
    if (req.body.to === 'fora@example.com') {
        return res.sendStatus(500);
    }
    if (req.body.to === 'lento@example.com') {
        return setTimeout(() => res.status(200).json({ id: 'lento' }), 300);
    }
    return res.status(200).json({ id: 'email-id' });
});

const server = resend.listen(0);
const baseUrl = `http://localhost:${server.address().port}`;

// Timeout curto para o teste não demorar
const sender = new ResendEmailSender(API_KEY, FROM, { timeout: 100, baseUrl });

const message = { subject: 'Assunto', text: 'Seu código é 123456' };

test('resend-sender: 200 resolve e envia from, to, subject e text', async () => {
    await sender.send({ to: 'tutor@example.com', ...message });

    assert.deepStrictEqual(received.at(-1), { from: FROM, to: 'tutor@example.com', ...message });
});

test('resend-sender: chave errada (401) vira AppError 503', async () => {
    const wrongKey = new ResendEmailSender('re_errada', FROM, { timeout: 100, baseUrl });

    await assert.rejects(
        wrongKey.send({ to: 'tutor@example.com', ...message }),
        { statusCode: 503 },
    );
});

test('resend-sender: 422 e 500 viram AppError 503 e não repetem', async () => {
    for (const to of ['invalido@example.com', 'fora@example.com']) {
        const before = received.length;

        await assert.rejects(sender.send({ to, ...message }), { statusCode: 503 });
        assert.strictEqual(received.length, before + 1);
    }
});

test('resend-sender: timeout vira AppError 503', async () => {
    await assert.rejects(
        sender.send({ to: 'lento@example.com', ...message }),
        { statusCode: 503 },
    );
});

after(() => {
    server.closeAllConnections();
    server.close();
});
