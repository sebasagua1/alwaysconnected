import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, BadgeCheck, Mail, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { formatAffiliation, type VerificationState } from '@/lib/institutions';
import { rpcMessage } from '@/lib/rpcErrors';

interface Props {
  onClose: () => void;
  /** La verificación cambió: el perfil tiene que volver a leerse. */
  onChanged?: () => void;
}

type Step = 'loading' | 'email' | 'code' | 'done' | 'unavailable' | 'error';

/** Estados de start (Edge Function) y confirm (RPC) que tienen texto propio. */
const START_MESSAGES: Record<string, string> = {
  INVALID_EMAIL: 'verification.errors.invalidEmail',
  PERSONAL_EMAIL: 'verification.errors.personalEmail',
  INVALID_STUDENT_ID: 'verification.errors.invalidStudentId',
  DOMAIN_NOT_VERIFIABLE: 'verification.errors.domainNotVerifiable',
  CAMPUS_INVALID: 'verification.errors.domainNotVerifiable',
  INSTITUTION_MISMATCH: 'verification.errors.institutionMismatch',
  ALREADY_VERIFIED: 'verification.errors.alreadyVerified',
  COOLDOWN: 'verification.errors.cooldown',
  RATE_LIMITED: 'verification.errors.rateLimited',
  EMAIL_NOT_CONFIGURED: 'verification.errors.unavailableNow',
  EMAIL_SEND_FAILED: 'verification.errors.sendFailed',
  NOT_AUTHENTICATED: 'rpcErrors.notAuthenticated',
};

const CONFIRM_MESSAGES: Record<string, string> = {
  INVALID_CODE: 'verification.errors.invalidCode',
  EXPIRED: 'verification.errors.expired',
  LOCKED: 'verification.errors.locked',
  NO_PENDING: 'verification.errors.noPending',
  RATE_LIMITED: 'verification.errors.rateLimited',
  DOMAIN_NOT_VERIFIABLE: 'verification.errors.domainNotVerifiable',
  // Genérico a propósito: no dice si el correo ya lo usa otra cuenta.
  MANUAL_REVIEW: 'verification.errors.manualReview',
};

/**
 * "Verifica tu institución": manda un código al correo institucional y lo
 * confirma, sobre la MISMA cuenta (Apple, Google o correo). El correo de
 * acceso no cambia, no se cierra la sesión y no se pide la contraseña de la
 * universidad.
 */
