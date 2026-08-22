import fs from 'node:fs';
import postgres from 'postgres';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,'')];}));
const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const tables = await sql`select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1,2`;
console.log('== TABLES ==');
for (const t of tables) {
  let n = '?';
  try { const c = await sql.unsafe(`select count(*)::int as n from "${t.table_schema}"."${t.table_name}"`); n = c[0].n; } catch(e) { n = 'ERR '+e.message; }
  console.log(`${t.table_schema}.${t.table_name}\t${n}`);
}
console.log('== public.sites ==');
try { console.log(JSON.stringify(await sql`select * from public.sites limit 20`, null, 1)); } catch(e){ console.log('ERR', e.message); }
console.log('== documents columns ==');
try { console.log((await sql`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='documents' order by ordinal_position`).map(r=>`${r.column_name}:${r.data_type}`).join(', ')); } catch(e){ console.log('ERR', e.message); }
console.log('== documents rows ==');
try { console.log(JSON.stringify(await sql`select id, site_id, kind, title, created_at from public.documents order by created_at limit 30`, null, 1)); } catch(e){ console.log('ERR', e.message); }
await sql.end();
