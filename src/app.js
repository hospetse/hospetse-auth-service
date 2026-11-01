import { createRequestPinController } from "./email-verification/email-verification.controller.js";
import { prisma } from "./lib/prisma.js";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { createLoginController, createRegisterController } from "./user-auth/user-auth.controller.js";
import { createRefreshController } from "./refresh-token/refresh-token.controller.js";

export function createApp({ emailSender, userProvisioner, corsOrigins = [] }) {
    const app = express();

    // CORS (#516): só as origens do CORS_ORIGINS chamam o Auth pelo navegador
    app.use(cors({ origin: corsOrigins }));
    app.use(express.json());

    app.get('/health', async (req, res) => {
        try {
            const response = await prisma.$queryRaw`SELECT 67`;
            res.status(200).json(
                {
                    "server": "Server is running",
                    "db": "Database is running"
                });
            console.log("/health");
            console.log(response)
        } catch (error) {
            res.status(503).json(
                { "message": "Database is down for some reason bro" }
            )
            console.error(error);
        }
    });

    // Documentação da API (#501): página do Swagger UI e o contrato que ela lê
    const docsDir = fileURLToPath(new URL('../docs/', import.meta.url));
    app.get('/docs', (req, res) => res.sendFile('index.html', { root: docsDir }));
    app.get('/docs/openapi.yaml', (req, res) => res.type('text/yaml').sendFile('openapi.yaml', { root: docsDir }));

    app.post('/api/v1/auth/request-pin', createRequestPinController(emailSender));
    app.post('/api/v1/auth/register', createRegisterController(userProvisioner));
    app.post('/api/v1/auth/refresh', createRefreshController());
    app.post('/api/v1/auth/login', createLoginController());
    return app
}

