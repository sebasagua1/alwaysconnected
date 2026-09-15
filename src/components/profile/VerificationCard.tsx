import { useTranslation } from 'react-i18next';
import { BadgeCheck, ChevronRight, ShieldAlert, Clock, Mail } from 'lucide-react';
import { formatAffiliation, verificationCardMode, type VerificationState } from '@/lib/institutions';
import { cn } from '@/lib/utils';

interface Props {
  state: VerificationState | null;
  loading: boolean;
  onOpen: () => void;
}

/**
 * La tarjeta del perfil. Sin verificar, la cuenta funciona igual; la tarjeta
 * solo invita a fortalecerla.
 */
export function VerificationCard({ state, loading, onOpen }: Props) {
  const { t } = useTranslation();
  if (loading) return <div className="h-[72px] rounded-2xl bg-card shadow-soft mb-5 animate-pulse" aria-hidden="true" />;
  const mode = verificationCardMode(state);
  const affiliation = state ? formatAffiliation(state, t) : null;

  const copy = {
    verified: { icon: BadgeCheck, title: t('verification.cardVerified'), body: affiliation },
    pending: { icon: Mail, title: t('verification.cardPending'), body: t('verification.cardPendingBody', { email: state?.pending_email_masked ?? '' }) },
    review: { icon: Clock, title: t('verification.cardReview'), body: t('verification.cardReviewBody') },
    unverified: { icon: ShieldAlert, title: t('verification.cardUnverified'), body: t('verification.cardUnverifiedBody') },
  }[mode];
  const Icon = copy.icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full flex items-center gap-3 rounded-2xl p-4 mb-5 text-left shadow-soft transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mode === 'unverified' ? 'bg-primary/10 border border-primary/30' : 'bg-card',
      )}
    >
      <Icon className={cn('w-6 h-6 shrink-0', mode === 'verified' || mode === 'unverified' ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm text-foreground">{copy.title}</p>
        {copy.body && <p className="text-xs text-muted-foreground truncate">{copy.body}</p>}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  );
}
