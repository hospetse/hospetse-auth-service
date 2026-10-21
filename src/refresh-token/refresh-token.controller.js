import { refreshService } from "./refresh-token.service.js";
import Joi from 'joi'
import { AppError } from "../lib/app-error.js";


const refreshTokenSchema = Joi.object({
    refreshToken: Joi.string().base64({ urlSafe: true, paddingRequired: false }).required() // base64url, sem "="
}).required();  // Contrato da API

export function createRefreshController() {
    return async (req, res) => {

        const response = refreshTokenSchema.validate(req.body)

        if (response.error) {
            return res.status(400).json({ error: response.error.message })
        }

        try {
            const result = await refreshService(response.value.refreshToken);
            res.status(200).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({ error: error.message });
            }
            console.log(error.message) // só a mensagem: o refresh token nunca vai para o log
            return res.status(500).json({ error: 'Não foi possível renovar o token' });
        }
    }
}
