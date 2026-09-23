// @vitest-environment node
/**
 * Auditoría 2026-09-18: los cuatro huecos de columnas escribibles.
 *
 * Cada bloque prueba lo mismo dos veces: sobre el fixture SIN la migración
 * (el hueco existía de verdad, no es una precaución teórica) y sobre el
 * fixture CON la migración aplicada (queda cerrado). Si alguien revierte
 * 20260920000000, la mitad "ya cerrado" se pone roja.
 *
 * Existe porque las 39 pruebas de RLS de verdad siguen omitidas: piden un
 * proyecto Supabase dedicado que todavía no hay. Esto corre en CI sin
 * credenciales, en un Postgres en memoria, con las políticas y disparadores
 * copiados literalmente de las migraciones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..', 'supabase', 'migrations');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'auditoria-escrituras.sql'), 'utf8');
const MIGRACION = readFileSync(join(raiz, '20260920000000_auditoria-columnas-escribibles.sql'), 'utf8');

const QRO = '11111111-1111-1111-1111-111111111111';
const GDL = '22222222-2222-2222-2222-222222222222';
const U = {
  org: 'c0000000-0000-0000-0000-000000000001', // organiza en Querétaro
  ana: 'c0000000-0000-0000-0000-000000000002', // Querétaro, de buena fe
  intruso: 'c0000000-0000-0000-0000-000000000003', // Guadalajara, el atacante
};

type Resultado<T> = { rows: T[]; error: string | null };

function sesion(db: PGlite) {
  return async function como<T = Record<string, unknown>>(
    uid: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<Resultado<T>> {
    await db.exec(
      `RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid}', false); SET ROLE authenticated;`,
    );
    try {
      return { rows: (await db.query<T>(sql, params)).rows, error: null };
    } catch (e) {
      return { rows: [], error: (e as Error).message };
    } finally {
      await db.exec('RESET ROLE');
    }
  };
}

/** Un mundo completo: dos campus, tres personas, un evento abierto y uno privado. */
async function mundo(conMigracion: boolean) {
  const db = new PGlite();
  await db.exec(FIXTURE);
  if (conMigracion) {
    await db.exec(MIGRACION);
    await db.exec(MIGRACION); // idempotente: pasarla dos veces no rompe nada
  }

  await db.query('INSERT INTO public.institutions (id, name) VALUES ($1, $2), ($3, $4)', [
    QRO, 'Queretaro', GDL, 'Guadalajara',
  ]);
  for (const [k, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, campus_id) VALUES ($1, $2, $3)', [
      id, k, k === 'intruso' ? GDL : QRO,
    ]);
  }

  const abierto = (
    await db.query<{ id: string }>(
      `INSERT INTO public.events (creator_id, title, privacy, institution_id)
       VALUES ($1, 'Feria abierta', 'open', $2) RETURNING id`,
      [U.org, GDL],
    )
  ).rows[0].id;

  const privado = (
    await db.query<{ id: string }>(
      `INSERT INTO public.events (creator_id, title, privacy, max_spots, institution_id)
       VALUES ($1, 'Cena en mi casa', 'private', 1, $2) RETURNING id`,
      [U.org, QRO],
    )
  ).rows[0].id;

  return { db, como: sesion(db), abierto, privado };
}

