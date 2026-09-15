import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';
import { InstitutionPicker, INSTITUTION_SEARCH_DEBOUNCE_MS } from '@/components/ui/institution-picker';
import { VerifyInstitutionSheet } from '@/components/profile/VerifyInstitutionSheet';
import { VerificationCard } from '@/components/profile/VerificationCard';
import Onboarding from '@/pages/Onboarding';
import { describeInstitution, formatAffiliation, verificationCardMode, type InstitutionResult, type VerificationState } from '@/lib/institutions';

const r = (o: Partial<InstitutionResult> & Pick<InstitutionResult, 'campus_id' | 'university_name' | 'country_code'>): InstitutionResult => ({
  campus_name: null, campus_city: null, university_id: `u-${o.campus_id}`, short_name: null, institution_type: 'university',
  state_region: null, city: null, campus_count: 1, verification_available: false, email_verified: false, ...o,
});

const TEC_QRO = r({ campus_id: '1a898a3a-53c0-4468-8dc6-b03bef169a6e', university_id: 'tec', university_name: 'Tecnológico de Monterrey', country_code: 'MX', campus_name: 'Querétaro', campus_city: 'Querétaro', state_region: 'Querétaro', campus_count: 14 });
const BOLIVAR = r({ campus_id: 'bolivar', university_name: 'Colegio Bolívar', country_code: 'CO', city: 'Cali', state_region: 'Valle del Cauca', institution_type: 'school' });
const FSU = r({ campus_id: 'fsu', university_name: 'Florida State University', country_code: 'US', city: 'Tallahassee', state_region: 'Florida', verification_available: true });
const LA_SALLE_MX = r({ campus_id: 'lsmx', university_name: 'Universidad La Salle', country_code: 'MX', city: 'Ciudad de México', state_region: 'Ciudad de México' });
const LA_SALLE_CO = r({ campus_id: 'lsco', university_name: 'Universidad de La Salle', country_code: 'CO', city: 'Bogotá', state_region: 'Bogotá D.C.' });

function diferida<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const rpc = vi.fn();
const invoke = vi.fn();
const toast = vi.fn();
const fetchProfile = vi.fn();
const eq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn((_datos: Record<string, unknown>) => ({ eq }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      const p = () => rpc(name, args);
      return { abortSignal: p, then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => p().then(a, b) };
    },
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: vi.fn(() => ({ update })),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/stores/authStore', () => {
  const state = { user: { id: 'u1' }, profile: { campus_id: null }, profileLoaded: true, fetchProfile: (...a: unknown[]) => fetchProfile(...a) };
  const useAuthStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  return { useAuthStore };
});

const busquedas = () => rpc.mock.calls.filter(([n]) => n === 'search_institutions');
const opciones = () => screen.getAllByRole('button', { pressed: false }).concat(screen.queryAllByRole('button', { pressed: true })).filter((b) => b.closest('li'));

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  rpc.mockImplementation((name: string) =>
    Promise.resolve(name === 'search_institutions' ? { data: [TEC_QRO, BOLIVAR, FSU, LA_SALLE_MX, LA_SALLE_CO], error: null } : { data: null, error: null }));
  await i18n.changeLanguage('es');
});

describe('lib/institutions', () => {
  const t = i18n.t.bind(i18n);
  it('describe cada resultado con campus, ciudad, país y tipo; una escuela no es universidad', () => {
    expect(describeInstitution(TEC_QRO, t, 'es')).toEqual({ title: 'Tecnológico de Monterrey — Campus Querétaro', subtitle: 'Querétaro · México · Universidad' });
    expect(describeInstitution(BOLIVAR, t, 'es').subtitle).toBe('Cali, Valle del Cauca · Colombia · Colegio');
    expect(describeInstitution(LA_SALLE_MX, t, 'es').subtitle).not.toBe(describeInstitution(LA_SALLE_CO, t, 'es').subtitle);
  });

  it('formatea la afiliación pública y el modo de la tarjeta', () => {
    expect(formatAffiliation({ university_name: 'Tecnológico de Monterrey', campus_name: 'Querétaro' }, t)).toBe('Tecnológico de Monterrey · Campus Querétaro');
    expect(formatAffiliation({ university_name: null }, t)).toBeNull();
    expect(verificationCardMode(null)).toBe('unverified');
    expect(verificationCardMode({ status: 'pending_email', pending_email_masked: 'a***@fsu.edu' } as VerificationState)).toBe('pending');
    expect(verificationCardMode({ status: 'expired' } as VerificationState)).toBe('unverified');
  });
});

