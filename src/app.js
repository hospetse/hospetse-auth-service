import { prisma } from "./lib/prisma.js";
import express from "express";

const app = express();

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

export default app