export function VerifyInstitutionSheet({ onClose, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const fetchProfile = useAuthStore((s) => s.fetchProfile);
  const [state, setState] = useState<VerificationState | null>(null);
  const [step, setStep] = useState<Step>('loading');
  const [email, setEmail] = useState('');
  const [studentId, setStudentId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [maskedTarget, setMaskedTarget] = useState<string | null>(null);
  const [resendAfter, setResendAfter] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [campusChange, setCampusChange] = useState(false);
  const [campusNotes, setCampusNotes] = useState('');

  const load = useCallback(async () => {
    setStep('loading');
    const { data, error } = await supabase.rpc('my_institution_verification');
    if (error || !data?.[0]) {
      setStep('error');
      return;
    }
    const s = data[0];
    setState(s);
    if (s.status === 'verified') setStep('done');
    else if (!s.university_id || !s.verification_available) setStep('unavailable');
    else if (s.pending_email_masked) {
      setMaskedTarget(s.pending_email_masked);
      setResendAfter(s.pending_resend_after ? Date.parse(s.pending_resend_after) : null);
      setStep('code');
    } else setStep('email');
  }, []);

  useEffect(() => { load(); }, [load]);

  // Cuenta atrás del reenvío.
  useEffect(() => {
    if (!resendAfter || resendAfter <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resendAfter]);
  const secondsLeft = resendAfter ? Math.max(0, Math.ceil((resendAfter - now) / 1000)) : 0;

  const sendCode = async () => {
    if (!state?.university_id || busy) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.functions.invoke('institution-verification', {
      body: {
        university_id: state.university_id,
        campus_id: state.campus_id,
        email: email.trim(),
        student_id: studentId.trim() || null,
        lang: (i18n.language || 'es').startsWith('en') ? 'en' : 'es',
      },
    });
    setBusy(false);
    const status: string = error ? 'SEND_ERROR' : data?.status ?? 'SEND_ERROR';
    if (status === 'SENT') {
      setMaskedTarget(data.email_masked);
      setResendAfter(data.resend_after ? Date.parse(data.resend_after) : null);
      setNow(Date.now());
      setCode('');
      setStep('code');
      return;
    }
    if (status === 'COOLDOWN' && data?.resend_after) {
      setResendAfter(Date.parse(data.resend_after));
      setNow(Date.now());
    }
    setMessage(t(START_MESSAGES[status] ?? 'verification.errors.sendFailed'));
  };

  const confirm = async () => {
    if (busy || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.rpc('confirm_institution_verification', { _code: code });
    setBusy(false);
    const row = data?.[0];
    if (error || !row) {
      setMessage(t('verification.errors.sendFailed'));
      return;
    }
    if (row.status === 'VERIFIED') {
      toast({ title: t('verification.verifiedToast') });
      await fetchProfile();
      onChanged?.();
      await load();
      return;
    }
    setMessage(t(CONFIRM_MESSAGES[row.status] ?? 'verification.errors.sendFailed', { count: row.attempts_left }));
    if (['EXPIRED', 'LOCKED', 'NO_PENDING', 'MANUAL_REVIEW', 'DOMAIN_NOT_VERIFIABLE'].includes(row.status)) {
      setCode('');
      if (row.status === 'MANUAL_REVIEW') onChanged?.();
      setStep(row.status === 'MANUAL_REVIEW' ? 'unavailable' : 'email');
    }
  };

  /**
   * "Me equivoqué de campus" / "me cambié de campus".
   *
   * Reutiliza la misma cola que la revisión manual: no cambia nada solo, deja
   * constancia de qué campus quiere la persona y por qué. Para una cuenta ya
   * verificada, el ON CONFLICT de request_institution no toca su estado (la
   * cláusula WHERE excluye 'verified'), así que pedirlo no le quita la
   * insignia mientras se revisa.
   */
  const requestCampusChange = async () => {
    if (!state || campusNotes.trim().length < 3) return;
    setBusy(true);
    const { error } = await supabase.rpc('request_institution', {
      _kind: 'manual_verification',
      _notes: `[cambio de campus] ${campusNotes.trim()}`,
      _university_id: state.university_id,
      _campus_id: state.campus_id,
    });
    setBusy(false);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    toast({ title: t('verification.campusChangeSent'), description: t('verification.campusChangeSentDesc') });
    setCampusChange(false);
    setCampusNotes('');
    onChanged?.();
  };

  const requestReview = async () => {
    if (!state) return;
    setBusy(true);
    const { error } = await supabase.rpc('request_institution', {
      _kind: 'manual_verification',
      _university_id: state.university_id,
      _campus_id: state.campus_id,
    });
    setBusy(false);
    if (error) {
      toast({ title: t('common.error'), variant: 'destructive' });
      return;
    }
    toast({ title: t('verification.reviewRequested') });
    onChanged?.();
    onClose();
  };

  const affiliation = state ? formatAffiliation(state, t) : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background animate-slide-up" role="dialog" aria-modal="true" aria-labelledby="verify-title">
      <div className="flex items-center justify-between px-5 pb-3 border-b border-border pt-[calc(1.25rem+env(safe-area-inset-top,0px))]">
        <h2 id="verify-title" className="text-lg font-extrabold text-foreground">{t('verification.title')}</h2>
        <button onClick={onClose} aria-label={t('common.close')} className="p-3 -m-2 text-muted-foreground">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
        {affiliation && (
          <div className="rounded-2xl bg-card shadow-soft p-4">
            <p className="text-xs font-semibold text-muted-foreground">{t('verification.yourInstitution')}</p>
            <p className="font-bold text-foreground">{affiliation}</p>
          </div>
        )}

        {step === 'loading' && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" aria-label={t('common.loading')} />
          </div>
        )}

        {step === 'error' && (
          <div role="alert" className="text-center space-y-3 py-8">
            <p className="text-sm text-muted-foreground">{t('verification.loadError')}</p>
            <Button variant="outline" className="rounded-xl" onClick={load}>{t('onboarding.campusRetry')}</Button>
          </div>
        )}

        {step === 'done' && state && (
          <div className="text-center space-y-3 py-6">
            <BadgeCheck className="w-12 h-12 text-primary mx-auto" aria-hidden="true" />
            <p className="text-lg font-bold text-foreground">{t('verification.doneTitle')}</p>
            {state.email_masked && (
              <p className="text-sm text-muted-foreground">{t('verification.doneEmail', { email: state.email_masked })}</p>
            )}
            <Button className="w-full h-11 rounded-xl" onClick={onClose}>{t('common.close')}</Button>
          </div>
        )}

        {step === 'unavailable' && state && (
          <div className="space-y-4">
            <div className="flex gap-3 items-start">
              <ShieldQuestion className="w-6 h-6 text-muted-foreground shrink-0" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {state.status === 'manual_review'
                  ? t('verification.inReview')
                  : state.university_id
                    ? t('verification.noAutomatic')
                    : t('verification.chooseInstitutionFirst')}
              </p>
            </div>
            {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
            {state.university_id && state.status !== 'manual_review' && (
              <Button variant="outline" className="w-full h-11 rounded-xl" disabled={busy} onClick={requestReview}>
                {t('verification.requestReview')}
              </Button>
            )}
          </div>
        )}

        {step === 'email' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('verification.emailIntro')}</p>
            <div className="space-y-1.5">
              <Label htmlFor="inst-email">{t('verification.emailLabel')}</Label>
              <Input
                id="inst-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('verification.emailPh')}
                className="h-12 rounded-xl text-base"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inst-student-id">{t('verification.studentIdLabel')}</Label>
              <Input
                id="inst-student-id"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={40}
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="h-12 rounded-xl text-base"
              />
              <p className="text-xs text-muted-foreground">{t('verification.studentIdHint')}</p>
            </div>
            {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
            <Button type="submit" className="w-full h-12 rounded-xl" disabled={busy || !email.includes('@') || secondsLeft > 0}>
              <Mail className="w-4 h-4" aria-hidden="true" />
              {busy ? t('verification.sending') : secondsLeft > 0 ? t('verification.resendIn', { seconds: secondsLeft }) : t('verification.sendCode')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('verification.privacyNote')}</p>
          </form>
        )}

        {step === 'code' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              confirm();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('verification.codeSent', { email: maskedTarget ?? '' })}</p>
            <div className="space-y-1.5">
              <Label htmlFor="inst-code">{t('verification.codeLabel')}</Label>
              <Input
                id="inst-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-14 rounded-xl text-2xl tracking-[0.4em] text-center font-mono"
              />
            </div>
            {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
            <Button type="submit" className="w-full h-12 rounded-xl" disabled={busy || code.length !== 6}>
              {busy ? t('verification.verifying') : t('verification.verify')}
            </Button>
            <div className="flex justify-between gap-3">
              <button type="button" className="min-h-[44px] text-sm font-semibold text-primary" onClick={() => { setMessage(null); setStep('email'); }}>
                {t('verification.changeEmail')}
              </button>
              <button
                type="button"
                className="min-h-[44px] text-sm font-semibold text-primary disabled:text-muted-foreground"
                disabled={secondsLeft > 0 || busy || !email}
                onClick={sendCode}
              >
                {secondsLeft > 0 ? t('verification.resendIn', { seconds: secondsLeft }) : t('verification.resend')}
              </button>
            </div>
          </form>
        )}

        {/* Salida para el campus.
            set_profile_campus lo bloquea para siempre en cuanto se elige, y la
            razón es buena: si no, alguien se movería de comunidad conservando
            la insignia de verificado. Pero hasta ahora no había NINGUNA salida
            en la app —EditProfileSheet ni menciona el campus—, así que quien se
            equivocaba tocando en una lista de nueve campus se quedaba atrapado
            en la comunidad incorrecta, sin nada que tocar y sin entender por
            qué. Los intercambios entre campus del Tec son habituales.
            La solicitud ya existía (request_institution 'manual_verification');
            lo único que faltaba era llegar hasta ella. */}
        {state && step !== 'loading' && step !== 'error' && (
          <div className="pt-5 border-t border-border">
            {!campusChange ? (
              <button
                type="button"
                className="min-h-[44px] text-sm font-semibold text-primary"
                onClick={() => setCampusChange(true)}
              >
                {t('verification.campusChange')}
              </button>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  requestCampusChange();
                }}
              >
                <p className="text-sm text-muted-foreground">{t('verification.campusChangeDesc')}</p>
                <div className="space-y-1.5">
                  <Label htmlFor="campus-change-notes">{t('verification.campusChangeLabel')}</Label>
                  <Input
                    id="campus-change-notes"
                    maxLength={300}
                    value={campusNotes}
                    onChange={(e) => setCampusNotes(e.target.value)}
                    placeholder={t('verification.campusChangePh')}
                    className="h-12 rounded-xl text-base"
                  />
                </div>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-xl px-5"
                    onClick={() => setCampusChange(false)}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 h-11 rounded-xl"
                    disabled={busy || campusNotes.trim().length < 3}
                  >
                    {t('verification.campusChangeSend')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
