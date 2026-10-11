// Validação offline: nunca restaura nem conecta ao banco automaticamente.
// node scripts/restore-backup.mjs <diretório extraído em pasta nova/vazia>
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Informe a pasta que contém manifest.json e database.dump extraídos do pacote.');
const root = resolve(directory);
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (manifest.format !== 'salomao-db-v1' || !Number.isInteger(manifest.postgresServerMajor)) throw new Error('Manifesto/versão inválidos.');
for (const name of ['database.dump', 'globals.sql']) {
  const expected = manifest.files?.[name];
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Checksum inválido no manifesto.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(root, name))) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`Arquivo alterado/corrompido: ${name}. Não restaure.`);
}
console.info('SHA-256 conferido. Isso comprova integridade, não restauração funcional.');
console.info(`Prepare OUTRO Supabase compatível com PostgreSQL ${manifest.postgresServerMajor} e as extensões do original.`);
console.info('Revise globals.sql: crie apenas roles ausentes e configure suas senhas separadamente. Não aplique cegamente em outro cluster.');
console.info('Não use a DATABASE_URL da produção. No destino novo, configure PGHOST, PGPORT, PGDATABASE, PGUSER e PGPASSWORD sem colocá-los na linha de comando.');
console.info('Inspecione o arquivo local: pg_restore --list database.dump');
console.info('Após confirmação específica e revisão das roles/extensões, o comando de recuperação é:');
console.info('pg_restore --exit-on-error --single-transaction --clean --if-exists --dbname=<BANCO_NOVO> database.dump');
console.info('O comando altera o destino; pode falhar por dependências gerenciadas do Supabase. Teste em destino descartável primeiro.');
console.info('Após restore compare tabelas/dados, RLS, ACLs, funções, sequences e login. Reconfigure volumes Storage, env e serviços externos separadamente.');
