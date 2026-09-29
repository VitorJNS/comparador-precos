// Uso pela linha de comando:
//   npm run coletar         -> roda uma coleta agora (sem abrir o painel)
//   npm run testar-email    -> envia o resumo atual por e-mail

import { runCollection } from './collector.js';
import { sendSummaryEmail } from './notifier.js';

if (process.argv.includes('--testar-email')) {
  await sendSummaryEmail();
  console.log('E-mail de teste enviado.');
} else {
  const r = await runCollection('manual');
  if (!r.started) console.log(`Já existe uma coleta em andamento (#${r.runId}).`);
  await r.done;
}
process.exit(0);