// ============================================================
// SEC-01 (P0): mover la participación a otro evento
// ============================================================
describe('SEC-01 · la participación no se muda de evento', () => {
  /** El atacante entra al evento abierto y luego mueve su fila al privado. */
  async function intentarMudanza(conMigracion: boolean) {
    const { como, abierto, privado } = await mundo(conMigracion);

    const alta = await como(
      U.intruso,
      'INSERT INTO public.event_participants (event_id, user_id) VALUES ($1, $2)',
      [abierto, U.intruso],
    );

    const mudanza = await como(
      U.intruso,
      'UPDATE public.event_participants SET event_id = $1 WHERE user_id = $2',
      [privado, U.intruso],
    );

    const dentro = await como<{ user_id: string }>(
      U.org,
      'SELECT user_id FROM public.event_attendees($1)',
      [privado],
    );

    return { alta, mudanza, asistentes: dentro.rows.map((r) => r.user_id) };
  }

  it('antes: el UPDATE se aceptaba y el intruso aparecía entre quien va', async () => {
    const r = await intentarMudanza(false);
    expect(r.alta.error).toBeNull();
    expect(r.mudanza.error).toBeNull(); // el hueco: aceptado sin rechistar
    expect(r.asistentes).toContain(U.intruso);
  });

  it('ya cerrado: el UPDATE se rechaza y nadie ajeno entra al evento privado', async () => {
    const r = await intentarMudanza(true);
    expect(r.alta.error).toBeNull();
    expect(r.mudanza.error).toMatch(/PARTICIPATION_FIELD_LOCKED/);
    expect(r.asistentes).not.toContain(U.intruso);
  });

  it('ya cerrado: la ruta honesta sigue funcionando igual', async () => {
    const { como, abierto, privado } = await mundo(true);

    // Pedir plaza en el privado entra como 'pending', lo decide el servidor.
    const pide = await como<{ status: string }>(
      U.ana,
      `INSERT INTO public.event_participants (event_id, user_id, status)
       VALUES ($1, $2, 'joined') RETURNING status`,
      [privado, U.ana],
    );
    expect(pide.error).toBeNull();
    expect(pide.rows[0].status).toBe('pending');

    // Autoaprobarse sigue fallando, como antes de la migración.
    const truco = await como(
      U.ana,
      `UPDATE public.event_participants SET status = 'joined' WHERE user_id = $1 AND event_id = $2`,
      [U.ana, privado],
    );
    expect(truco.error).toMatch(/permission denied/);

    // Y una actualización legítima de la propia fila sigue pasando.
    await como(U.ana, 'INSERT INTO public.event_participants (event_id, user_id) VALUES ($1, $2)', [
      abierto, U.ana,
    ]);
    const nota = await como(
      U.ana,
      'UPDATE public.event_participants SET rating = 5 WHERE user_id = $1 AND event_id = $2',
      [U.ana, abierto],
    );
    expect(nota.error).toBeNull();
  });
});

// ============================================================
// SEC-02 (P1): amistad autoconcedida
// ============================================================
describe('SEC-02 · el estado de una amistad lo decide el servidor', () => {
  async function autoconcederse(conMigracion: boolean) {
    const { db, como } = await mundo(conMigracion);

    const alta = await como(
      U.intruso,
      `INSERT INTO public.friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'accepted')`,
      [U.intruso, U.ana],
    );

    const amigos = (
      await db.query<{ son: boolean }>('SELECT public.are_friends($1, $2) AS son', [U.intruso, U.ana])
    ).rows[0].son;

    const avisos = (await db.query<{ user_id: string }>('SELECT user_id FROM public.push_log')).rows;

    return { alta, amigos, avisos: avisos.map((a) => a.user_id) };
  }

  it('antes: el INSERT con status accepted fabricaba una amistad, y sin avisar a la víctima', async () => {
    const r = await autoconcederse(false);
    expect(r.alta.error).toBeNull();
    expect(r.amigos).toBe(true);
    expect(r.avisos).toHaveLength(0); // el push solo salta con status 'pending'
  });

  it('ya cerrado: la fila entra como pending, no hay amistad, y la víctima sí se entera', async () => {
    const r = await autoconcederse(true);
    expect(r.alta.error).toBeNull(); // no falla: se normaliza, que es más amable
    expect(r.amigos).toBe(false);
    expect(r.avisos).toEqual([U.ana]);
  });

  it('ya cerrado: aceptar de verdad sigue siendo cosa del destinatario', async () => {
    const { db, como } = await mundo(true);
    await como(
      U.intruso,
      `INSERT INTO public.friendships (requester_id, addressee_id) VALUES ($1, $2)`,
      [U.intruso, U.ana],
    );

    const acepta = await como(
      U.ana,
      `UPDATE public.friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2`,
      [U.intruso, U.ana],
    );
    expect(acepta.error).toBeNull();

    const amigos = (
      await db.query<{ son: boolean }>('SELECT public.are_friends($1, $2) AS son', [U.intruso, U.ana])
    ).rows[0].son;
    expect(amigos).toBe(true);
  });
});

