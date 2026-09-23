import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { LogOut, Award, TrendingUp, Calendar, Star, Pencil, Zap, Ban, Trash2, FileText, Shield, Loader2, ChevronRight, Bell, Contact } from 'lucide-react';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { BADGE_ICONS } from '@/lib/categoryIcons';
import { EditProfileSheet } from '@/components/profile/EditProfileSheet';
import { Skeleton } from '@/components/ui/skeleton';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAuthStore } from '@/stores/authStore';
import { supabase } from '@/integrations/supabase/client';
import { BADGE_DEFINITIONS } from '@/lib/constants';
import { PRIVACY_URL, TERMS_URL, SUPPORT_EMAIL } from '@/lib/legal';
import { BlockedUsersSheet } from '@/components/moderation/BlockedUsersSheet';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/ui/user-avatar';
import { formatOrigin } from '@/lib/origin';
import { pageTitle } from '@/lib/brand';
import { VerificationCard } from '@/components/profile/VerificationCard';
import { VerifyInstitutionSheet } from '@/components/profile/VerifyInstitutionSheet';
import { formatAffiliation, type VerificationState } from '@/lib/institutions';
import { BADGE_TARGETS, badgeProgress, type MyParticipation } from '@/lib/badges';
import type { BadgeType } from '@/lib/categoryIcons';

