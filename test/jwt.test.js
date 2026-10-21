import { test } from 'node:test';
import assert from 'node:assert';
import { decodeJwt, decodeProtectedHeader, generateKeyPair, importPKCS8, SignJWT, UnsecuredJWT } from 'jose';
import { signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../src/lib/jwt.js';

// Testes do access token sem banco: claims definidos (ADR-012) e o que o verify precisa recusar.
// O back-end principal valida do mesmo jeito, só com a chave pública.

const authUserId = '3f2b6c1e-8a4d-4e7b-9c1a-2d5e6f7a8b9c';

// assina um token com os mesmos claims do Auth, mas com a chave e o alg que o teste escolher
function forge(claims = {}) {
    return new SignJWT({ ...claims })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setIssuedAt()
        .setExpirationTime('900s');
}

test('jwt: access token tem só os claims definidos, sem dados pessoais', async () => {
    const token = await signAccessToken(authUserId);

    assert.deepStrictEqual(decodeProtectedHeader(token), { alg: 'RS256' });

    const payload = decodeJwt(token);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
    assert.strictEqual(payload.sub, authUserId);
    assert.strictEqual(payload.iss, 'hospetse-auth-service');
    assert.strictEqual(payload.aud, 'hospetse-backend');
    assert.strictEqual(payload.exp - payload.iat, ACCESS_TOKEN_TTL_SECONDS);
    assert.strictEqual(ACCESS_TOKEN_TTL_SECONDS, 900);
});

test('jwt: token válido passa no verify e devolve o sub', async () => {
    const token = await signAccessToken(authUserId);

    const payload = await verifyAccessToken(token);

    assert.strictEqual(payload.sub, authUserId);
});

test('jwt: payload adulterado é recusado (assinatura não confere)', async () => {
    const token = await signAccessToken(authUserId);
    const [header, , signature] = token.split('.');
    const payload = { ...decodeJwt(token), sub: 'outro-usuario' };
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    await assert.rejects(verifyAccessToken(tampered), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
});

test('jwt: token assinado com outra chave privada é recusado', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await forge().setProtectedHeader({ alg: 'RS256' }).sign(privateKey);

    await assert.rejects(verifyAccessToken(token), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
});

test('jwt: token sem assinatura (alg none) é recusado', async () => {
    const token = new UnsecuredJWT({})
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setIssuedAt()
        .setExpirationTime('900s')
        .encode();

    await assert.rejects(verifyAccessToken(token));
});

test('jwt: token HS256 assinado com a chave pública como segredo é recusado', async () => {
    // ataque clássico: quem tem a chave pública tenta usá-la como segredo do HMAC
    const secret = new TextEncoder().encode(process.env.JWT_PUBLIC_KEY);
    const token = await forge().setProtectedHeader({ alg: 'HS256' }).sign(secret);

    await assert.rejects(verifyAccessToken(token));
});

// os próximos usam a chave privada real do Auth: a assinatura confere, então quem recusa são os claims
const authPrivateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY, 'RS256');

test('jwt: token expirado é recusado', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setIssuedAt(now - 1000)
        .setExpirationTime(now - 100)
        .sign(authPrivateKey);

    await assert.rejects(verifyAccessToken(expired), { code: 'ERR_JWT_EXPIRED' });
});

test('jwt: token com aud de outro serviço é recusado', async () => {
    // ex.: o token de serviço da rota interna (aud próprio) não vale como token de usuário
    const token = await forge().setAudience('hospetse-backend-internal').setProtectedHeader({ alg: 'RS256' }).sign(authPrivateKey);

    await assert.rejects(verifyAccessToken(token), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
});

test('jwt: token com iss diferente é recusado', async () => {
    const token = await forge().setIssuer('outro-emissor').setProtectedHeader({ alg: 'RS256' }).sign(authPrivateKey);

    await assert.rejects(verifyAccessToken(token), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
});
