import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';
import { CATALOG_COUNTRIES, countryLabel } from '@/lib/institutions';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialCountry?: string | null;
}

/**
 * "Solicitar que agreguemos mi institución". Se guarda para revisión; no
 * crea nada visible y no pide dominio de correo: un dominio verificable solo
 * se añade con evidencia oficial, nunca porque alguien lo escriba.
 */
export function RequestInstitutionDialog({ open, onOpenChange, initialName = '', initialCountry = null }: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [country, setCountry] = useState<string | null>(initialCountry);
  const [city, setCity] = useState('');
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setCountry(initialCountry);
    }
  }, [open, initialName, initialCountry]);

  const submit = async () => {
    if (name.trim().length < 3) return;
    setSending(true);
    const { error } = await supabase.rpc('request_institution', {
      _kind: 'add_institution',
      _institution_name: name.trim(),
      _country_code: country,
      _city: city.trim() || null,
      _website_url: website.trim() || null,
    });
    setSending(false);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    toast({ title: t('institutionRequest.sent'), description: t('institutionRequest.sentDesc') });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[380px] rounded-2xl">
        <DialogHeader>
          <DialogTitle>{t('institutionRequest.title')}</DialogTitle>
          <DialogDescription>{t('institutionRequest.desc')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="req-inst-name">{t('institutionRequest.name')}</Label>
            <Input id="req-inst-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} className="h-11 rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('institutionRequest.country')}</span>
            <div className="flex flex-wrap gap-2">
              {CATALOG_COUNTRIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={country === c}
                  onClick={() => setCountry(country === c ? null : c)}
                  className={cn('min-h-[36px] px-3 rounded-full text-sm font-semibold', country === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                >
                  {countryLabel(c, i18n.language || 'es')}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="req-inst-city">{t('institutionRequest.city')}</Label>
            <Input id="req-inst-city" value={city} maxLength={120} onChange={(e) => setCity(e.target.value)} className="h-11 rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="req-inst-web">{t('institutionRequest.website')}</Label>
            <Input id="req-inst-web" type="url" inputMode="url" autoCapitalize="none" value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} className="h-11 rounded-xl" placeholder="https://" />
          </div>
          <Button type="submit" className="w-full h-11 rounded-xl" disabled={sending || name.trim().length < 3}>
            {sending ? t('common.saving') : t('institutionRequest.submit')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
