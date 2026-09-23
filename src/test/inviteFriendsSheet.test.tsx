/**
 * «Invitar amigos» desde la ficha de una actividad.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import i18n from '@/i18n';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (name: string, args: unknown) => rpc(name, args) },
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const { InviteFriendsSheet } = await import('@/components/map/InviteFriendsSheet');

const amigo = (id: string, name: string, major: string | null = null) => ({ id, name, avatar_url: null, major });
const AMIGOS = [
  amigo('ana', 'Ana'),
  amigo('e1', 'Esteban Garzón', 'Ingeniería Civil'),
  amigo('e2', 'Esteban Garzón', 'Derecho'),
];

let amigos = AMIGOS;
beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage('es');
  vi.clearAllMocks();
  amigos = AMIGOS;
  rpc.mockImplementation((name: string, args: { _friend_ids?: string[] }) => {
    if (name === 'friends_page') return Promise.resolve({ data: amigos, error: null });
    if (name === 'invite_friends_to_event') return Promise.resolve({ data: args._friend_ids?.length ?? 0, error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

const hoja = (exclude: string[]) => (
  <InviteFriendsSheet eventId="ev" open onOpenChange={vi.fn()} exclude={exclude} />
);

describe('InviteFriendsSheet', () => {
  it('distingue a dos amigos con el mismo nombre', async () => {
    render(hoja([]));
    expect(await screen.findByRole('checkbox', { name: /Esteban Garzón.*Ingeniería Civil/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Esteban Garzón.*Derecho/ })).toBeTruthy();
  });

  it('si alguien se une con la hoja abierta, no se pierde lo marcado ni se vuelve a pedir la lista', async () => {
    const { rerender } = render(hoja(['yo']));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Ana/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Derecho/ }));

    // La ficha relee quién va (tiempo real): llega un array NUEVO.
    rerender(hoja(['yo', 'e1']));

    expect((screen.getByRole('checkbox', { name: /Ana/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Derecho/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /Ingeniería Civil/ })).toBeNull();
    expect(rpc.mock.calls.filter(([n]) => n === 'friends_page')).toHaveLength(1);
  });

  it('solo invita a quien sigue fuera', async () => {
    const { rerender } = render(hoja([]));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Ana/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Derecho/ }));
    rerender(hoja(['e2'])); // se unió por su cuenta mientras tanto

    fireEvent.click(screen.getByRole('button', { name: /Invitar a 1 amigo/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('invite_friends_to_event', { _event_id: 'ev', _friend_ids: ['ana'] }));
  });

  it('si solo llega a una parte, dice a cuántos no', async () => {
    render(hoja([]));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Ana/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Derecho/ }));
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'invite_friends_to_event' ? { data: 1, error: null } : { data: amigos, error: null }));

    fireEvent.click(screen.getByRole('button', { name: /Invitar a 2 amigos/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Invitación enviada a 1 amigo',
      description: 'A 1 no le llegó: ya tenía invitación o no puede recibirla',
    }));
  });

  it('con 20 marcados no deja marcar más y lo dice', async () => {
    amigos = Array.from({ length: 21 }, (_, i) => amigo(`a${i}`, `Amigo ${String(i).padStart(2, '0')}`));
    render(hoja([]));
    const casillas = await screen.findAllByRole('checkbox');
    casillas.slice(0, 20).forEach((c) => fireEvent.click(c));

    expect((casillas[20] as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Máximo 20 por vez')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Invitar a 20 amigos/ })).toBeTruthy();
  });
});
