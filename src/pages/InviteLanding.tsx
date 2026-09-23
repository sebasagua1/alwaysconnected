import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { APP_NAME, pageTitle } from '@/lib/brand';
import { savePendingInvite } from '@/lib/contacts';
import { APP_URL_SCHEME } from '@/lib/deepLinks';

/** Ficha oficial de la App Store (ver memoria/app-en-app-store). */
const APP_STORE_URL = 'https://apps.apple.com/app/always-connected/id6804866543';

/**
 * Lo que ve quien abre un enlace de invitación sin tener la app.
 *
 * Pública (no pasa por el inicio de sesión). No sabe ni enseña quién
 * invitó: el código es opaco y el nombre solo se resuelve después, ya con
 * sesión y si esa persona es visible. Guarda el código para canjearlo al
 * entrar (en la web o en la app, si se abre con el botón).
 */
export default function InviteLanding() {
  const { code } = useParams<{ code: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const valid = Boolean(code && /^[A-Za-z0-9]{10}$/.test(code));

  useEffect(() => {
    if (code && valid) savePendingInvite(code);
  }, [code, valid]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 pt-safe pb-8 bg-background text-center">
      <Helmet>
        <title>{pageTitle(t('invite.title'))}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <img src="/icons/icon-192.png" alt="" className="w-20 h-20 rounded-3xl shadow-lifted mb-6" />
      <h1 className="text-2xl font-extrabold text-foreground">{t('invite.title')}</h1>
      <p className="mt-3 text-sm text-muted-foreground max-w-xs">{t('findFriends.inviteMessage')}</p>
      <div className="mt-8 w-full max-w-xs flex flex-col gap-3">
        <Button asChild className="h-12 rounded-xl font-bold">
          <a href={APP_STORE_URL}>{t('invite.download')}</a>
        </Button>
        {valid && (
          <Button asChild variant="outline" className="h-12 rounded-xl font-semibold">
            <a href={`${APP_URL_SCHEME}://i/${code}`}>{t('invite.openApp')}</a>
          </Button>
        )}
        <Button variant="ghost" className="h-11 rounded-xl text-muted-foreground" onClick={() => navigate('/')}>
          {t('invite.continueWeb', { app: APP_NAME })}
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted-foreground max-w-xs">{t('invite.adultsOnly')}</p>
    </div>
  );
}
