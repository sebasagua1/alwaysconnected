import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { LANGUAGE_OPTIONS, SEMESTER_OPTIONS } from '@/lib/constants';
import { ChipSelector } from '@/components/ui/chip-selector';
import { PlacePicker } from '@/components/ui/place-picker';
import { residenceFromOrigin } from '@/lib/origin';
import { InterestPicker } from '@/components/ui/interest-picker';
import { AvatarCropper } from '@/components/profile/AvatarCropper';
import { WheelColumn, WHEEL_ITEM_HEIGHT } from '@/components/ui/wheel-column';
import type { Database } from '@/integrations/supabase/types';

type Profile = Database['public']['Tables']['profiles']['Row'];

interface Props {
  profile: Profile;
  onClose: () => void;
}

export function EditProfileSheet({ profile, onClose }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { fetchProfile } = useAuthStore();

  const [name, setName] = useState(profile.name ?? '');
  const [major, setMajor] = useState(profile.major ?? '');
  // Con rueda de scroll ya no hay "campo vacío": siempre hay una fila
  // seleccionada, así que quien nunca lo puso arranca en el primer semestre
  // en vez de en blanco.
  const [semester, setSemester] = useState(profile.semester?.toString() ?? '1');
  // Un solo campo, como en el alta. Aquí no hace falta el `undefined` del
  // onboarding: el perfil ya existe, así que null es «soy de aquí» y no
  // «sin contestar».
  const [origin, setOrigin] = useState<string | null>(profile.origin ?? null);
  const [interests, setInterests] = useState<string[]>(profile.interests ?? []);
  const [languages, setLanguages] = useState<string[]>(profile.languages ?? []);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(profile.avatar_url ?? null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);

  const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Se limpia el input o elegir la misma foto dos veces no dispara onChange.
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: t('profile.photoNotImage'), variant: 'destructive' });
      return;
    }
    // Descarta pronto un fichero absurdo. Ojo: esto NO acota la memoria, que
    // es lo que cerraba la app — un JPEG de 72 kB puede descomprimirse a 47 MB,
    // así que el peso del fichero no predice nada. De eso se encarga la
    // reducción previa en lib/imageDownscale.ts.
    // Lo que se sube es siempre el recorte de 512px reencodado, que pesa unos
    // pocos kB venga de donde venga.
    if (file.size > MAX_PHOTO_BYTES) {
      toast({ title: t('profile.photoTooLarge'), variant: 'destructive' });
      return;
    }

    setPendingPhoto(file);
  };

  // `avatarPreview` empieza siendo la URL remota del perfil, que NO hay que
  // revocar. Solo se lleva la cuenta de las que se crean aquí.
  const objectUrlRef = useRef<string | null>(null);

  const handleCropped = (cropped: File) => {
    setPendingPhoto(null);
    setAvatarFile(cropped);
    // Recortar varias veces seguidas dejaba una URL viva por intento, y con
    // ella el blob entero retenido hasta recargar la página.
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(cropped);
    objectUrlRef.current = url;
    setAvatarPreview(url);
  };

  // La hoja se cierra tras guardar; la vista previa ya no la mira nadie.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const toggle = (list: string[], item: string, setter: (v: string[]) => void) =>
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);

    let avatarUrl = profile.avatar_url ?? null;
    if (avatarFile) {
      setUploadingAvatar(true);
      // Extensión fija: el recorte sale siempre en JPEG, así que cada subida
      // pisa la anterior en vez de dejar avatar.png, avatar.heic... sueltos.
      // (El motivo que ponía antes —"no hay política de DELETE en el bucket"—
      //  era falso: "Users can delete own avatar" existe desde la migración
      //  20260505192643. La decisión sigue valiendo; el motivo no.)
      const path = `${profile.id}/avatar.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, avatarFile, { upsert: true, contentType: 'image/jpeg' });
      setUploadingAvatar(false);
      if (uploadError) {
        toast({ title: t('common.error'), description: uploadError.message, variant: 'destructive' });
        setSaving(false);
        return;
      }
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
      // La ruta no cambia entre subidas, así que sin este parámetro el
      // navegador seguiría enseñando la foto anterior desde caché.
      avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        name: name.trim(),
        major: major.trim() || null,
        semester: parseInt(semester) || null,
        residence_type: residenceFromOrigin(origin),
        origin,
        interests,
        languages,
        avatar_url: avatarUrl,
      })
      .eq('id', profile.id);

    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else {
      await fetchProfile();
      toast({ title: t('profile.saved') });
      onClose();
    }
    setSaving(false);
  };

  if (pendingPhoto) {
    return (
      <AvatarCropper
        file={pendingPhoto}
        onCancel={() => setPendingPhoto(null)}
        onCropped={handleCropped}
      />
    );
  }

  return (
    // z-[60] como los demás sheets: en z-50 empataba con BottomNav, que se
    // pinta después y se comía la mitad inferior de Cancelar y Guardar.
    <div className="fixed inset-0 z-[60] flex flex-col bg-background animate-slide-up">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pb-3 border-b border-border pt-[calc(1.25rem+env(safe-area-inset-top,0px))]">
        <h2 className="text-lg font-extrabold text-foreground">{t('profile.edit')}</h2>
        <button onClick={onClose} className="p-3 -m-2 text-muted-foreground">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="relative w-20 h-20 rounded-full overflow-hidden bg-primary/10 flex items-center justify-center group"
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-bold text-primary">{name?.[0] ?? '?'}</span>
            )}
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
              <Camera className="w-6 h-6 text-white" />
            </div>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center min-h-[44px] text-sm font-semibold text-primary"
            disabled={uploadingAvatar}
          >
            {uploadingAvatar ? t('common.saving') : t('profile.changePhoto')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />
        </div>

        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="ep-name">{t('onboarding.fullName')}</Label>
          <Input
            id="ep-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('onboarding.fullNamePh')}
            className="h-12 rounded-xl text-base"
          />
        </div>

        {/* Major */}
        <div className="space-y-2">
          <Label htmlFor="ep-major">{t('onboarding.major')}</Label>
          <Input
            id="ep-major"
            value={major}
            onChange={(e) => setMajor(e.target.value)}
            placeholder={t('onboarding.majorPh')}
            className="h-12 rounded-xl text-base"
          />
        </div>

        {/* Semester */}
        <div className="space-y-2">
          <Label id="ep-semester-label">{t('onboarding.semester')}</Label>
          <div className="relative rounded-xl border border-input bg-background px-4">
            <div
              className="pointer-events-none absolute left-4 right-4 top-1/2 -translate-y-1/2 rounded-lg bg-muted"
              style={{ height: WHEEL_ITEM_HEIGHT }}
              aria-hidden
            />
            <WheelColumn
              items={SEMESTER_OPTIONS}
              index={Math.min(11, Math.max(0, parseInt(semester, 10) - 1 || 0))}
              onIndexChange={(i) => setSemester(SEMESTER_OPTIONS[i])}
              label={t('onboarding.semester')}
              labelledBy="ep-semester-label"
              className="relative w-full"
            />
          </div>
        </div>

        {/* De dónde eres. Un solo control: el tipo de residencia se deriva. */}
        <div className="space-y-3">
          <Label>{t('origin.title')}</Label>
          <PlacePicker value={origin} onChange={setOrigin} />
        </div>

        {/* Interests */}
        <div className="space-y-3">
          <Label>{t('onboarding.interestsTitle')}</Label>
          <InterestPicker
            selected={interests}
            onToggle={(item) => toggle(interests, item, setInterests)}
          />
        </div>

        {/* Languages */}
        <div className="space-y-3">
          <Label>{t('onboarding.languagesTitle')}</Label>
          <ChipSelector
            options={LANGUAGE_OPTIONS}
            selected={languages}
            onToggle={(item) => toggle(languages, item, setLanguages)}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 pb-8 pt-3 border-t border-border flex gap-3">
        <Button variant="outline" onClick={onClose} className="h-12 rounded-xl px-6">
          {t('common.cancel')}
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="flex-1 h-12 rounded-xl font-bold"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('profile.save')}
        </Button>
      </div>
    </div>
  );
}
