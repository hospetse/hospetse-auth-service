import { EmailSender } from './email-sender.interface.js';

// Implementação para TESTES: não envia nada, só guarda as mensagens.
// O teste lê `sent` para conferir o que foi enviado (inclusive o PIN).
export class FakeEmailSender extends EmailSender {
    constructor() {
        super();
        this.sent = [];
    }

    async send(message) {
        this.sent.push(message);
    }
}
