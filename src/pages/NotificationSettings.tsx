import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, BellOff, ShieldCheck } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { registerPush } from '@/lib/push';
import { openAppSettings } from '@/lib/contacts';
import type { Database } from '@/integrations/supabase/types';
import { pageTitle } from '@/lib/brand';
import { cn } from '@/lib/utils';

type Prefs = Database['public']['Tables']['notification_preferences']['Row'];
type BoolKey = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never;
}[keyof Prefs];

const REMINDER_OPTIONS = [15, 30, 60, 120, 1440] as const;

/** Un interruptor accesible: role="switch" y 44px de alto. */
function Toggle({ label, help, checked, onChange, disabled }: {
  label: string; help?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 min-h-[52px] px-4 py-2 text-left disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {help && <span className="block text-xs text-muted-foreground">{help}</span>}
      </span>
      <span
        aria-hidden="true"
        className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0', checked ? 'bg-primary' : 'bg-muted-foreground/30')}
      >
        <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2 px-1">{title}</h2>
      <div className="bg-card rounded-2xl shadow-soft divide-y divide-border overflow-hidden">{children}</div>
    </section>
  );
}

export default function NotificationSettings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState<Array<{ event_id: string; title: string }>>([]);
  const [pushState, setPushState] = useState<'granted' | 'denied' | 'prompt' | 'web'>('web');

  const load = useCallback(async () => {
    if (!userId) return;
    setFailed(false);
    let { data, error } = await supabase.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle();
    if (!error && !data) {
      // Cuenta anterior a las preferencias: se crea con los valores por defecto.
      ({ data, error } = await supabase.from('notification_preferences').insert({ user_id: userId }).select('*').single());
    }
    if (error || !data) { setFailed(true); return; }
    setPrefs(data);
    const { data: m } = await supabase.rpc('muted_event_chats');
    setMuted((m ?? []).map((x) => ({ event_id: x.event_id, title: x.title })));
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    PushNotifications.checkPermissions()
      .then((p) => setPushState(p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'prompt'))
      .catch(() => setPushState('prompt'));
  }, []);

  /** Guarda un campo; si el servidor dice que no, vuelve atrás y lo dice. */
  const save = async <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    if (!prefs || !userId) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: value });
    const { data, error } = await supabase
      .from('notification_preferences')
      .update({ [key]: value } as Partial<Prefs>)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error || !data) {
      setPrefs(before);
      toast({ title: t('notificationSettings.saveFailed'), description: error?.message, variant: 'destructive' });
      return;
    }
    setPrefs(data);
  };

  const bool = (key: BoolKey, label: string, help?: string) =>
    prefs && <Toggle label={label} help={help} checked={Boolean(prefs[key])} onChange={(v) => void save(key, v as Prefs[typeof key])} />;

  const unmute = async (eventId: string) => {
    const { error } = await supabase.rpc('set_event_chat_muted', { _event_id: eventId, _muted: false });
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      return;
    }
    setMuted((prev) => prev.filter((m) => m.event_id !== eventId));
  };

  const enablePush = async () => {
    await registerPush();
    const p = await PushNotifications.checkPermissions();
    setPushState(p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'prompt');
  };

  const goBack = () => (location.key === 'default' ? navigate('/profile') : navigate(-1));
  const time = (v: string) => v.slice(0, 5);

  return (
    <div className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet><title>{pageTitle(t('notificationSettings.title'))}</title></Helmet>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={goBack} className="p-3 -m-2 text-muted-foreground" aria-label={t('common.back')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="flex-1 ml-1 text-2xl font-extrabold text-foreground">{t('notificationSettings.title')}</h1>
      </div>

      {pushState !== 'granted' && pushState !== 'web' && (
        <div className="mb-5 rounded-2xl border border-warning/40 bg-warning/10 p-4 space-y-2" role="status">
          <p className="text-sm font-semibold text-foreground flex items-center gap-2">
            <BellOff className="w-4 h-4" aria-hidden="true" /> {t('notificationSettings.pushOffTitle')}
          </p>
          <p className="text-xs text-muted-foreground">
            {pushState === 'denied' ? t('notificationSettings.pushDenied') : t('notificationSettings.pushPrompt')}
          </p>
          <Button size="sm" className="rounded-full" onClick={() => (pushState === 'denied' ? void openAppSettings() : void enablePush())}>
            {pushState === 'denied' ? t('findFriends.openSettings') : t('notificationSettings.enablePush')}
          </Button>
        </div>
      )}

      {failed && (
        <div className="text-center py-12 space-y-3" role="alert">
          <p className="text-sm text-muted-foreground">{t('notificationSettings.loadFailed')}</p>
          <Button variant="outline" className="rounded-xl" onClick={() => void load()}>{t('friends.retry')}</Button>
        </div>
      )}

      {!prefs && !failed && (
        <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      )}

      {prefs && (
        <>
          <Section title={t('notificationSettings.activities')}>
            {bool('activity_messages', t('notificationSettings.activityMessages'), t('notificationSettings.activityMessagesHelp'))}
            {bool('mentions', t('notificationSettings.mentions'), t('notificationSettings.mentionsHelp'))}
            {bool('event_updates', t('notificationSettings.eventUpdates'), t('notificationSettings.eventUpdatesHelp'))}
            {bool('event_requests', t('notificationSettings.eventRequests'), t('notificationSettings.eventRequestsHelp'))}
            {bool('reminders', t('notificationSettings.reminders'))}
            {prefs.reminders && (
              <div className="px-4 py-3 flex items-center gap-3">
                <label htmlFor="reminder-minutes" className="flex-1 text-sm text-foreground">{t('notificationSettings.reminderWhen')}</label>
                <select
                  id="reminder-minutes"
                  value={prefs.reminder_minutes}
                  onChange={(e) => void save('reminder_minutes', Number(e.target.value))}
                  className="h-11 rounded-xl border border-input bg-background px-3 text-base"
                >
                  {REMINDER_OPTIONS.map((m) => (
                    <option key={m} value={m}>{t(`notificationSettings.reminderOption.${m}`)}</option>
                  ))}
                </select>
              </div>
            )}
          </Section>

          <Section title={t('notificationSettings.messages')}>
            {bool('direct_messages', t('notificationSettings.directMessages'))}
            {bool('show_previews', t('notificationSettings.showPreviews'), t('notificationSettings.showPreviewsHelp'))}
          </Section>

          <Section title={t('notificationSettings.friends')}>
            {bool('friend_requests', t('notificationSettings.friendRequests'))}
            {bool('friend_activity', t('notificationSettings.friendActivity'), t('notificationSettings.friendActivityHelp'))}
            {bool('people_suggestions', t('notificationSettings.peopleSuggestions'), t('notificationSettings.peopleSuggestionsHelp'))}
          </Section>

          <Section title={t('notificationSettings.discover')}>
            {bool('activity_recommendations', t('notificationSettings.recommendations'), t('notificationSettings.recommendationsHelp'))}
            {bool('digests', t('notificationSettings.digests'), t('notificationSettings.digestsHelp'))}
            <div className="px-4 py-3 flex items-center gap-3">
              <span className="flex-1">
                <span id="social-limit-label" className="block text-sm text-foreground">{t('notificationSettings.dailyLimit')}</span>
                <span className="block text-xs text-muted-foreground">{t('notificationSettings.dailyLimitHelp')}</span>
              </span>
              <div className="flex items-center gap-1" role="group" aria-labelledby="social-limit-label">
                <button
                  onClick={() => void save('daily_social_limit', Math.max(0, prefs.daily_social_limit - 1))}
                  disabled={prefs.daily_social_limit <= 0}
                  aria-label={t('notificationSettings.less')}
                  className="w-11 h-11 rounded-full bg-muted text-foreground font-bold disabled:opacity-40"
                >−</button>
                <span className="w-8 text-center text-sm font-bold" aria-live="polite">{prefs.daily_social_limit}</span>
                <button
                  onClick={() => void save('daily_social_limit', Math.min(10, prefs.daily_social_limit + 1))}
                  disabled={prefs.daily_social_limit >= 10}
                  aria-label={t('notificationSettings.more')}
                  className="w-11 h-11 rounded-full bg-muted text-foreground font-bold disabled:opacity-40"
                >+</button>
              </div>
            </div>
          </Section>

          <Section title={t('notificationSettings.quietHours')}>
            {bool('quiet_hours_enabled', t('notificationSettings.quietHoursEnabled'), t('notificationSettings.quietHoursHelp'))}
            {prefs.quiet_hours_enabled && (
              <div className="px-4 py-3 flex items-center gap-3">
                <label className="flex-1 text-sm text-foreground">
                  {t('notificationSettings.from')}
                  <input
                    type="time"
                    value={time(prefs.quiet_start)}
                    onChange={(e) => e.target.value && void save('quiet_start', e.target.value)}
                    className="block mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-base"
                  />
                </label>
                <label className="flex-1 text-sm text-foreground">
                  {t('notificationSettings.to')}
                  <input
                    type="time"
                    value={time(prefs.quiet_end)}
                    onChange={(e) => e.target.value && void save('quiet_end', e.target.value)}
                    className="block mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-base"
                  />
                </label>
              </div>
            )}
            <p className="px-4 py-3 text-xs text-muted-foreground">{t('notificationSettings.timezone', { tz: prefs.timezone })}</p>
          </Section>

          <Section title={t('notificationSettings.account')}>
            {bool('account_tips', t('notificationSettings.accountTips'), t('notificationSettings.accountTipsHelp'))}
            <div className="px-4 py-3 flex items-center gap-3">
              <ShieldCheck className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
              <span className="flex-1 text-xs text-muted-foreground">{t('notificationSettings.securityAlways')}</span>
            </div>
          </Section>

          <Section title={t('notificationSettings.promotional')}>
            <Toggle
              label={t('notificationSettings.promotionalLabel')}
              help={prefs.promotional && prefs.promotional_consent_at
                ? t('notificationSettings.promotionalGiven', { date: new Date(prefs.promotional_consent_at).toLocaleDateString(i18n.language) })
                : t('notificationSettings.promotionalHelp')}
              checked={prefs.promotional}
              onChange={(v) => void save('promotional', v)}
            />
          </Section>

          <Section title={t('notificationSettings.mutedTitle')}>
            {muted.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('notificationSettings.mutedEmpty')}</p>
            ) : (
              muted.map((m) => (
                <div key={m.event_id} className="px-4 py-2 flex items-center gap-3 min-h-[52px]">
                  <span className="flex-1 min-w-0 text-sm text-foreground truncate">{m.title}</span>
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => void unmute(m.event_id)}>
                    {t('notificationSettings.unmute')}
                  </Button>
                </div>
              ))
            )}
          </Section>
        </>
      )}

    </div>
  );
}
