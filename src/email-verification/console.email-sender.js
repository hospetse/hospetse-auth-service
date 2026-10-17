import { EmailSender } from './email-sender.interface.js';

// Implementação de DEV: em vez de enviar, mostra o e-mail no terminal.
// Nunca usar em produção, porque o PIN aparece no log.
export class ConsoleEmailSender extends EmailSender {
    async send({ to, subject, text }) {
        console.log('[DEV EMAIL]', { to, subject, text });
    }
}
