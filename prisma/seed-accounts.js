// Contrato da #497 e da #498: manter UUIDs e e-mails iguais no seed do Auth.
// role: 'host' (#498) marca as contas que recebem prestador no back-end.
export const accounts = [
    { id: '49700000-0000-4000-8000-000000000001', email: 'admin@hospetse.dev', name: 'Administrador Demonstração', accountType: 'admin', profileStatus: 'incomplete' },
    { id: '49700000-0000-4000-8000-000000000002', email: 'tutor.completo@hospetse.dev', name: 'Tutor Completo Demonstração', accountType: 'user', profileStatus: 'complete' },
    { id: '49700000-0000-4000-8000-000000000003', email: 'tutor.incompleto@hospetse.dev', name: 'Tutor Incompleto Demonstração', accountType: 'user', profileStatus: 'incomplete' },
    { id: '49800000-0000-4000-8000-000000000001', email: 'host.aberto@hospetse.dev', name: 'Host Aberto Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
    { id: '49800000-0000-4000-8000-000000000002', email: 'host.caes@hospetse.dev', name: 'Host Cães Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
    { id: '49800000-0000-4000-8000-000000000003', email: 'host.gatos@hospetse.dev', name: 'Host Gatos Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
    { id: '49800000-0000-4000-8000-000000000004', email: 'host.racas@hospetse.dev', name: 'Host Raças Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
    { id: '49800000-0000-4000-8000-000000000005', email: 'host.pendente@hospetse.dev', name: 'Host Pendente Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
    { id: '49800000-0000-4000-8000-000000000006', email: 'host.inativo@hospetse.dev', name: 'Host Inativo Demonstração', accountType: 'user', profileStatus: 'incomplete', role: 'host' },
];
