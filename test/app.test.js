import { after, test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import app from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
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