export default function Profile() {
  const { profile, signOut, fetchProfile } = useAuthStore();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [stats, setStats] = useState({ attended: 0, created: 0 });
  const [badges, setBadges] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<BadgeType, number> | null>(null);
  const [pointsHistory, setPointsHistory] = useState<{ id: string; points: number; reason: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  const originLabel = formatOrigin(profile?.origin, i18n.language || 'es');
  const [verification, setVerification] = useState<VerificationState | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(true);
  const [verifyOpen, setVerifyOpen] = useState(false);

  // El estado de la verificación institucional. Si falla, la tarjeta cae a
  // "Falta verificar": invitar de más no rompe nada; esconderla sí.
  const loadVerification = async () => {
    const { data, error } = await supabase.rpc('my_institution_verification');
    if (error) console.error('my_institution_verification:', error.message);
    setVerification(data?.[0] ?? null);
    setVerificationLoading(false);
  };

  useEffect(() => {
    fetchProfile();
    loadVerification();
  }, [fetchProfile]);

  useEffect(() => {
    if (!profile) return;
    // Son cuatro consultas encadenadas. Sin esta bandera, cambiar de perfil a
    // mitad dejaba dos ejecuciones vivas y podía ganar la vieja, pintando
    // estadísticas que no son de quien se está mirando.
    let cancelada = false;
    const fetchStats = async () => {
      setLoading(true);
      try {
        const { count: created, error: errCreados } = await supabase
          .from('events')
          .select('*', { count: 'exact', head: true })
          .eq('creator_id', profile.id);

        const { count: attended, error: errAsistidos } = await supabase
          .from('event_participants')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('checked_in', true);

        if (cancelada) return;
        // Un cero por fallo de red se leía como "no has organizado nada",
        // que es justo lo contrario de lo que anima a nadie.
        if (errCreados || errAsistidos) {
          toast({ title: t('errors.statsLoad'), variant: 'destructive' });
          return;
        }
        setStats({ created: created ?? 0, attended: attended ?? 0 });

        const { data: badgeData } = await supabase
          .from('badges')
          .select('badge_type')
          .eq('user_id', profile.id);
        if (cancelada) return;
        if (badgeData) setBadges(badgeData.map((b) => b.badge_type));

        // Para decir cuánto falta en cada insignia bloqueada. Solo las filas
        // propias, que la RLS ya deja leer.
        const { data: mine } = await supabase
          .from('event_participants')
          .select('status, checked_in, joined_at, events(category)')
          .eq('user_id', profile.id);
        if (cancelada) return;
        if (mine) {
          const rows: MyParticipation[] = mine.map((r) => ({
            status: r.status,
            checked_in: r.checked_in,
            joined_at: r.joined_at,
            category: (r.events as { category: string } | null)?.category ?? null,
          }));
          setProgress(badgeProgress(created ?? 0, rows));
        }

        const { data: historyData } = await supabase
          .from('point_events')
          .select('id, points, reason, created_at')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: false })
          .limit(10);
        if (cancelada) return;
        if (historyData) setPointsHistory(historyData);
      } finally {
        // El spinner sí se apaga aunque se haya cancelado: si no, al cambiar
        // de perfil se quedaría girando para siempre.
        setLoading(false);
      }
    };
    fetchStats();
    return () => { cancelada = true; };
  }, [profile, t, toast]);

  // Borrado de cuenta (App Store 5.1.1 v). La Edge Function saca la
  // identidad del JWT, así que solo puede borrar al que la llama.
  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
    if (error) {
      toast({ title: t('deleteAccount.failed'), description: error.message, variant: 'destructive' });
      setDeleting(false);
      return;
    }
    // La sesión apunta a un usuario que ya no existe: cerrarla deja la app
    // en la pantalla de login.
    await signOut();
  };

  const DELETE_KEYWORD = t('deleteAccount.keyword');

  if (!profile) {
    return (
      <div className="min-h-screen pb-nav px-4 pt-safe space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  const reputationPercent = Math.min((profile.reputation / 1000) * 100, 100);
  const rankKey =
    profile.reputation < 250 ? 'newcomer' :
    profile.reputation < 500 ? 'regular' :
    profile.reputation < 750 ? 'active' : 'legend';

  return (
    <div className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet>
        <title>{pageTitle(t('profile.title'))}</title>
        <meta name="description" content={t('profile.metaDesc')} />
        <link rel="canonical" href="/profile" />
        <meta property="og:title" content={pageTitle(t('profile.title'))} />
        <meta property="og:description" content={t('profile.metaDesc')} />
        <meta property="og:url" content="/profile" />
      </Helmet>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-extrabold text-foreground">{t('profile.title')}</h1>
        <div className="flex items-center gap-3">
          <NotificationBell className="-m-1" />
          <LanguageSwitcher />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button aria-label={t('profile.signOut')} className="w-11 h-11 inline-flex items-center justify-center -m-2 text-muted-foreground">
                <LogOut className="w-5 h-5" />
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('profile.signOutConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('profile.signOutConfirmDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={signOut}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t('profile.signOut')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Profile card */}
      <div className="bg-card rounded-2xl p-5 shadow-soft mb-5">
        <div className="flex items-center gap-4">
          <UserAvatar
            url={profile.avatar_url}
            name={profile.name}
            className="w-16 h-16 bg-primary/10"
            textClassName="text-2xl text-primary"
          />
          <div className="flex-1">
            <h2 className="text-lg font-extrabold text-foreground">{profile.name ?? t('profile.student')}</h2>
            {verification && formatAffiliation(verification, t) && (
              <p className="text-sm font-semibold text-foreground/80">{formatAffiliation(verification, t)}</p>
            )}
            <p className="text-sm text-muted-foreground">{profile.major ?? t('profile.noMajor')}</p>
            <p className="text-xs text-muted-foreground">
              {profile.residence_type ? t('residence.' + profile.residence_type) : ''}
              {originLabel && ` · ${originLabel}`}
              {' · '}{t('profile.semester')} {profile.semester ?? '—'}
            </p>
            {/* Solo si hay: la matrícula sale del correo institucional, así que
                quien entró con un correo genérico no tiene ninguna, y una línea
                con un guion no informa de nada. No es editable a propósito —
                la escribe el servidor en el alta. */}
            {profile.student_id && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('profile.studentId')}{' '}
                <span className="font-mono">{profile.student_id}</span>
              </p>
            )}
          </div>
          <button
            onClick={() => setEditOpen(true)}
            aria-label={t('profile.edit')}
            className="w-11 h-11 inline-flex items-center justify-center -m-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
        </div>

        {/* Interests */}
        {profile.interests && profile.interests.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {profile.interests.map((i: string) => (
              <span key={i} className="px-2.5 py-1 bg-muted rounded-full text-xs font-medium text-muted-foreground">
                {t('interests.' + i)}
              </span>
            ))}
          </div>
        )}
      </div>

      <VerificationCard state={verification} loading={verificationLoading} onOpen={() => setVerifyOpen(true)} />
      {verifyOpen && (
        <VerifyInstitutionSheet onClose={() => setVerifyOpen(false)} onChanged={loadVerification} />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { key: 'attended', value: stats.attended, icon: Calendar },
          { key: 'created', value: stats.created, icon: Star },
          { key: 'points', value: profile.points, icon: TrendingUp },
        ].map(stat => (
          <div key={stat.key} className="bg-card rounded-2xl p-4 shadow-soft text-center">
            <stat.icon className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-xl font-extrabold text-foreground">{stat.value}</p>
            <p className="text-xs text-muted-foreground font-semibold">{t(`profile.${stat.key}`)}</p>
          </div>
        ))}
      </div>

      {/* Reputation ring */}
      <div className="bg-card rounded-2xl p-5 shadow-soft mb-5">
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <Award className="w-4 h-4 text-primary" />
          {t('profile.reputation')}
        </h3>
        <div className="flex items-center gap-4">
          <div className="relative w-20 h-20">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 36 36">
              <path
                d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="hsl(var(--muted))"
                strokeWidth="3"
              />
              <path
                d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="hsl(var(--primary))"
                strokeWidth="3"
                strokeDasharray={`${reputationPercent}, 100`}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold text-foreground">
              {Math.round(profile.reputation)}
            </span>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t(`profile.rank.${rankKey}`)}</p>
            <p className="text-xs text-muted-foreground">{Math.round(1000 - profile.reputation)} {t('profile.ptsToNext')}</p>
          </div>
        </div>
      </div>

      {/* Badges */}
      <div className="bg-card rounded-2xl p-5 shadow-soft">
        <h3 className="text-sm font-bold text-foreground mb-3">{t('profile.badges')}</h3>
        <div className="grid grid-cols-2 gap-3">
          {BADGE_DEFINITIONS.map(badge => {
            const earned = badges.includes(badge.type);
            const target = BADGE_TARGETS[badge.type];
            const current = earned ? target : progress?.[badge.type] ?? 0;
            const Icon = BADGE_ICONS[badge.type];
            return (
              <div
                key={badge.type}
                className={cn(
                  'flex flex-col gap-1.5 p-3 rounded-xl text-left',
                  earned ? 'bg-primary/10' : 'bg-muted/50',
                )}
              >
                <Icon aria-hidden="true" className={cn('w-6 h-6', earned ? 'text-primary' : 'text-muted-foreground/60')} />
                <span className="text-xs font-bold text-foreground leading-tight">{t('badges.' + badge.type)}</span>
                {/* Bloqueada no basta: sin decir cómo se gana, la insignia
                    gris no invita a nada. */}
                <span className="text-[11px] text-muted-foreground leading-snug">
                  {earned ? t('badges.earned') : t(`badges.how.${badge.type}`, { count: target })}
                </span>
                {!earned && progress && (
                  <div className="mt-auto pt-1">
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={target}
                      aria-valuenow={current}
                      aria-label={t('badges.progress', { current, target })}
                      className="h-1.5 rounded-full bg-muted overflow-hidden"
                    >
                      <div className="h-full bg-primary rounded-full" style={{ width: `${(current / target) * 100}%` }} />
                    </div>
                    <span className="block mt-1 text-[11px] font-semibold text-muted-foreground">
                      {current}/{target}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Points history */}
      <div className="bg-card rounded-2xl p-5 shadow-soft mt-5">
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          {t('pointsHistory.title')}
        </h3>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex justify-between items-center py-1">
                <div className="h-4 bg-muted rounded w-2/3" />
                <div className="h-4 bg-muted rounded w-10" />
              </div>
            ))}
          </div>
        ) : pointsHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pointsHistory.empty')}</p>
        ) : (
          <div className="space-y-2">
            {pointsHistory.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-foreground">{t(`pointsHistory.${entry.reason}`)}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(entry.created_at), 'MMM d, yyyy')}
                  </p>
                </div>
                <span className="text-sm font-bold text-primary">+{entry.points}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cuenta, privacidad y seguridad */}
      <div className="bg-card rounded-2xl shadow-soft mt-5 overflow-hidden">
        <h3 className="text-sm font-bold text-foreground px-5 pt-5 pb-2">{t('account.title')}</h3>

        <button
          onClick={() => navigate('/settings/notifications')}
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border text-left hover:bg-muted/40 transition-colors"
        >
          <Bell className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('notificationSettings.title')}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>

        <button
          onClick={() => navigate('/friends/find')}
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border text-left hover:bg-muted/40 transition-colors"
        >
          <Contact className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('findFriends.contactsSettings')}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>

        <button
          onClick={() => setBlockedOpen(true)}
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border text-left hover:bg-muted/40 transition-colors"
        >
          <Ban className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('moderation.blockedTitle')}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>

        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border hover:bg-muted/40 transition-colors"
        >
          <Shield className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('legal.privacy')}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>

        <a
          href={TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border hover:bg-muted/40 transition-colors"
        >
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('legal.terms')}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>

        <button
          onClick={() => { setDeleteConfirm(''); setDeleteOpen(true); }}
          className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border text-left hover:bg-destructive/5 transition-colors"
        >
          <Trash2 className="w-4 h-4 text-destructive shrink-0" />
          <span className="flex-1 text-sm font-medium text-destructive">{t('deleteAccount.action')}</span>
        </button>
      </div>

      <p className="text-xs text-muted-foreground text-center mt-4 px-4">
        {t('moderation.contactNote')}{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary font-semibold">{SUPPORT_EMAIL}</a>
      </p>

      {/* Confirmación de borrado: escribir la palabra, porque no hay vuelta atrás */}
      <AlertDialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteAccount.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteAccount.confirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label htmlFor="delete-confirm" className="text-xs font-semibold text-muted-foreground">
              {t('deleteAccount.typeToConfirm', { keyword: DELETE_KEYWORD })}
            </label>
            <Input
              id="delete-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              className="h-11 rounded-xl"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteConfirm.trim().toUpperCase() !== DELETE_KEYWORD || deleting}
              onClick={(e) => { e.preventDefault(); handleDeleteAccount(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : t('deleteAccount.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {blockedOpen && <BlockedUsersSheet onClose={() => setBlockedOpen(false)} />}

      {editOpen && (
        <EditProfileSheet profile={profile} onClose={() => setEditOpen(false)} />
      )}
    </div>
  );
}