describe('InstitutionPicker', () => {
  it('carga sugerencias al abrir y describe cada opción', async () => {
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(opciones()).toHaveLength(5));
    expect(busquedas()[0][1]).toMatchObject({ _query: null, _country_code: null });
    expect(screen.getByText('Cali, Valle del Cauca · Colombia · Colegio')).toBeInTheDocument();
  });

  it('busca en el servidor mientras se escribe, una vez por ráfaga y sin botón', async () => {
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(busquedas()).toHaveLength(1));
    const input = screen.getByRole('searchbox', { name: /Nombre, siglas o ciudad/ });
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.change(input, { target: { value: 'que' } });
    fireEvent.change(input, { target: { value: 'queretaro' } });
    await waitFor(() => expect(busquedas()).toHaveLength(2), { timeout: INSTITUTION_SEARCH_DEBOUNCE_MS + 1000 });
    expect(busquedas()[1][1]).toMatchObject({ _query: 'queretaro' });
    expect(screen.queryByRole('button', { name: /^Buscar$/ })).not.toBeInTheDocument();
  });

  it('una respuesta vieja no pisa la última búsqueda', async () => {
    const vieja = diferida<unknown>();
    rpc.mockImplementation((_n: string, args: { _query: string | null }) =>
      args._query === 'tec' ? vieja.promise : Promise.resolve({ data: args._query ? [FSU] : [TEC_QRO], error: null }));
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    const input = await screen.findByRole('searchbox');
    fireEvent.change(input, { target: { value: 'tec' } });
    await waitFor(() => expect(busquedas().some(([, a]) => (a as { _query: string })._query === 'tec')).toBe(true), { timeout: 1000 });
    fireEvent.change(input, { target: { value: 'florida' } });
    expect(await screen.findByText('Florida State University', {}, { timeout: 1000 })).toBeInTheDocument();
    await act(async () => { vieja.resolve({ data: [BOLIVAR], error: null }); });
    expect(screen.queryByText('Colegio Bolívar')).not.toBeInTheDocument();
  });

  it('filtra por país', async () => {
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(busquedas()).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('group', { name: 'Filtrar por país' })).getByRole('button', { name: 'Colombia' }));
    await waitFor(() => expect(busquedas().at(-1)![1]).toMatchObject({ _country_code: 'CO' }));
  });

  it('elegir devuelve el campus', async () => {
    const onChange = vi.fn();
    render(<InstitutionPicker value={null} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Tecnológico de Monterrey — Campus Querétaro/ }));
    expect(onChange).toHaveBeenCalledWith(TEC_QRO.campus_id, TEC_QRO);
  });

  it('sin resultados ofrece solicitar la institución, sin pedir dominio', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'search_institutions' ? { data: [], error: null } : { data: 'req-1', error: null }));
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByText('No encontramos esa institución.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Universidad Nueva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar que agreguemos mi institución' }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).queryByLabelText(/dominio|correo/i)).not.toBeInTheDocument();
    expect(within(dialogo).getByLabelText('Nombre de la institución')).toHaveValue('Universidad Nueva');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_institution', expect.objectContaining({ _kind: 'add_institution', _institution_name: 'Universidad Nueva' })));
  });

  it('avisa del error y reintenta', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    const aviso = await screen.findByRole('alert');
    fireEvent.click(within(aviso).getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(opciones()).toHaveLength(5));
  });

  it('con correo verificable explica por qué solo salen sus campus y no ofrece otras', async () => {
    rpc.mockResolvedValue({ data: [{ ...FSU, email_verified: true }], error: null });
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/Tu correo es de Florida State University/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filtrar por país' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar que agreguemos mi institución' })).not.toBeInTheDocument();
  });
});

