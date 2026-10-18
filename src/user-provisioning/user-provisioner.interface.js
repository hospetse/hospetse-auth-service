export class UserProvisioner {
    // eslint-disable-next-line no-unused-vars
    async provision({ authUserId, email, name }) {
        throw new Error(`${this.constructor.name} não implementou provision()`);
    }
}
