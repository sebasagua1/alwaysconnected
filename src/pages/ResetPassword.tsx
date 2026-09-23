import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { pageTitle } from '@/lib/brand';

const MIN_LENGTH = 6;

/**
 * Pantalla de "elige una contraseña nueva". Se llega aquí desde el enlace del
 * correo, que ya deja sesión abierta: por eso updateUser() basta y no hace
 * falta pedir la contraseña anterior.
 */
export default function ResetPassword() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { setPasswordRecovery, signOut } = useAuthStore();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSave = password.length >= MIN_LENGTH && confirm === password && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      setSaving(false);
      return;
    }
    // El hash con el token sigue en la barra de direcciones; recargar sin
    // limpiarlo volvería a meter a la app en modo recuperación.
    window.history.replaceState(null, '', window.location.pathname);
    setPasswordRecovery(false);
    toast({ title: t('reset.done'), description: t('reset.doneDesc') });
    setSaving(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-background">
      <Helmet>
        <title>{pageTitle(t('reset.title'))}</title>
      </Helmet>
      <div className="w-full max-w-[380px] space-y-8">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-primary rounded-2xl flex items-center justify-center mx-auto shadow-soft">
            <KeyRound className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-extrabold text-foreground tracking-tight">{t('reset.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('reset.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-password">{t('reset.newPassword')}</Label>
            <PasswordInput
              id="reset-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_LENGTH}
              autoComplete="new-password"
              className="h-12 rounded-xl bg-card border-border text-base"
            />
            {tooShort && (
              <p className="text-xs text-destructive">{t('reset.tooShort', { count: MIN_LENGTH })}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reset-confirm">{t('reset.confirm')}</Label>
            <PasswordInput
              id="reset-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              className="h-12 rounded-xl bg-card border-border text-base"
            />
            {mismatch && <p className="text-xs text-destructive">{t('reset.mismatch')}</p>}
          </div>

          <Button type="submit" disabled={!canSave} className="w-full h-12 rounded-xl text-base font-bold">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('reset.save')}
          </Button>
        </form>

        {/* Salida por si el enlace se abrió por error: sin esto la sesión de
            recuperación deja la app atrapada en esta pantalla. */}
        <p className="text-center text-sm text-muted-foreground">
          <button
            onClick={async () => { setPasswordRecovery(false); await signOut(); }}
            className="inline-flex items-center min-h-[44px] px-1 text-primary font-semibold hover:underline"
          >
            {t('reset.cancel')}
          </button>
        </p>
      </div>
    </div>
  );
}