describe('Onboarding con el buscador', () => {
  it('guarda el campus elegido', async () => {
    render(<HelmetProvider><Onboarding /></HelmetProvider>);
    const boton = await screen.findByRole('button', { name: /Colegio Bolívar/ });
    fireEvent.click(boton);
    expect(boton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.change(screen.getByLabelText(/Nombre completo/), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByLabelText('Tengo 18 años o más'));
    fireEvent.click(screen.getByLabelText(/He leído y acepto los/));
    fireEvent.click(screen.getByRole('button', { name: 'Comenzar' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toMatchObject({ campus_id: 'bolivar', onboarding_completed: true });
  });
});

const estado = (o: Partial<VerificationState>): VerificationState => ({
  status: 'unverified', status_reason: null, university_id: 'fsu-u', university_name: 'Florida State University', institution_type: 'university',
  campus_id: 'fsu', campus_name: null, email_masked: null, verification_method: null, verified_at: null, pending_email_masked: null,
  pending_expires_at: null, pending_resend_after: null, pending_attempts_left: null, verification_available: true, ...o,
});

describe('Verificar institución', () => {
  it('la tarjeta dice "Falta verificar tu perfil" y la cuenta sigue usable', () => {
    const onOpen = vi.fn();
    render(<VerificationCard state={estado({})} loading={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Falta verificar tu perfil/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('envía el código a la Edge Function y confirma sin cambiar la cuenta', async () => {
    let verificado = false;
    rpc.mockImplementation((name: string, args: { _code?: string }) => {
      if (name === 'my_institution_verification') return Promise.resolve({ data: [verificado ? estado({ status: 'verified', email_masked: 'n***@fsu.edu' }) : estado({})], error: null });
      if (name === 'confirm_institution_verification') {
        verificado = args._code === '123456';
        return Promise.resolve({ data: [{ status: verificado ? 'VERIFIED' : 'INVALID_CODE', attempts_left: 4 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    invoke.mockResolvedValue({ data: { status: 'SENT', email_masked: 'n***@fsu.edu', resend_after: new Date(Date.now() - 1000).toISOString() }, error: null });

    render(<VerifyInstitutionSheet onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Correo institucional'), { target: { value: 'nole@fsu.edu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código a mi correo institucional' }));
    expect(await screen.findByText(/Enviamos un código de 6 dígitos a n\*\*\*@fsu\.edu/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('institution-verification', { body: expect.objectContaining({ university_id: 'fsu-u', campus_id: 'fsu', email: 'nole@fsu.edu' }) });
    // El cuerpo nunca pide contraseña.
    expect(screen.queryByLabelText(/contraseña/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Código'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByText('Código incorrecto. Te quedan 4 intentos.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Código'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByText('Tu institución está verificada')).toBeInTheDocument();
    expect(fetchProfile).toHaveBeenCalled();
  });

  it('un correo personal o de relay no se acepta, con un mensaje claro', async () => {
    rpc.mockResolvedValue({ data: [estado({})], error: null });
    invoke.mockResolvedValue({ data: { status: 'PERSONAL_EMAIL' }, error: null });
    render(<VerifyInstitutionSheet onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Correo institucional'), { target: { value: 'x@private.icloud.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código a mi correo institucional' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no uno personal');
  });

  it('si el correo ya verifica otra cuenta, el mensaje es genérico', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'my_institution_verification'
      ? { data: [estado({ status: 'pending_email', pending_email_masked: 'c***@fsu.edu' })], error: null }
      : { data: [{ status: 'MANUAL_REVIEW', attempts_left: 0 }], error: null }));
    render(<VerifyInstitutionSheet onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Código'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent('La revisaremos manualmente');
    expect(aviso.textContent).not.toMatch(/otra cuenta|ya está en uso|in use/i);
  });

  it('sin verificación automática ofrece revisión manual y no muestra el formulario', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'my_institution_verification'
      ? { data: [estado({ university_name: 'Colegio Bolívar', institution_type: 'school', verification_available: false })], error: null }
      : { data: 'req', error: null }));
    const onClose = vi.fn();
    render(<VerifyInstitutionSheet onClose={onClose} />);
    expect(await screen.findByText(/todavía no tiene verificación automática/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Correo institucional')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar revisión manual' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_institution', expect.objectContaining({ _kind: 'manual_verification' })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
