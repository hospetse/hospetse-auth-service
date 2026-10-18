import { UserProvisioner } from './user-provisioner.interface.js';

// Implementação para TESTES: não chama o back-end, só guarda as chamadas.
// O teste lê `provisioned` para conferir o que foi enviado e pode definir `error` para simular uma falha.
export class FakeUserProvisioner extends UserProvisioner {
    constructor() {
        super();
        this.provisioned = [];
        this.error = null;
    }

    async provision(user) {
        this.provisioned.push(user);
        if (this.error) {
            throw this.error;
        }
    }
}
