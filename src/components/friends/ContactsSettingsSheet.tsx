import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Contact, ExternalLink, ListPlus, Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { manageLimitedAccess, openAppSettings, type ContactsStatus } from '@/lib/contacts';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ContactsStatus;
  limitedPickerAvailable: boolean;
  settings: { discoverable: boolean; notify_contacts_join: boolean; last_synced_at: string | null };
  onChange: (discoverable: boolean, notify: boolean) => Promise<void>;
  onCleared: () => void;
  /** Tras ampliar el acceso limitado: hay contactos nuevos que buscar. */
  onContactsChanged: () => void;
}

/**
 * "Gestionar permiso": qué ve la app, quién te puede encontrar, y la salida
 * para borrarlo todo. El permiso del sistema no se puede cambiar desde la
 * app (iOS no deja), así que se lleva a Ajustes con una explicación.
 */
export function ContactsSettingsSheet({ open, onOpenChange, status, limitedPickerAvailable, settings, onChange, onCleared, onContactsChanged }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);

  const statusText =
    status === 'authorized' ? t('findFriends.statusAuthorized')
      : status === 'limited' ? t('findFriends.statusLimited')
        : status === 'denied' ? t('findFriends.statusDenied')
          : status === 'restricted' ? t('findFriends.statusRestricted')
            : status === 'unavailable' ? t('findFriends.statusUnavailable')
              : t('findFriends.statusNotDetermined');

  const clear = async () => {
    setConfirmClear(false);
    const { error } = await supabase.rpc('clear_contact_data');
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: t('findFriends.cleared') });
    onCleared();
  };

  const addMore = async () => {
    const shown = await manageLimitedAccess();
    if (shown) onContactsChanged();
    else await openAppSettings();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[85dvh] overflow-y-auto pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
          <SheetHeader className="text-left">
            <SheetTitle>{t('findFriends.manage')}</SheetTitle>
            <SheetDescription>{statusText}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-2">
            {status !== 'unavailable' && (
              <button
                onClick={() => void openAppSettings()}
                className="w-full flex items-center gap-3 min-h-[48px] px-3 rounded-xl border border-border text-left"
              >
                <ExternalLink className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 text-sm font-medium text-foreground">{t('findFriends.openSettings')}</span>
              </button>
            )}
            {status === 'limited' && (
              <button
                onClick={() => void addMore()}
                className="w-full flex items-center gap-3 min-h-[48px] px-3 rounded-xl border border-border text-left"
              >
                <ListPlus className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 text-sm font-medium text-foreground">
                  {limitedPickerAvailable ? t('findFriends.addMoreContacts') : t('findFriends.addMoreInSettings')}
                </span>
              </button>
            )}
          </div>

          <div className="mt-5 space-y-3">
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={settings.discoverable}
                onChange={(e) => void onChange(e.target.checked, settings.notify_contacts_join)}
                className="mt-1 w-5 h-5 accent-[hsl(var(--primary))]"
              />
              <span className="text-sm text-foreground">
                {t('findFriends.discoverableLabel')}
                <span className="block text-xs text-muted-foreground">{t('findFriends.discoverableHelp')}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={settings.notify_contacts_join}
                onChange={(e) => void onChange(settings.discoverable, e.target.checked)}
                className="mt-1 w-5 h-5 accent-[hsl(var(--primary))]"
              />
              <span className="text-sm text-foreground">
                {t('findFriends.notifyJoinLabel')}
                <span className="block text-xs text-muted-foreground">{t('findFriends.notifyJoinHelp')}</span>
              </span>
            </label>
          </div>

          <div className="mt-5 rounded-xl bg-muted/50 p-3 flex gap-2">
            <Contact className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">{t('findFriends.privacyNote')}</p>
          </div>

          <button
            onClick={() => setConfirmClear(true)}
            className="mt-4 w-full flex items-center gap-3 min-h-[48px] px-3 rounded-xl text-left text-destructive hover:bg-destructive/5"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            <span className="text-sm font-semibold">{t('findFriends.clearData')}</span>
          </button>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('findFriends.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('findFriends.clearDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={clear} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('findFriends.clearAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
