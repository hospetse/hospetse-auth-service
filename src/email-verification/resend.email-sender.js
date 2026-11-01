import axios from "axios";
import { EmailSender } from './email-sender.interface.js';
import { AppError } from '../lib/app-error.js';

// Implementação real: envia pela API HTTP do Resend (POST /emails)
export class ResendEmailSender extends EmailSender {
    // timeout menor que o da transação do requestPinService (10 s), senão a transação estoura antes.
    // baseUrl só para os testes apontarem para um Resend fake; o index.js usa o padrão
    constructor(apiKey, from, { timeout = 5000, baseUrl = 'https://api.resend.com' } = {}) {
        super();
        this.from = from;
        this.http = axios.create({
            baseURL: baseUrl,
            timeout,
            headers: { Authorization: `Bearer ${apiKey}` },
        });
    }

    async send({ to, subject, text }) {
        try {
            await this.http.post('/emails', { from: this.from, to, subject, text });
        } catch (error) {
            // só status ou código no log: destinatário e texto (com o PIN) ficam de fora
            console.log(`Falha ao enviar e-mail pelo Resend: ${error.response?.status ?? error.code}`);
            // sem retry: enviar e-mail não é idempotente, repetir depois de um timeout pode mandar 2 PINs
            throw new AppError("Não foi possível enviar o código. Tente novamente", 503);
        }
    }
}
