import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';

/**
 * Lleva a las preferencias de notificaciones la zona horaria del teléfono y
 * el idioma de la app. El servidor los necesita para dos cosas: el horario
 * silencioso y las franjas de día se calculan en la hora de cada persona, y
 * el texto de la push sale en su idioma.
 *
 * Solo escribe si algo cambió (viajar, cambiar el idioma en el selector).
 * Si la base aún no tiene la tabla, no pasa nada: se reintenta al volver.
 */
export function useNotificationPrefsSync() {
  const userId = useAuthStore((s) => s.user?.id);
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith('en') ? 'en' : 'es';

  useEffect(() => {
    if (!userId) return;
    let tz = 'America/Mexico_City';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
    } catch {
      // Sin Intl completo: se queda la de por defecto.
    }
    (async () => {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('timezone, locale')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return;
      if (!data) {
        await supabase.from('notification_preferences').insert({ user_id: userId, timezone: tz, locale });
        return;
      }
      const patch: { timezone?: string; locale?: string } = {};
      if (data.timezone !== tz) patch.timezone = tz;
      if (data.locale !== locale) patch.locale = locale;
      if (Object.keys(patch).length > 0) {
        const { error: e } = await supabase.from('notification_preferences').update(patch).eq('user_id', userId);
        // Una zona que el servidor no reconoce se rechaza (INVALID_TIMEZONE):
        // se prueba al menos con el idioma.
        if (e && patch.locale) await supabase.from('notification_preferences').update({ locale }).eq('user_id', userId);
      }
    })().catch((err) => console.error('preferencias de notificaciones:', err));
  }, [userId, locale]);
}
