// @vitest-environment node
/**
 * UX-03: borrar tu cuenta ya no borra el grupo de los demás.
 *
 * Mismo fixture y mismo método que las otras pruebas de la auditoría: cada
 * caso, sin la migración y con ella.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..', 'supabase', 'migrations');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'auditoria-escrituras.sql'), 'utf8');
const MIGRACION = readFileSync(join(raiz, '20260922000000_grupos-sobreviven-a-su-creador.sql'), 'utf8');

const QRO = '11111111-1111-1111-1111-111111111111';
const U = {
  crea: 'e0000000-0000-0000-0000-000000000001',
  ana: 'e0000000-0000-0000-0000-000000000002',
  luis: 'e0000000-0000-0000-0000-000000000003',
};

async function mundo(conMigracion: boolean) {
  const db = new PGlite();
  await db.exec(FIXTURE);
  if (conMigracion) {
    await db.exec(MIGRACION);
    await db.exec(MIGRACION); // idempotente
  }

  await db.query('INSERT INTO public.institutions (id, name) VALUES ($1, $2)', [QRO, 'Queretaro']);
  for (const [k, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, campus_id) VALUES ($1, $2, $3)', [id, k, QRO]);
  }

  /** Crea un grupo con `crea` de dueño y los miembros que se le pasen. */
  const grupoCon = async (nombre: string, miembros: string[]) => {
    const id = (
      await db.query<{ id: string }>(
        'INSERT INTO public.groups (name, created_by) VALUES ($1, $2) RETURNING id',
        [nombre, U.crea],
      )
    ).rows[0].id;
    // Quien crea también escribe: así se ve que lo suyo desaparece con su
    // cuenta (messages.sender_id cae en cascada) y lo de los demás no.
    await db.query('INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, $3)', [
      id, U.crea, 'hola de crea',
    ]);
    for (const m of miembros) {
      await db.query(
        `INSERT INTO public.group_members (group_id, user_id, joined_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [id, m, String(miembros.indexOf(m) + 1)],
      );
      await db.query(
        'INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, $3)',
        [id, m, `hola de ${m}`],
      );
    }
    return id;
  };

  const grupo = async (id: string) =>
    (await db.query<{ id: string; created_by: string | null }>(
      'SELECT id, created_by FROM public.groups WHERE id = $1',
      [id],
    )).rows[0] ?? null;

  const mensajes = async (id: string) =>
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.messages WHERE group_id = $1', [id]))
      .rows[0].n;

  return { db, grupoCon, grupo, mensajes };
}

describe('UX-03 · un grupo no se va con quien lo creó', () => {
  it('antes: se llevaba por delante el grupo y los mensajes de todos', async () => {
    const m = await mundo(false);
    const g = await m.grupoCon('Padel', [U.ana, U.luis]);

    await m.db.query('DELETE FROM auth.users WHERE id = $1', [U.crea]);

    expect(await m.grupo(g)).toBeNull();
    expect(await m.mensajes(g)).toBe(0);
  });

  it('ya cerrado: el grupo pasa al miembro más antiguo y los mensajes se quedan', async () => {
    const m = await mundo(true);
    const g = await m.grupoCon('Padel', [U.ana, U.luis]);

    await m.db.query('DELETE FROM auth.users WHERE id = $1', [U.crea]);

    const fila = await m.grupo(g);
    expect(fila).not.toBeNull();
    expect(fila.created_by).toBe(U.ana); // entró antes que luis
    // Eran tres mensajes. El de quien se fue desaparece con su cuenta, que es
    // lo correcto; los dos de las demás personas se quedan, que es el punto.
    expect(await m.mensajes(g)).toBe(2);
  });

  it('ya cerrado: si no queda nadie dentro, el grupo se borra', async () => {
    const m = await mundo(true);
    const g = await m.grupoCon('Solo yo', []);

    await m.db.query('DELETE FROM auth.users WHERE id = $1', [U.crea]);

    expect(await m.grupo(g)).toBeNull();
  });

  it('ya cerrado: un DM se va con quien se va, como siempre', async () => {
    const m = await mundo(true);
    const g = await m.grupoCon(`__dm_${U.ana}_${U.crea}`, [U.ana]);

    await m.db.query('DELETE FROM auth.users WHERE id = $1', [U.crea]);

    expect(await m.grupo(g)).toBeNull();
  });

  it('ya cerrado: cambiar de dueño a mano no dispara nada raro', async () => {
    const m = await mundo(true);
    const g = await m.grupoCon('Padel', [U.ana, U.luis]);

    await m.db.query('UPDATE public.groups SET created_by = $1 WHERE id = $2', [U.luis, g]);

    const fila = await m.grupo(g);
    expect(fila.created_by).toBe(U.luis);
  });
});
