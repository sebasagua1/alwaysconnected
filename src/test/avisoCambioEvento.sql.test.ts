// @vitest-environment node
/**
 * Auditoría 2026-09-18, segunda tanda: avisar de los cambios (UX-02) y no
 * perder los reportes cuando el reportado borra su cuenta (SEC-09).
 *
 * Mismo fixture que auditoriaEscrituras.sql.test.ts, mismo método: cada cosa
 * se prueba sin la migración y con ella, para que quede por escrito que el
 * agujero existía y que se cerró.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..', 'supabase', 'migrations');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'auditoria-escrituras.sql'), 'utf8');
const COLUMNAS = readFileSync(join(raiz, '20260920000000_auditoria-columnas-escribibles.sql'), 'utf8');
const MIGRACION = readFileSync(join(raiz, '20260921000000_aviso-cambio-evento-y-reportes.sql'), 'utf8');

const QRO = '11111111-1111-1111-1111-111111111111';
const U = {
  org: 'd0000000-0000-0000-0000-000000000001', // organiza
  ana: 'd0000000-0000-0000-0000-000000000002', // se apuntó
  luis: 'd0000000-0000-0000-0000-000000000003', // se apuntó y bloqueó a org
  pend: 'd0000000-0000-0000-0000-000000000004', // pidió plaza, sigue pendiente
};

async function mundo(conMigracion: boolean) {
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(COLUMNAS);
  if (conMigracion) {
    await db.exec(MIGRACION);
    await db.exec(MIGRACION); // idempotente
  }

  await db.query('INSERT INTO public.institutions (id, name) VALUES ($1, $2)', [QRO, 'Queretaro']);
  for (const [k, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, campus_id) VALUES ($1, $2, $3)', [id, k, QRO]);
  }

  const evento = (
    await db.query<{ id: string }>(
      `INSERT INTO public.events (creator_id, title, privacy, institution_id, lat, lng)
       VALUES ($1, 'Padel', 'open', $2, 20.6, -100.4) RETURNING id`,
      [U.org, QRO],
    )
  ).rows[0].id;

  await db.query(
    `INSERT INTO public.event_participants (event_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4)`,
    [evento, U.ana, U.luis, U.pend],
  );
  // En un evento abierto, set_participant_initial_status normaliza todo a
  // 'joined'; para tener una solicitud pendiente hay que ponerla después, como
  // postgres (prevent_status_tampering solo frena al rol authenticated).
  await db.query(
    `UPDATE public.event_participants SET status = 'pending' WHERE event_id = $1 AND user_id = $2`,
    [evento, U.pend],
  );
  await db.query('INSERT INTO public.blocks VALUES ($1, $2)', [U.luis, U.org]);
  await db.exec('DELETE FROM public.push_log');

  const avisos = async () =>
    (await db.query<{ user_id: string; title: string; body: string; data: { type: string } }>(
      'SELECT user_id, title, body, data FROM public.push_log ORDER BY at',
    )).rows;

  return { db, evento, avisos };
}

describe('UX-02 · editar o cancelar un evento avisa a quien se apuntó', () => {
  it('antes: no pasaba nada, ni al cambiar la hora ni al cancelar', async () => {
    const { db, evento, avisos } = await mundo(false);

    await db.query(`UPDATE public.events SET starts_at = now() + interval '3 days' WHERE id = $1`, [evento]);
    await db.query('UPDATE public.events SET is_active = false WHERE id = $1', [evento]);

    expect(await avisos()).toHaveLength(0);
  });

  it('cancelar avisa a quien iba, y solo a quien iba', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query('UPDATE public.events SET is_active = false WHERE id = $1', [evento]);

    const a = await avisos();
    // Ni quien organiza, ni la solicitud pendiente, ni quien bloqueó a org.
    expect(a.map((x) => x.user_id)).toEqual([U.ana]);
    expect(a[0].title).toBe('Plan cancelado');
    expect(a[0].body).toBe('Se canceló «Padel»');
    expect(a[0].data).toEqual({ type: 'event_cancelled', event_id: evento });
  });

  it('cambiar la hora avisa, y dice que es la hora', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query(`UPDATE public.events SET starts_at = now() + interval '3 days' WHERE id = $1`, [evento]);

    const a = await avisos();
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Cambió un plan');
    expect(a[0].body).toBe('Cambió la hora de «Padel»');
    expect(a[0].data).toEqual({ type: 'event_changed', event_id: evento });
  });

  it('cambiar el sitio avisa, y dice que es el sitio', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query('UPDATE public.events SET lat = 19.4, lng = -99.1 WHERE id = $1', [evento]);

    const a = await avisos();
    expect(a).toHaveLength(1);
    expect(a[0].body).toBe('Cambió el lugar de «Padel»');
  });

  it('pasar a "solo amigos" avisa: es el último aviso que verán', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query(`UPDATE public.events SET privacy = 'friends' WHERE id = $1`, [evento]);

    const a = await avisos();
    expect(a[0].body).toBe('«Padel» ahora es solo para amigos');
  });

  it('cancelar gana a cambiar la hora: un solo aviso, el que importa', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query(
      `UPDATE public.events SET is_active = false, starts_at = now() + interval '3 days' WHERE id = $1`,
      [evento],
    );

    const a = await avisos();
    expect(a).toHaveLength(1);
    expect(a[0].data.type).toBe('event_cancelled');
  });

  it('cambiar solo el título o la descripción no molesta a nadie', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query(`UPDATE public.events SET title = 'Padel por la tarde' WHERE id = $1`, [evento]);
    await db.query(`UPDATE public.events SET description = 'llevad pelotas' WHERE id = $1`, [evento]);

    expect(await avisos()).toHaveLength(0);
  });

  it('guardar sin cambiar nada tampoco', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.query('UPDATE public.events SET is_active = is_active WHERE id = $1', [evento]);

    expect(await avisos()).toHaveLength(0);
  });

  it('un título larguísimo no revienta el cuerpo de la notificación', async () => {
    const { db, evento, avisos } = await mundo(true);
    await db.exec('ALTER TABLE public.events DROP CONSTRAINT events_title_len');
    await db.query('UPDATE public.events SET title = $1 WHERE id = $2', ['P'.repeat(4000), evento]);
    await db.query('UPDATE public.events SET is_active = false WHERE id = $1', [evento]);

    const a = await avisos();
    expect(a[0].body.length).toBeLessThan(140);
    expect(a[0].body).toContain('…');
  });
});

describe('SEC-09 · los reportes sobreviven a que el reportado borre su cuenta', () => {
  async function reportarYBorrar(conMigracion: boolean) {
    const { db } = await mundo(conMigracion);

    await db.exec(
      `RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${U.ana}', false); SET ROLE authenticated;`,
    );
    let alta: string | null = null;
    try {
      await db.query(
        `INSERT INTO public.reports (reporter_id, reported_user_id, reason, details)
         VALUES ($1, $2, 'harassment', 'me sigue escribiendo')`,
        [U.ana, U.luis],
      );
    } catch (e) {
      alta = (e as Error).message;
    }
    await db.exec('RESET ROLE');

    // La cuenta reportada se va.
    await db.query('DELETE FROM auth.users WHERE id = $1', [U.luis]);

    const quedan = (
      await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.reports')
    ).rows[0].n;

    return { db, alta, quedan };
  }

  it('antes: el reporte desaparecía con la cuenta', async () => {
    const r = await reportarYBorrar(false);
    expect(r.alta).toBeNull();
    expect(r.quedan).toBe(0);
  });

  it('ya cerrado: el reporte se queda, con el nombre de quien era', async () => {
    const r = await reportarYBorrar(true);
    expect(r.alta).toBeNull();
    expect(r.quedan).toBe(1);

    const fila = (
      await r.db.query<{
        reported_user_id: string | null;
        reported_user_ref: string;
        reported_name: string;
        reason: string;
      }>('SELECT reported_user_id, reported_user_ref, reported_name, reason FROM public.reports')
    ).rows[0];

    expect(fila.reported_user_id).toBeNull(); // el enlace vivo se fue
    expect(fila.reported_user_ref).toBe(U.luis); // la copia duradera se queda
    expect(fila.reported_name).toBe('luis');
    expect(fila.reason).toBe('harassment');
  });

  it('ya cerrado: reportar dos veces a la misma persona sigue sin poder', async () => {
    const { db } = await mundo(true);
    const reportar = async () => {
      await db.exec(
        `RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${U.ana}', false); SET ROLE authenticated;`,
      );
      try {
        await db.query(
          `INSERT INTO public.reports (reporter_id, reported_user_id, reason)
           VALUES ($1, $2, 'spam')`,
          [U.ana, U.luis],
        );
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await db.exec('RESET ROLE');
      }
    };

    expect(await reportar()).toBeNull();
    expect(await reportar()).toMatch(/reports_unique_user_target/);
  });

  it('ya cerrado: el cliente no puede falsear el nombre ni la referencia', async () => {
    const { db } = await mundo(true);
    await db.exec(
      `RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${U.ana}', false); SET ROLE authenticated;`,
    );
    await db.query(
      `INSERT INTO public.reports (reporter_id, reported_user_id, reason, reported_name, reported_user_ref)
       VALUES ($1, $2, 'spam', 'Otra persona', $3)`,
      [U.ana, U.luis, U.org],
    );
    await db.exec('RESET ROLE');

    const fila = (
      await db.query<{ reported_user_ref: string; reported_name: string }>(
        'SELECT reported_user_ref, reported_name FROM public.reports',
      )
    ).rows[0];
    expect(fila.reported_user_ref).toBe(U.luis);
    expect(fila.reported_name).toBe('luis');
  });
});
