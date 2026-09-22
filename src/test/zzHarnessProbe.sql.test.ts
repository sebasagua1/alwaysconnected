// @vitest-environment node
import { it, expect } from 'vitest';
import { baseReal } from './fullSchema';
it('carga', async () => {
  const db = await baseReal();
  const r = await db.query<{ n: number }>("select count(*)::int n from pg_policies where schemaname='public'");
  expect(r.rows[0].n).toBeGreaterThan(10);
}, 120000);
