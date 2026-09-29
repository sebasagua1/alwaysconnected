import { create } from 'zustand';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { User, Session } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { unregisterPush } from '@/lib/push';

type Profile = Database['public']['Tables']['profiles']['Row'];

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** No se pudo saber si hay sesión. 'network': hay una guardada pero sin
   *  conexión no se puede renovar. 'unknown': supabase-js lanzó algo raro. */
  sessionError: 'network' | 'unknown' | null;
  /** false hasta que el primer fetchProfile termina, haya perfil o no. Sin
   *  esto no se puede distinguir "todavía no se ha pedido" de "no hay". */
  profileLoaded: boolean;
  /** El PRIMER perfil no llegó (red, tiempo agotado, servidor). No es lo mismo
   *  que «no existe»: de este no se sabe nada, así que no se puede decidir. */
  profileError: string | null;
  profileFetching: boolean;
  /** El enlace del correo de recuperación abre sesión por su cuenta. Sin esta
   *  bandera el usuario entraría a la app sin llegar a cambiar la contraseña. */
  passwordRecovery: boolean;
  setPasswordRecovery: (v: boolean) => void;
  setSession: (session: Session | null) => void;
  setProfile: (profile: Profile | null) => void;
  setLoading: (loading: boolean) => void;
  /** Lee la sesión guardada (y la renueva si caducó). Se usa al arrancar y al
   *  pulsar Reintentar. */
  resolveSession: () => Promise<void>;
  signOut: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  profile: null,
  loading: true,
  sessionError: null,
  profileLoaded: false,
  profileError: null,
  profileFetching: false,
  // Se decide antes del primer render: supabase-js consume el hash de la URL
  // al arrancar, y para entonces el evento PASSWORD_RECOVERY puede haber
  // pasado ya sin que nadie escuchara.
  passwordRecovery:
    typeof window !== 'undefined' && window.location.hash.includes('type=recovery'),
  setPasswordRecovery: (passwordRecovery) => set({ passwordRecovery }),
  setSession: (session) => set({ session, user: session?.user ?? null }),
  setProfile: (profile) => set({ profile }),
  setLoading: (loading) => set({ loading }),
  resolveSession: async () => {
    set({ loading: true });
    try {
      const { data, error } = await supabase.auth.getSession();
      // Con el token caducado y sin red, supabase-js no borra la sesión
      // guardada (no puede saber si sigue valiendo) pero devuelve null. Antes
      // eso mandaba al login a quien ya tenía sesión, como si se la hubieran
      // cerrado. Si vuelve la red, el refresco automático emite
      // TOKEN_REFRESHED y AuthGate entra solo, sin tocar nada.
      if (error && isAuthRetryableFetchError(error)) {
        console.error('resolveSession: sin red para renovar la sesión:', error.message);
        // Mientras esta lectura esperaba, la red pudo volver y el refresco
        // automático renovar la sesión (TOKEN_REFRESHED ya la dejó en el
        // store). Este error es de antes: no puede tapar una sesión buena.
        // Pasó en el simulador: la app volvía a «Sin conexión» ya renovada.
        set(get().session ? { loading: false } : { loading: false, sessionError: 'network' });
        return;
      }
      // Cualquier otro error (refresh token revocado o caducado) lo trata
      // supabase-js borrando la sesión: aquí llega null y toca el login.
      const { session } = data;
      // No pisar con null lo que ya haya en el store: en un arranque en frío
      // desde el enlace del correo, deepLinks.ts puede abrir la sesión mientras
      // esta lectura está en vuelo, y llegar después para dejarla en nada.
      if (session || !get().session) get().setSession(session);
      set({ loading: false, sessionError: null });
    } catch (err) {
      // getSession no debería lanzar, pero si lo hace (un lock de supabase-js
      // que no se consigue) sin este catch `loading` no volvía a false nunca.
      console.error('resolveSession:', err);
      set({ loading: false, sessionError: 'unknown' });
    }
  },
  signOut: async () => {
    // Antes del signOut: dar de baja el token necesita la sesión todavía viva.
    await unregisterPush();
    await supabase.auth.signOut();
    set({
      user: null, session: null, profile: null, profileLoaded: false, profileError: null,
      sessionError: null, passwordRecovery: false,
    });
  },
  fetchProfile: async () => {
    const { user } = get();
    if (!user) return;
    set({ profileFetching: true });
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    // Se cerró sesión (o entró otra persona) mientras llegaba: esto ya no es
    // de nadie. Sin la comprobación, marcaba profileLoaded y el siguiente
    // inicio de sesión se saltaba la carga del perfil.
    if (get().user?.id !== user.id) {
      set({ profileFetching: false });
      return;
    }
    // Aquí no hay toast (esto es un store, no un componente). Se registra
    // porque un fallo deja al usuario sin perfil y el síntoma —volver al
    // onboarding— no apunta a la causa.
    if (error) console.error('fetchProfile falló:', error.message);
    // «No hay fila» (PGRST116) es una respuesta: el perfil no existe (por
    // ejemplo si falló el trigger que lo crea). Se da por cargado, porque
    // quedarse esperando dejaría la app colgada para siempre.
    //
    // Cualquier otro error (sin red, tiempo agotado, servidor caído) no dice
    // nada del perfil. Si es la primera carga, AuthGate lo enseña con
    // Reintentar; antes se entraba a la app con el perfil vacío. Si ya había
    // uno (un refresco tras editar), se conserva el que había.
    if (error && error.code !== 'PGRST116') {
      set(get().profileLoaded
        ? { profileFetching: false }
        : { profileFetching: false, profileError: error.message });
      return;
    }
    set(data
      ? { profile: data, profileLoaded: true, profileError: null, profileFetching: false }
      : { profileLoaded: true, profileError: null, profileFetching: false });
  },
}));