// ============================================================
// SEC-04 (P1): created_at escribible anula el límite
// ============================================================
describe('SEC-04 · el límite de creación de eventos cuenta de verdad', () => {
  // Crea siempre como U.ana, que empieza sin ningún evento: U.org ya tiene
  // los dos del mundo y contarían contra su propio límite.
  async function crearEnBucle(conMigracion: boolean, conTrampa: boolean, cuantos: number) {
    const { como } = await mundo(conMigracion);
    let creados = 0;
    let primerFallo: string | null = null;

    for (let i = 0; i < cuantos; i++) {
      const r = conTrampa
        ? await como(
            U.ana,
            `INSERT INTO public.events (creator_id, title, created_at)
             VALUES ($1, $2, '2020-01-01T00:00:00Z')`,
            [U.ana, `Evento ${i}`],
          )
        : await como(U.ana, 'INSERT INTO public.events (creator_id, title) VALUES ($1, $2)', [
            U.ana, `Evento ${i}`,
          ]);

      if (r.error) {
        primerFallo ??= r.error;
      } else {
        creados++;
      }
    }
    return { creados, primerFallo };
  }

  it('antes: mandando created_at en el pasado, el límite no frenaba nada', async () => {
    const r = await crearEnBucle(false, true, 30);
    expect(r.creados).toBe(30);
    expect(r.primerFallo).toBeNull();
  });

  it('el límite honesto siempre ha funcionado: 5 por hora', async () => {
    const r = await crearEnBucle(false, false, 30);
    expect(r.creados).toBe(5);
    expect(r.primerFallo).toMatch(/EVENT_RATE_LIMIT/);
  });

  it('ya cerrado: con la trampa o sin ella, el límite es el mismo', async () => {
    const r = await crearEnBucle(true, true, 30);
    expect(r.creados).toBe(5);
    expect(r.primerFallo).toMatch(/EVENT_RATE_LIMIT/);
  });

  it('ya cerrado: un evento no se muda de campus después de creado', async () => {
    const { como, privado } = await mundo(true);
    const mudanza = await como(
      U.org,
      'UPDATE public.events SET institution_id = $1 WHERE id = $2',
      [GDL, privado],
    );
    expect(mudanza.error).toMatch(/EVENT_FIELD_LOCKED/);
  });

  it('ya cerrado: editar un evento de verdad sigue funcionando', async () => {
    const { como, privado } = await mundo(true);
    const edita = await como(
      U.org,
      `UPDATE public.events SET title = 'Cena en la azotea', is_active = false WHERE id = $1`,
      [privado],
    );
    expect(edita.error).toBeNull();
  });
});

// ============================================================
// SEC-08 (P2): mensaje con fecha futura
// ============================================================
describe('SEC-08 · la fecha de envío de un mensaje la pone el servidor', () => {
  async function mensajeDelFuturo(conMigracion: boolean) {
    const { db, como } = await mundo(conMigracion);

    const grupo = (
      await db.query<{ id: string }>(
        `INSERT INTO public.groups (name, created_by) VALUES ('Padel', $1) RETURNING id`,
        [U.org],
      )
    ).rows[0].id;
    await db.query('INSERT INTO public.group_members (group_id, user_id) VALUES ($1, $2)', [
      grupo, U.ana,
    ]);

    const envio = await como(
      U.org,
      `INSERT INTO public.messages (group_id, sender_id, content, created_at)
       VALUES ($1, $2, 'hola', '2099-01-01T00:00:00Z')`,
      [grupo, U.org],
    );

    await como(U.ana, 'SELECT public.mark_group_read($1)', [grupo]);
    const sinLeer = await como<{ n: number }>(U.ana, 'SELECT public.no_leidos($1)::int AS n', [grupo]);

    return { envio, sinLeer: sinLeer.rows[0].n };
  }

  it('antes: el globo rojo no se apagaba ni marcando el chat como leído', async () => {
    const r = await mensajeDelFuturo(false);
    expect(r.envio.error).toBeNull();
    expect(r.sinLeer).toBe(1);
  });

  it('ya cerrado: marcar leído apaga el contador', async () => {
    const r = await mensajeDelFuturo(true);
    expect(r.envio.error).toBeNull(); // se normaliza la fecha, no se rechaza
    expect(r.sinLeer).toBe(0);
  });
});

