/**
 * RLS de editar y borrar mensajes (migración 20260914000000).
 *
 * Tres personas: A y B son amigos y comparten un DM; C no está en él.
 * Comprueba en la base de verdad —no en la interfaz— que:
 *   · Solo el autor edita o borra, y solo por borrado lógico.
 *   · Ni el autor puede mover el mensaje, cambiar el remitente o la fecha.
 *   · No se guarda un mensaje vacío.
 *   · Borrar vacía el texto también para los demás y bloquea editarlo después.
 *   · Un mensaje borrado no sale como vista previa en chat_summaries.
 *
 * Igual que rls-helpers: corre SOLO contra un proyecto de pruebas aparte
 * (VITE_TEST_SUPABASE_URL / VITE_TEST_SUPABASE_ANON_KEY) con la migración
 * aplicada y alta sin confirmación de correo. Sin eso, se omite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_TEST_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_TEST_SUPABASE_ANON_KEY as string;

if (URL && URL === (import.meta.env.VITE_SUPABASE_URL as string)) {
  throw new Error('VITE_TEST_SUPABASE_URL apunta al proyecto de producción.');
}

const CONFIGURED = Boolean(URL && ANON);
const suite = CONFIGURED ? describe : describe.skip;

const newClient = () =>
  createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const rand = () => Math.random().toString(36).slice(2, 10);

async function signUp(client: SupabaseClient) {
  const { data, error } = await client.auth.signUp({
    email: `rlsmsg_${rand()}@example.test`,
    password: `Pw_${rand()}${rand()}!`,
  });
  if (error) throw error;
  if (!data.session) throw new Error('EMAIL_CONFIRM_REQUIRED');
  return data.user!.id;
}

const ctx: {
  a?: SupabaseClient; b?: SupabaseClient; c?: SupabaseClient;
  aId?: string; bId?: string; cId?: string;
  dmId?: string;
} = {};

/** Un mensaje nuevo de A en el DM, para que cada prueba parta de cero. */
async function messageFromA(content = `hola-${rand()}`) {
  const { data, error } = await ctx.a!
    .from('messages')
    .insert({ group_id: ctx.dmId!, sender_id: ctx.aId!, content })
    .select('id, content, created_at, sender_id, group_id, edited_at, deleted_at')
    .single();
  if (error) throw error;
  return data;
}

/** La fila tal como la ve B, que es miembro del chat. */
async function seenByB(id: string) {
  const { data } = await ctx.b!
    .from('messages')
    .select('id, content, created_at, sender_id, group_id, edited_at, deleted_at')
    .eq('id', id)
    .maybeSingle();
  return data;
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  ctx.a = newClient();
  ctx.b = newClient();
  ctx.c = newClient();
  ctx.aId = await signUp(ctx.a);
  ctx.bId = await signUp(ctx.b);
  ctx.cId = await signUp(ctx.c);

  // Amistad por el camino normal: A pide, B acepta.
  const { error: reqErr } = await ctx.a
    .from('friendships')
    .insert({ requester_id: ctx.aId, addressee_id: ctx.bId, status: 'pending' });
  if (reqErr) throw reqErr;
  const { error: accErr } = await ctx.b
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('requester_id', ctx.aId)
    .eq('addressee_id', ctx.bId);
  if (accErr) throw accErr;

  const { data: dmId, error: dmErr } = await ctx.a.rpc('create_dm', { _other_user_id: ctx.bId });
  if (dmErr) throw dmErr;
  ctx.dmId = dmId as string;
}, 30_000);

afterAll(async () => {
  if (!CONFIGURED) return;
  await Promise.all([ctx.a, ctx.b, ctx.c].map((c) => c?.auth.signOut()));
});

