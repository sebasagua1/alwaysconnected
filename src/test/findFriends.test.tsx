/**
 * "Encontrar amigos": nunca se pide el permiso sin la pantalla previa, cada
 * estado del permiso tiene su salida, y nada se comparte sin la acción final
 * de la persona.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';

const c = vi.hoisted(() => ({
  contactsStatus: vi.fn(),
  requestContactsAccess: vi.fn(),
  readDeviceContacts: vi.fn(),
  pickDeviceContacts: vi.fn(),
  hashContacts: vi.fn(),
  matchContacts: vi.fn(),
  registerMyIdentifiers: vi.fn(),
  shareInvite: vi.fn(),
  manageLimitedAccess: vi.fn(),
  openAppSettings: vi.fn(),
}));

vi.mock('@/lib/contacts', () => {
  class ContactsMatchError extends Error {
    constructor(public code: string) { super(code); }
  }
  return { ...c, ContactsMatchError, inviteUrl: (code: string) => `https://alwaysconnected.vercel.app/i/${code}` };
});

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      const p = rpc(name, args);
      return Object.assign(p, { abortSignal: () => p });
    },
    from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'f1' }, error: null }) }) }) }),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ user: { id: 'yo' } }) }));
vi.mock('@/components/profile/UserProfileSheet', () => ({ UserProfileSheet: () => null }));

const { default: FindFriends } = await import('@/pages/FindFriends');

const AGENDA = [
  { id: 'c1', name: 'Mamá', phones: ['55 1111 2222'], emails: [] },
  { id: 'c2', name: 'Pedro', phones: ['55 3333 4444'], emails: [] },
  { id: 'c3', name: 'Lucía', phones: [], emails: ['lucia@gmail.com'] },
];

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  rpc.mockImplementation((name: string) => {
    if (name === 'my_contact_settings') return Promise.resolve({ data: [{ discoverable: false, notify_contacts_join: false, last_synced_at: null, identifiers: 0 }], error: null });
    if (name === 'people_suggestions') return Promise.resolve({ data: [], error: null });
    if (name === 'my_invite_code') return Promise.resolve({ data: 'AbCdEf1234', error: null });
    return Promise.resolve({ data: null, error: null });
  });
  c.contactsStatus.mockResolvedValue({ status: 'notDetermined', limitedPickerAvailable: true });
  c.readDeviceContacts.mockResolvedValue(AGENDA);
  c.hashContacts.mockResolvedValue({ items: [{ ref: '0.0', kind: 'phone', h: 'a'.repeat(64) }], contactByRef: new Map() });
  c.matchContacts.mockResolvedValue([
    { user_id: 'u1', name: 'Mamá López', avatar_url: null, campus_name: 'Querétaro', relation: 'none', friendship_id: null, refs: ['0.0'] },
  ]);
  c.registerMyIdentifiers.mockResolvedValue(undefined);
  c.shareInvite.mockResolvedValue(true);
  await i18n.changeLanguage('es');
});

const montar = () => render(
  <HelmetProvider>
    <MemoryRouter initialEntries={['/friends/find']}>
      <FindFriends />
    </MemoryRouter>
  </HelmetProvider>,
);

describe('FindFriends', () => {
  it('sin decidir: explica para qué, que es opcional y cómo cambiarlo, y NO pide permiso solo', async () => {
    montar();
    expect(await screen.findByText('Encuentra a quien ya conoces')).toBeInTheDocument();
    expect(screen.getByText(/Es opcional/)).toBeInTheDocument();
    expect(screen.getByText(/la app funciona igual/)).toBeInTheDocument();
    expect(screen.getByText(/Puedes cambiar el permiso/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ahora no' })).toBeInTheDocument();
    expect(c.requestContactsAccess).not.toHaveBeenCalled();
  });

  it('"Encontrar amigos" guarda la elección, pide permiso y enseña quién está', async () => {
    c.requestContactsAccess.mockResolvedValue('authorized');
    montar();
    // Ser encontrable empieza desmarcado: se activa, no se presupone.
    const encontrable = await screen.findByRole('checkbox', { name: /Dejar que mis contactos me encuentren/ });
    expect(encontrable).not.toBeChecked();
    fireEvent.click(encontrable);
    fireEvent.click(screen.getByRole('button', { name: 'Encontrar amigos' }));

    expect(await screen.findByText('Mamá López')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('set_contact_settings', { _discoverable: true, _notify_join: false });
    expect(c.requestContactsAccess).toHaveBeenCalledTimes(1);
    // Encontrable: primero se registra, luego se busca, sin guardar la agenda.
    expect(c.registerMyIdentifiers).toHaveBeenCalled();
    expect(c.matchContacts).toHaveBeenCalledWith(expect.any(Array), false);
    expect(screen.getByText(/En tus contactos: Mamá/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enviar solicitud de amistad a Mamá López/ })).toBeInTheDocument();
  });

  it('elegir contactos a mano no pide el permiso de la agenda', async () => {
    c.pickDeviceContacts.mockResolvedValue([AGENDA[1]]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir contactos a mano' }));
    await waitFor(() => expect(c.matchContacts).toHaveBeenCalled());
    expect(c.requestContactsAccess).not.toHaveBeenCalled();
    expect(c.readDeviceContacts).not.toHaveBeenCalled();
  });

  it('denegado: explica y ofrece Configuración, sin volver a pedir', async () => {
    c.contactsStatus.mockResolvedValue({ status: 'denied', limitedPickerAvailable: false });
    montar();
    expect(await screen.findByText('Sin acceso a tus contactos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir Configuración' })).toBeInTheDocument();
    expect(c.requestContactsAccess).not.toHaveBeenCalled();
  });

  it('en la web: lo dice y ofrece compartir el enlace', async () => {
    c.contactsStatus.mockResolvedValue({ status: 'unavailable', limitedPickerAvailable: false });
    montar();
    expect(await screen.findByText('Los contactos solo están en la app de iPhone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compartir mi enlace' }));
    await waitFor(() => expect(c.shareInvite).toHaveBeenCalledWith(
      'Te invito a Always Connected para que podamos descubrir y unirnos a actividades juntos.',
      'https://alwaysconnected.vercel.app/i/AbCdEf1234',
      0,
    ));
  });

  it('invitar varios: solo abre la hoja de compartir con el enlace opaco', async () => {
    c.contactsStatus.mockResolvedValue({ status: 'authorized', limitedPickerAvailable: false });
    montar();
    await screen.findByText('Mamá López');
    // Mamá coincide: no sale para invitar. Pedro y Lucía sí.
    expect(screen.queryByRole('checkbox', { name: 'Mamá' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pedro' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lucía' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invitar a 2 contactos' }));
    await waitFor(() => expect(c.shareInvite).toHaveBeenCalledTimes(1));
    const [, url, count] = c.shareInvite.mock.calls[0];
    expect(url).toBe('https://alwaysconnected.vercel.app/i/AbCdEf1234');
    expect(url).not.toMatch(/55|lucia|@/);
    expect(count).toBe(2);
  });

  it('si se pasa de la cuota, lo dice en vez de fallar en silencio', async () => {
    c.contactsStatus.mockResolvedValue({ status: 'authorized', limitedPickerAvailable: false });
    const { ContactsMatchError } = await import('@/lib/contacts');
    c.matchContacts.mockRejectedValue(new ContactsMatchError('CONTACTS_RATE_LIMIT'));
    montar();
    expect(await screen.findByText(/Has buscado muchos contactos hoy/)).toBeInTheDocument();
  });
});
