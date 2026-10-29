import { loginService, registerService } from "./user-auth.service.js";
import Joi from 'joi'
import { AppError } from "../lib/app-error.js";


const registerSchema = Joi.object({
    challengeId: Joi.string().guid().required(),
    name: Joi.string().trim().max(255).required(), // repassado ao back-end (tutors.name); o Auth não guarda
    pin: Joi.string().pattern(/^\d{6}$/).required(),
    password: Joi.string().required(), // TBD: tamanho mínimo/máximo (decisão da PO na https://dev.azure.com/escola-ti/Hospetse/_boards/board/t/Hospetse%20Team/Backlog%20items?System.AssignedTo=%40me&workitem=252)
    acceptedTerms: Joi.boolean().valid(true).required(),
    termsVersion: Joi.string().trim().max(64).required()
}).required();  // Contrato da API

export function createRegisterController(userProvisioner) {
    return async (req, res) => {

        const response = registerSchema.validate(req.body)

        if (response.error) {
            return res.status(400).json({ error: response.error.message })
        }

        try {
            const result = await registerService(response.value, userProvisioner);
            res.status(201).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({ error: error.message });
            }
            console.log(error.message)
            return res.status(500).json({ error: 'Não foi possível concluir o cadastro' });
        }

    }
}

const loginSchema = Joi.object({
    email: Joi.string().trim().email().lowercase().max(255).required(), // mesma normalização do request-pin
    password: Joi.string().required()
}).required();  // Contrato da API

export function createLoginController() {
    return async (req, res) => {

        const response = loginSchema.validate(req.body)

        if (response.error) {
            return res.status(400).json({ error: response.error.message })
        }

        try {
            const result = await loginService(response.value);
            res.status(200).json(result);
        } catch (error) {
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({ error: error.message });
            }
            console.log(error.message) // só a mensagem: senha e tokens nunca vão para o log
            return res.status(500).json({ error: 'Não foi possível fazer o login' });
        }
    }
}
