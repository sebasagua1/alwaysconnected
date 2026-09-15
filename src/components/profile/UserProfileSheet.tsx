import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, BadgeCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { UserAvatar } from '@/components/ui/user-avatar';
import { formatOrigin } from '@/lib/origin';
import { formatAffiliation, institutionTypeLabel } from '@/lib/institutions';

/**
 * Ficha de otra persona.
 *
 * Antes no había forma de ver a alguien: en la búsqueda solo se podía
 * agregar a ciegas, sin saber qué estudia ni qué le interesa, que es
 * justo lo que hace decidir si quieres agregarlo.
 *
 * Lee de `public_profiles`, la vista que deja fuera el email. No hace
 * falta ningún permiso nuevo: ya expone foto, carrera, semestre,
 * intereses, idiomas y reputación.
 */

type PublicProfile = {
  id: string | null;
  name: string | null;
  avatar_url: string | null;
  major: string | null;
  semester: number | null;
  residence_type: string | null;
  interests: string[] | null;
  languages: string[] | null;
  points: number | null;
  reputation: number | null;
  origin: string | null;
  institution_verified: boolean | null;
  university_name: string | null;
  campus_name: string | null;
  institution_type: string | null;
};

interface Props {
  userId: string;
  /** Acción principal: agregar, mandar mensaje… La decide quien la abre. */
  footer?: ReactNode;
  onClose: () => void;
}

export function UserProfileSheet({ userId, footer, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('public_profiles')
        .select('id, name, avatar_url, major, semester, residence_type, interests, languages, points, reputation, origin, institution_verified, university_name, campus_name, institution_type')
        .eq('id', userId)
        .maybeSingle();

      if (cancelled) return;
      if (error || !data) setFailed(true);
      else setProfile(data as PublicProfile);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const originLabel = profile ? formatOrigin(profile.origin, i18n.language || 'es') : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background animate-slide-up">
      <div className="flex items-center justify-between px-5 pb-3 border-b border-border pt-[calc(1.25rem+env(safe-area-inset-top,0px))]">
        <h2 className="text-lg font-extrabold text-foreground">
          {profile?.name ?? t('profile.student')}
        </h2>
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="p-3 -m-2 text-muted-foreground"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : failed || !profile ? (
          <p className="text-center text-sm text-muted-foreground py-12">{t('common.error')}</p>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <UserAvatar
                url={profile.avatar_url}
                name={profile.name}
                className="w-20 h-20 bg-primary/10"
                textClassName="text-3xl text-primary"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-base font-extrabold text-foreground truncate">
                    {profile.name ?? t('profile.student')}
                  </p>
                  {/* La insignia es lo que hace que verificar sirva de algo:
                      sin nada visible, la comprobación del servidor no cambia
                      en qué se fija quien mira el perfil. */}
                  {profile.institution_verified && (
                    <BadgeCheck
                      className="w-4 h-4 shrink-0 text-primary"
                      aria-label={t('profile.institutionVerified')}
                    />
                  )}
                </div>
                {formatAffiliation(profile, t) && (
                  <p className="text-sm font-semibold text-foreground/80">
                    {formatAffiliation(profile, t)}
                    <span className="font-normal text-muted-foreground"> · {institutionTypeLabel(profile.institution_type, t)}</span>
                  </p>
                )}
                <p className="text-sm text-muted-foreground truncate">
                  {profile.major ?? t('profile.noMajor')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {profile.residence_type ? t('residence.' + profile.residence_type) : ''}
                  {originLabel && ` · ${originLabel}`}
                  {profile.semester ? ` · ${t('profile.semester')} ${profile.semester}` : ''}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-card rounded-2xl p-4 shadow-soft text-center">
                <p className="text-xl font-extrabold text-foreground">{profile.points ?? 0}</p>
                <p className="text-xs text-muted-foreground font-semibold">{t('profile.points')}</p>
              </div>
              <div className="bg-card rounded-2xl p-4 shadow-soft text-center">
                <p className="text-xl font-extrabold text-foreground">{profile.reputation ?? 0}</p>
                <p className="text-xs text-muted-foreground font-semibold">{t('profile.reputation')}</p>
              </div>
            </div>

            {profile.interests && profile.interests.length > 0 && (
              <div>
                <h3 className="text-[13px] font-bold text-muted-foreground mb-2">
                  {t('profile.interests')}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {profile.interests.map((i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 bg-muted rounded-full text-xs font-medium text-muted-foreground"
                    >
                      {t('interests.' + i)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {profile.languages && profile.languages.length > 0 && (
              <div>
                <h3 className="text-[13px] font-bold text-muted-foreground mb-2">
                  {t('profile.languages')}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {profile.languages.map((l) => (
                    <span
                      key={l}
                      className="px-2.5 py-1 bg-muted rounded-full text-xs font-medium text-muted-foreground"
                    >
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {footer && (
        <div className="border-t border-border bg-card px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          {footer}
        </div>
      )}
    </div>
  );
}
