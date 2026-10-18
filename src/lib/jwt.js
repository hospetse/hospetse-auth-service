import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";

const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY, "RS256");
const publicKey = await importSPKI(process.env.JWT_PUBLIC_KEY, "RS256");
const ISSUER = "hospetse-auth-service";
const AUDIENCE = "hospetse-backend";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export async function signAccessToken(authUserId){
    return new SignJWT()
    .setProtectedHeader({alg: "RS256"})
    .setSubject(authUserId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey)
}

export async function verifyAccessToken(token){
    const { payload } = await jwtVerify(token, publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["RS256"],
    });
    return payload;
}