// ============================================================
// SEC-05 (P2): límites de longitud en el servidor
// ============================================================
describe('SEC-05 · los límites de longitud viven en la base', () => {
  let ctx: Awaited<ReturnType<typeof mundo>>;
  let grupo: string;

  beforeAll(async () => {
    ctx = await mundo(true);
    grupo = (
      await ctx.db.query<{ id: string }>(
        `INSERT INTO public.groups (name, created_by) VALUES ('Padel', $1) RETURNING id`,
        [U.org],
      )
    ).rows[0].id;
  });

  it('un título de 1 MB ya no entra', async () => {
    const r = await ctx.como(U.org, 'INSERT INTO public.events (creator_id, title) VALUES ($1, $2)', [
      U.org, 'x'.repeat(1_000_000),
    ]);
    expect(r.error).toMatch(/events_title_len/);
  });

  it('un título de dos letras tampoco (el cliente pide 3, la base también)', async () => {
    const r = await ctx.como(U.org, 'INSERT INTO public.events (creator_id, title) VALUES ($1, $2)', [
      U.org, 'ok',
    ]);
    expect(r.error).toMatch(/events_title_len/);
  });

  it('una descripción de más de 500 no entra', async () => {
    const r = await ctx.como(
      U.org,
      'INSERT INTO public.events (creator_id, title, description) VALUES ($1, $2, $3)',
      [U.org, 'Feria', 'x'.repeat(501)],
    );
    expect(r.error).toMatch(/events_description_len/);
  });

  it('un mensaje de más de 2000 no entra, y uno en blanco tampoco', async () => {
    const largo = await ctx.como(
      U.org,
      'INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, $3)',
      [grupo, U.org, 'x'.repeat(2001)],
    );
    expect(largo.error).toMatch(/messages_content_len/);

    const vacio = await ctx.como(
      U.org,
      `INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, '   ')`,
      [grupo, U.org],
    );
    expect(vacio.error).toMatch(/messages_content_len/);
  });

  it('borrar un mensaje lo deja vacío y eso sigue siendo válido', async () => {
    const enviado = await ctx.como<{ id: string }>(
      U.org,
      `INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, 'hola') RETURNING id`,
      [grupo, U.org],
    );
    expect(enviado.error).toBeNull();

    const borrado = await ctx.como(
      U.org,
      `UPDATE public.messages SET content = '', deleted_at = now() WHERE id = $1`,
      [enviado.rows[0].id],
    );
    expect(borrado.error).toBeNull();
  });

  it('un mensaje normal entra sin problema', async () => {
    const r = await ctx.como(
      U.org,
      `INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, '¿mañana a las 7?')`,
      [grupo, U.org],
    );
    expect(r.error).toBeNull();
  });
});

// ============================================================
// SEC-05 · el título de la push de plan repetido
// ============================================================
describe('SEC-05 · la push de plan repetido trunca el título', () => {
  /** Devuelve el cuerpo de la push que genera repetir un plan con ese título. */
  async function cuerpoDeLaPush(conMigracion: boolean, titulo: string) {
    const { db } = await mundo(conMigracion);

    const original = (
      await db.query<{ id: string }>(
        `INSERT INTO public.events (creator_id, title, institution_id, starts_at, ends_at)
         VALUES ($1, 'Padel', $2, now() - interval '2 hours', now() - interval '1 hour')
         RETURNING id`,
        [U.org, QRO],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO public.event_participants (event_id, user_id, status) VALUES ($1, $2, 'joined')`,
      [original, U.ana],
    );

    // El CHECK de SEC-05 ya topa el título en 80, así que se quita aquí para
    // probar el truncado POR SÍ MISMO: una notificación que se rompe en
    // silencio no debería depender de que otro arreglo siga puesto.
    if (conMigracion) {
      await db.exec('ALTER TABLE public.events DROP CONSTRAINT events_title_len');
    }
    await db.query(
      `INSERT INTO public.events (creator_id, title, institution_id, repeated_from)
       VALUES ($1, $2, $3, $4)`,
      [U.org, titulo, QRO, original],
    );

    const push = (await db.query<{ body: string }>('SELECT body FROM public.push_log')).rows;
    return push.map((p) => p.body);
  }

  it('antes: el título entero viajaba en el cuerpo de la notificación', async () => {
    const cuerpos = await cuerpoDeLaPush(false, 'P'.repeat(4000));
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].length).toBeGreaterThan(4000);
  });

  it('ya cerrado: se trunca a 80 con puntos suspensivos', async () => {
    const cuerpos = await cuerpoDeLaPush(true, 'P'.repeat(4000));
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].length).toBeLessThan(140);
    expect(cuerpos[0]).toContain('…');
  });

  it('ya cerrado: un título normal conserva su texto y sus acentos', async () => {
    const cuerpos = await cuerpoDeLaPush(true, 'Cine');
    expect(cuerpos[0]).toBe('org organizó otra vez «Cine». ¿Te apuntas?');
  });

});
