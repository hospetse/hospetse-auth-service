import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { createApp } from '../src/app.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';

const app = createApp({ emailSender: new FakeEmailSender(), corsOrigins: ['http://localhost:8081'] });
const server = app.listen(0);
const { port } = server.address();
const url = `http://localhost:${port}/api/v1/auth/login`;

test('preflight de origem liberada recebe o header do CORS', async () => {
    const response = await axios.options(url, {
        headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers['access-control-allow-origin'], 'http://localhost:8081');
});

test('origem fora da lista não recebe o header do CORS', async () => {
    const response = await axios.options(url, {
        headers: { Origin: 'http://outra-origem.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
});

after(() => server.close());
