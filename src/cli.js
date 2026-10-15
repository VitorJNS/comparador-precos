// Uso pela linha de comando:
//   npm run coletar         -> roda uma coleta agora (sem abrir o painel)
//   npm run testar-email    -> envia o resumo atual por e-mail para quem administra

import { runCollection } from './collector.js';
import { listUsers } from './db.js';
import { sendSummaryEmail } from './notifier.js';

if (process.argv.includes('--testar-email')) {
  const admin = (await listUsers()).find((u) => u.isAdmin);
  if (!admin) throw new Error('Nenhuma pessoa cadastrada: defina ADMIN_EMAIL (ou SMTP_USER) e abra o painel uma vez');
  await sendSummaryEmail(admin);
  console.log(`E-mail de teste enviado para ${admin.email}.`);
} else {
  const r = await runCollection('manual');
  if (!r.started) console.log(`Já existe uma coleta em andamento (#${r.runId}).`);
  await r.done;
}
process.exit(0);
