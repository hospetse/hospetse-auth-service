import axios from 'axios';
import { UserProvisioner } from './user-provisioner.interface.js';
import { AppError } from '../lib/app-error.js';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

// Implementação real: cria o USER no back-end principal pela rota interna (PUT idempotente).
export class HttpUserProvisioner extends UserProvisioner {
    // options só para os testes deixarem tudo mais rápido; o index.js usa os padrões
    constructor(baseUrl, { timeout = 3000, maxAttempts = 3, retryDelayMs = 200 } = {}) {
        super();
        this.http = axios.create({ baseURL: baseUrl, timeout });
        this.maxAttempts = maxAttempts;
        this.retryDelayMs = retryDelayMs;
    }

    async provision({ authUserId, email, name }) {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                // 201 (criou agora) e 200 (já existia) passam direto: o axios só lança erro fora de 2xx
                await this.http.put(`/api/v1/internal/users/${authUserId}`, { email, name });
                return;
            } catch (error) {
                // error.response só existe se o back-end respondeu; em timeout ou back-end fora ele é undefined
                const status = error.response?.status;

                if (status === 409) {
                    throw new AppError("E-mail já cadastrado", 409);
                }

                // 401, 5xx, timeout (ECONNABORTED) ou back-end fora (ECONNREFUSED). Sem e-mail e nome no log
                console.log(`Falha ao provisionar o USER ${authUserId} no back-end (tentativa ${attempt}/${this.maxAttempts}): ${status ?? error.code}`);

                // repetir só adianta em falha passageira: 5xx ou sem resposta. 401 e 4xx dariam o mesmo erro de novo
                const isTransient = !status || status >= 500;
                if (!isTransient || attempt === this.maxAttempts) {
                    throw new AppError("Não foi possível concluir o cadastro. Tente novamente", 503);
                }

                // espera cresce a cada tentativa (200 ms, 400 ms) para dar tempo do back-end voltar
                await wait(this.retryDelayMs * attempt);
            }
        }
    }
}
