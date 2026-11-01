import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';
import { accounts } from '../prisma/seed-accounts.js';

test('seed #497: login, idempotência, revogação e rollback', { skip: !process.env.SEED_TEST_DATABASE_URL }, async t => {
    const url = new URL(process.env.SEED_TEST_DATABASE_URL);
    assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.endsWith('_seed_test'), 'Use banco local descartável terminado em _seed_test.');
    process.env.DATABASE_URL = url.href;
    const { prisma } = await import('../src/lib/prisma.js');
    assert.equal(await prisma.userAuth.count(), 0, 'O teste exige banco vazio.');
    t.after(async () => {
        await prisma.userAuth.deleteMany({ where: { id: { in: accounts.map(a => a.id) } } });
        await prisma.$disconnect();
    });
    const passwords = { SEED_ADMIN_PASSWORD: randomUUID(), SEED_TUTOR_PASSWORD: randomUUID() };
    const seed = (extra = {}) => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'seed'], {
        env: { ...process.env, ...passwords, ...extra }, encoding: 'utf8',
    });
    assert.equal(seed({ SEED_ADMIN_PASSWORD: '' }).status, 1);
    assert.equal(await prisma.userAuth.count(), 0);
    const initial = seed();
    assert.equal(initial.status, 0, 'Primeira execução falhou.');
    for (const password of Object.values(passwords)) assert(!`${initial.stdout}${initial.stderr}`.includes(password));
    const first = await prisma.userAuth.findMany({ orderBy: { id: 'asc' } });
    assert.equal(first.length, accounts.length);
    assert(first.every(user => user.status === 'active'));

    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
    process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
    const { createApp } = await import('../src/app.js');
    const { FakeEmailSender } = await import('../src/email-verification/fake.email-sender.js');
    const { FakeUserProvisioner } = await import('../src/user-provisioning/fake.user-provisioner.js');
    const { verifyAccessToken } = await import('../src/lib/jwt.js');
    const server = createApp({ emailSender: new FakeEmailSender(), userProvisioner: new FakeUserProvisioner() }).listen(0);
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const refreshTokens = [];
    for (const account of accounts) {
        const response = await fetch(`http://localhost:${server.address().port}/api/v1/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: account.email, password: account.accountType === 'admin' ? passwords.SEED_ADMIN_PASSWORD : passwords.SEED_TUTOR_PASSWORD }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal((await verifyAccessToken(body.accessToken)).sub, account.id);
        refreshTokens.push(body.refreshToken);
    }
    assert.equal(seed().status, 0, 'Segunda execução falhou.');
    const second = await prisma.userAuth.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(second.map(user => [user.id, user.provisionedAt]), first.map(user => [user.id, user.provisionedAt]));
    assert.equal(await prisma.refreshToken.count({ where: { revokedAt: null } }), 0);
    for (const refreshToken of refreshTokens) {
        const response = await fetch(`http://localhost:${server.address().port}/api/v1/auth/refresh`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
        });
        assert.equal(response.status, 401);
    }
    await prisma.userAuth.update({ where: { id: accounts[2].id }, data: { email: 'conflito-seed@example.com' } });
    const before = await prisma.userAuth.findMany({ orderBy: { id: 'asc' } });
    assert.equal(seed().status, 1);
    const after = await prisma.userAuth.findMany({ orderBy: { id: 'asc' } });
    assert(after.every((user, index) => user.passwordHash === before[index].passwordHash && user.updatedAt.getTime() === before[index].updatedAt.getTime()), 'Conflito não pode alterar senhas nem contas anteriores.');
    await prisma.userAuth.update({ where: { id: accounts[2].id }, data: { email: accounts[2].email, termsVersion: 'v1' } });
    assert.equal(seed().status, 1, 'Não pode assumir conta que não pertence ao seed.');
});
