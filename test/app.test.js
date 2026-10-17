import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { FakeEmailSender } from '../src/email-verification/fake.email-sender.js';

const emailSender = new FakeEmailSender();
const app = createApp({ emailSender });
const server = app.listen(0);
const { port } = server.address();

test('Check /health route', async () => {
    const response = await axios.get(`http://localhost:${port}/health`);
    assert.strictEqual(response.status, 200);

});

test('Check /health JSON response route', async () => {
    const response = await axios.get(`http://localhost:${port}/health`);
    assert.strictEqual(response.data.server, "Server is running")
    assert.strictEqual(response.data.db, "Database is running")
});

after( async ()=>{
    server.close();
    await prisma.$disconnect();
})