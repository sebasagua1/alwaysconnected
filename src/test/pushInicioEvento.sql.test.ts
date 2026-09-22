// @vitest-environment node
/**
 * El aviso de "ya empezó el evento", ejecutado de verdad.
 *
 * PGlite sobre sql/eventos-sociales.sql, donde `push_send` apunta en
 * `push_log` en vez de llamar a APNs. Lo que se fija aquí es sobre todo lo
 * que NO debe pasar: el aviso sale una sola vez, no le llega a quien
 * organiza, y al aplicar la migración no se dispara de golpe por los
 * eventos que ya existían — que es el riesgo real de una migración que
 * manda notificaciones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..', 'supabase', 'migrations');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'eventos-sociales.sql'), 'utf8');
const MIGRACION = readFileSync(join(raiz, '20260921000000_push-empieza-el-evento.sql'), 'utf8');

const U = {
  org: 'b0000000-0000-0000-0000-000000000001',
  ana: 'b0000000-0000-0000-0000-000000000002',
  luis: 'b0000000-0000-0000-0000-000000000003',
  pend: 'b0000000-0000-0000-0000-000000000004',
};

let db: PGlite;
let viejo: string;    // empezó y terminó antes de la migración
let enCurso: string;  // ya había empezado cuando se aplicó la migración

/** Crea un evento con la ventana que se le diga, en minutos respecto a ahora. */
async function evento(titulo: string, desdeMin: number, hastaMin: number, activo = true): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.events (creator_id, title, starts_at, ends_at, is_active)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, now() + ($4 || ' minutes')::interval, $5)
     RETURNING id`,
    [U.org, titulo, String(desdeMin), String(hastaMin), activo],
  );
  return rows[0].id;
}

const apuntar = (eventoId: string, uid: string, status = 'joined', checkedIn = false) =>
  db.query(
    `INSERT INTO public.event_participants (event_id, user_id, status, checked_in) VALUES ($1, $2, $3, $4)`,
    [eventoId, uid, status, checkedIn],
  );

const avisar = async () =>
  (await db.query<{ n: number }>('SELECT public.notify_started_events() AS n')).rows[0].n;

const pushes = async () =>
  (await db.query<{ user_id: string; title: string; body: string; data: { type: string; event_id: string } }>(
    'SELECT user_id, title, body, data FROM public.push_log ORDER BY at',
  )).rows;

const limpiar = () => db.exec('DELETE FROM public.push_log');

const marcado = async (id: string) =>
  (await db.query<{ m: string | null }>('SELECT start_push_sent_at AS m FROM public.events WHERE id = $1', [id])).rows[0].m;

const QRO = '11111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);

  // Las cuentas las siembra cada prueba, no el fixture.
  for (const [nombre, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, campus_id) VALUES ($1, $2, $3)', [id, nombre, QRO]);
  }

  // Dos eventos que YA existían antes de la migración, con gente apuntada.
  viejo = await evento('Cine de anoche', -180, -120);
  await apuntar(viejo, U.ana);
  enCurso = await evento('Partido de ahora', -20, 60);
  await apuntar(enCurso, U.ana);

  await db.exec(MIGRACION);
}, 120_000);

describe('aplicar la migración', () => {
  it('no manda ni un aviso por lo que ya existía', async () => {
    // Lo que de verdad puede salir mal en una migración que notifica: que al
    // aplicarla salga un aviso por cada evento pasado. En producción eran 34.
    expect(await pushes()).toEqual([]);
  });

  it('deja marcado todo lo que ya había empezado', async () => {
    expect(await marcado(viejo)).not.toBeNull();
    expect(await marcado(enCurso)).not.toBeNull();
  });

  it('no marca los eventos futuros: esos sí tienen que avisar', async () => {
    const futuro = await evento('Café del viernes', 60, 120);
    expect(await marcado(futuro)).toBeNull();
  });

  it('aplicarla dos veces no cambia nada', async () => {
    const antes = await marcado(enCurso);
    await db.exec(MIGRACION);
    expect(await marcado(enCurso)).toEqual(antes);
    expect(await pushes()).toEqual([]);
  });
});

describe('el aviso', () => {
  beforeAll(limpiar);

  it('avisa a quien se unió cuando el evento acaba de empezar', async () => {
    const e = await evento('Pádel', -2, 118);
    await apuntar(e, U.ana);
    await apuntar(e, U.luis);

    expect(await avisar()).toBe(2);

    const enviados = await pushes();
    expect(enviados.map((p) => p.user_id).sort()).toEqual([U.ana, U.luis].sort());
    expect(enviados[0].data).toMatchObject({ type: 'event_started', event_id: e });
    expect(enviados[0].title).toBe('Ya empezó');
    expect(enviados[0].body).toContain('Pádel');
    await limpiar();
  });

  it('no avisa a quien organiza: no puede registrar asistencia', async () => {
    const e = await evento('Estudio', -1, 60);
    await apuntar(e, U.org);   // por si alguna vez se le crea fila
    await apuntar(e, U.ana);

    expect(await avisar()).toBe(1);
    expect((await pushes()).map((p) => p.user_id)).toEqual([U.ana]);
    await limpiar();
  });

  it('no avisa dos veces aunque el cron pase otra vez', async () => {
    const e = await evento('Correr', -3, 60);
    await apuntar(e, U.ana);

    expect(await avisar()).toBe(1);
    await limpiar();
    expect(await avisar()).toBe(0);
    expect(await pushes()).toEqual([]);
  });

  it('no avisa a quien está pendiente de aprobación ni a quien ya fichó', async () => {
    const e = await evento('Taller', -1, 60);
    await apuntar(e, U.pend, 'pending');
    await apuntar(e, U.luis, 'joined', true); // ya hizo check-in
    await apuntar(e, U.ana);

    expect(await avisar()).toBe(1);
    expect((await pushes()).map((p) => p.user_id)).toEqual([U.ana]);
    await limpiar();
  });

  it('quien se apunta después del aviso ya no lo recibe', async () => {
    const e = await evento('Comida', -1, 60);
    await apuntar(e, U.ana);
    expect(await avisar()).toBe(1);
    await limpiar();

    await apuntar(e, U.luis);
    expect(await avisar()).toBe(0);
    expect(await pushes()).toEqual([]);
  });
});

describe('lo que no avisa', () => {
  beforeAll(limpiar);

  it('un evento que todavía no ha empezado', async () => {
    const e = await evento('Mañana', 30, 90);
    await apuntar(e, U.ana);
    expect(await avisar()).toBe(0);
    expect(await marcado(e)).toBeNull(); // sigue pendiente, avisará a su hora
  });

  it('un evento que ya terminó', async () => {
    const e = await evento('Ayer', -200, -140);
    await apuntar(e, U.ana);
    expect(await avisar()).toBe(0);
  });

  it('un evento cancelado', async () => {
    const e = await evento('Cancelado', -2, 60, false);
    await apuntar(e, U.ana);
    expect(await avisar()).toBe(0);
  });

  it('un evento que empezó hace más de una hora (el cron estuvo caído)', async () => {
    // Sigue en curso —dura 4 horas— pero "ya empezó" a destiempo es peor que
    // callarse: la persona ya está allí, o ya no va a ir.
    const e = await evento('Maratón', -90, 150);
    await apuntar(e, U.ana);
    expect(await avisar()).toBe(0);
    expect(await pushes()).toEqual([]);
  });
});