suite('messages: editar y borrar solo el autor', () => {
  it('B (miembro del chat) no puede editar el mensaje de A', async () => {
    const msg = await messageFromA();
    const { data } = await ctx.b!.from('messages').update({ content: 'hackeado' }).eq('id', msg.id).select('id');
    expect(data ?? []).toHaveLength(0);
    expect((await seenByB(msg.id))?.content).toBe(msg.content);
  });

  it('B no puede borrar (lógicamente) el mensaje de A', async () => {
    const msg = await messageFromA();
    const { data } = await ctx.b!
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', msg.id)
      .select('id');
    expect(data ?? []).toHaveLength(0);
    const fila = await seenByB(msg.id);
    expect(fila?.deleted_at).toBeNull();
    expect(fila?.content).toBe(msg.content);
  });

  it('C (fuera del chat) no puede editar el mensaje de A', async () => {
    const msg = await messageFromA();
    const { data } = await ctx.c!.from('messages').update({ content: 'hackeado' }).eq('id', msg.id).select('id');
    expect(data ?? []).toHaveLength(0);
    expect((await seenByB(msg.id))?.content).toBe(msg.content);
  });

  it('nadie puede borrar la fila de verdad, ni el autor', async () => {
    const msg = await messageFromA();
    await ctx.a!.from('messages').delete().eq('id', msg.id);
    await ctx.b!.from('messages').delete().eq('id', msg.id);
    expect(await seenByB(msg.id)).not.toBeNull();
  });

  it('el autor no puede cambiar remitente, chat ni fecha original', async () => {
    const msg = await messageFromA();
    const intentos = [
      { sender_id: ctx.bId! },
      { created_at: new Date(0).toISOString() },
      { expires_at: null },
    ];
    for (const cambio of intentos) {
      const { error } = await ctx.a!.from('messages').update(cambio).eq('id', msg.id);
      expect(error, JSON.stringify(cambio)).not.toBeNull();
    }
    const fila = await seenByB(msg.id);
    expect(fila?.sender_id).toBe(ctx.aId);
    expect(fila?.group_id).toBe(ctx.dmId);
    expect(fila?.created_at).toBe(msg.created_at);
  });

  it('el autor no puede dejar el mensaje vacío', async () => {
    const msg = await messageFromA();
    const { error } = await ctx.a!.from('messages').update({ content: '   ' }).eq('id', msg.id);
    expect(error?.message).toContain('EMPTY_MESSAGE');
    expect((await seenByB(msg.id))?.content).toBe(msg.content);
  });

  it('el autor edita: cambia el texto, marca edited_at y conserva la fecha', async () => {
    const msg = await messageFromA();
    const { data, error } = await ctx.a!
      .from('messages')
      .update({ content: 'corregido', edited_at: new Date(0).toISOString() })
      .eq('id', msg.id)
      .select('content, created_at, edited_at')
      .single();
    expect(error).toBeNull();
    expect(data?.content).toBe('corregido');
    expect(data?.created_at).toBe(msg.created_at);
    // La fecha la pone el servidor, no la que mandó el cliente.
    expect(new Date(data!.edited_at!).getTime()).toBeGreaterThan(new Date(msg.created_at).getTime());
    expect((await seenByB(msg.id))?.content).toBe('corregido');
  });

  it('el autor borra: B ve el mensaje vacío y ya no se puede editar', async () => {
    const msg = await messageFromA('secreto');
    const { error } = await ctx.a!
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', msg.id);
    expect(error).toBeNull();

    const fila = await seenByB(msg.id);
    expect(fila?.deleted_at).not.toBeNull();
    expect(fila?.content).toBe('');

    const { data } = await ctx.a!.from('messages').update({ content: 'revivido' }).eq('id', msg.id).select('id');
    expect(data ?? []).toHaveLength(0);
    expect((await seenByB(msg.id))?.content).toBe('');
  });

  it('un mensaje borrado no queda como vista previa del chat', async () => {
    const anterior = await messageFromA('queda-este');
    const ultimo = await messageFromA('se-borra');
    await ctx.a!.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', ultimo.id);

    const { data, error } = await ctx.b!.rpc('chat_summaries');
    expect(error).toBeNull();
    // El cliente de esta suite se crea sin el genérico Database (apunta a un
    // proyecto de pruebas, no al de los tipos generados), así que la fila llega
    // sin tipar y hay que decir qué se espera de ella.
    const dm = (data ?? []).find(
      (r: { group_id: string; last_content: string | null }) => r.group_id === ctx.dmId,
    );
    expect(dm?.last_content).toBe(anterior.content);
  });
});
