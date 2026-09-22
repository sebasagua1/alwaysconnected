import { useState, useEffect, useMemo, useRef } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LANGUAGE_OPTIONS, SEMESTER_OPTIONS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { ChipSelector } from '@/components/ui/chip-selector';
import { InterestPicker } from '@/components/ui/interest-picker';
import { OriginPicker } from '@/components/ui/origin-picker';
import { InstitutionPicker } from '@/components/ui/institution-picker';
import { ResidencePicker } from '@/components/ui/residence-picker';
import { WheelColumn, WHEEL_ITEM_HEIGHT } from '@/components/ui/wheel-column';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { pageTitle } from '@/lib/brand';
import { PRIVACY_URL, TERMS_URL } from '@/lib/legal';
import { rpcMessage } from '@/lib/rpcErrors';

export default function Onboarding() {
  const { user, profile, profileLoaded, fetchProfile } = useAuthStore();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [major, setMajor] = useState('');
  // Con rueda de scroll ya no hay "campo vacío": siempre hay una fila
  // seleccionada, así que arranca en el primer semestre en vez de en blanco.
  const [semester, setSemester] = useState('1');
  const [residence, setResidence] = useState('');
  const [origin, setOrigin] = useState<string | null>(null);
  const [interests, setInterests] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // Las dos afirmaciones del paso legal. Empiezan en false y no se guardan en
  // ningún sitio hasta que la persona las marca: un consentimiento marcado por
  // defecto no es consentimiento.
  const [isAdult, setIsAdult] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Campus state
  const [selectedCampusId, setSelectedCampusId] = useState<string | null>(null);
  const [needsCampusSelection, setNeedsCampusSelection] = useState(false);

  // El nombre puede venir ya puesto: Apple y Google lo entregan al iniciar
  // sesión y socialAuth.ts lo guarda en el perfil. Volver a pedirlo es lo que
  // prohíbe la guideline 4 de Apple, así que el campo arranca relleno.
  //
  // Se siembra con la forma funcional para no pisar lo que ya se esté
  // escribiendo: el perfil puede llegar después del primer render.
  useEffect(() => {
    if (profile?.name) setName((actual) => actual || profile.name!);
  }, [profile?.name]);

  // ¿La cuenta nació de un proveedor social? Decide si el nombre es obligatorio.
  //
  // Con Apple no basta con guardarlo la primera vez: el nombre se entrega UNA
  // sola vez, al autorizar la app. Quien ya la autorizó antes —el revisor de
  // App Store que probó la 1.0 (18), sin ir más lejos— vuelve a entrar sin él,
  // y no hay ningún dato con el que rellenar el campo. Bloquear ahí es repetir
  // exactamente la pantalla por la que rechazaron la app.
  //
  // Así que con proveedor social el nombre nunca frena: si llegó, se usa; si
  // no, se sigue sin él. El perfil aguanta quedarse sin nombre — la columna es
  // nullable y la UI ya cae a "Estudiante" en todas partes.
  const socialAccount = useMemo(() => {
    const meta = user?.app_metadata as { provider?: string; providers?: string[] } | undefined;
    const usados = meta?.providers ?? (meta?.provider ? [meta.provider] : []);
    return usados.some((p) => p === 'apple' || p === 'google');
  }, [user]);

  // Quién pertenece a qué institución lo decide el SERVIDOR, en el trigger de
  // alta (handle_new_user), comparando el dominio del correo contra
  // institutions.email_domains. Aquí antes se hacía `email.endsWith('@tec.mx')`,
  // que además de dejar fuera a exatec.mx e itesm.mx no verificaba nada: el
  // cliente escribía su propio campus_id y podía poner el que quisiera.
  //
  // Así que esto ya no decide, solo lee lo que el servidor decidió.
  useEffect(() => {
    if (!user || !profileLoaded) return;

    if (profile?.campus_id) {
      setSelectedCampusId(profile.campus_id);
      setNeedsCampusSelection(false);
      return;
    }

    // Sin institución asignada: o el correo no es de ninguna (elige entre
    // todo el catálogo y queda sin verificar), o es de una universidad con
    // varios campus, como el Tec (elige entre los suyos y queda verificado).
    // Las opciones las carga InstitutionPicker; la base valida la elección.
    setNeedsCampusSelection(true);
  }, [user, profileLoaded, profile?.campus_id]);

  // Lista explícita de pasos. Antes se hacía con aritmética sobre el índice
  // (`adjustedStep = step + 1`), que ya era difícil de seguir con un paso
  // opcional y se vuelve inmanejable con dos.
  const steps = useMemo(() => {
    const list: string[] = [];
    if (needsCampusSelection) list.push('campus');
    list.push('basics', 'residence');
    if (residence === 'foraneo' || residence === 'international') list.push('origin');
    list.push('interests', 'languages');
    // Siempre el último: es la puerta que hay que cruzar para que exista el
    // perfil, y ponerla al final significa que nadie la esquiva volviendo atrás.
    list.push('legal');
    return list;
  }, [needsCampusSelection, residence]);

  const totalSteps = steps.length;
  const current = steps[Math.min(step, totalSteps - 1)];

  // Cambiar de "foráneo" a "local" acorta la lista; sin esto el índice podría
  // quedar apuntando fuera.
  useEffect(() => {
    if (step > totalSteps - 1) setStep(totalSteps - 1);
  }, [step, totalSteps]);

  // Dirección de la animación: hacia dónde va la transición.
  const [direction, setDirection] = useState<'fwd' | 'back'>('fwd');
  const goNext = () => { setDirection('fwd'); setStep((v) => v + 1); };
  const goBack = () => { setDirection('back'); setStep((v) => v - 1); };

  // Al cambiar de paso el contenido puede quedar desplazado del anterior.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [step]);

  const toggleItem = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter(i => i !== item) : [...list, item]);
  };

  const handleComplete = async () => {
    if (!user) return;
    // Cinturón: el botón ya va deshabilitado, pero esto es lo que impide que el
    // perfil se cree sin constancia si algún día cambia el orden de los pasos.
    if (!isAdult || !acceptedTerms) return;
    setLoading(true);
    const ahora = new Date().toISOString();
    const { error } = await supabase.from('profiles').update({
      // null y no '': ahora se puede terminar sin nombre (ver `socialAccount`),
      // y toda la UI cae a "Estudiante" con `?? `, que a una cadena vacía no la
      // atrapa. Guardar '' dejaría el nombre en blanco por toda la app.
      name: name.trim() || null,
      major,
      semester: parseInt(semester) || null,
      residence_type: residence,
      // Solo tiene sentido para quien no es local.
      origin: residence === 'local' ? null : origin,
      interests,
      languages,
      campus_id: selectedCampusId,
      // La constancia se escribe en el mismo UPDATE que crea el perfil: o queda
      // todo, o no queda nada. Un perfil terminado sin estas dos fechas sería
      // una cuenta que nunca aceptó nada.
      terms_accepted_at: ahora,
      age_confirmed_at: ahora,
      onboarding_completed: true,
    }).eq('id', user.id);

    if (error) {
      // Los CAMPUS_* del guardia de la base traen texto propio.
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
    } else {
      await fetchProfile();
    }
    setLoading(false);
  };

  // Steps: campus selection (if needed) → basics → residence → interests → languages
  const getStepContent = () => {
    if (current === 'campus') {
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.campusTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.campusSubtitle')}</p>
          </div>
          <InstitutionPicker value={selectedCampusId} onChange={setSelectedCampusId} />
        </div>
      );
    }

    if (current === 'basics') {
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.welcomeTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.welcomeSubtitle')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="onb-name">{t('onboarding.fullName')}</Label>
            <Input id="onb-name" placeholder={t('onboarding.fullNamePh')} value={name} onChange={e => setName(e.target.value)} className="h-12 rounded-xl text-base" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="onb-major">{t('onboarding.major')}</Label>
            <Input id="onb-major" placeholder={t('onboarding.majorPh')} value={major} onChange={e => setMajor(e.target.value)} className="h-12 rounded-xl text-base" />
          </div>
          <div className="space-y-2">
            <Label id="onb-semester-label">{t('onboarding.semester')}</Label>
            {/* Rueda de scroll y no un número tecleado: nadie sabe de memoria
                si va en su séptimo u octavo semestre sin contar, y un teclado
                numérico para un valor de 1 a 12 era más fricción que ayuda. */}
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
                labelledBy="onb-semester-label"
                className="relative w-full"
              />
            </div>
          </div>
        </div>
      );
    }

    if (current === 'residence') {
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.residenceTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.residenceSubtitle')}</p>
          </div>
          <ResidencePicker value={residence} onChange={setResidence} />
        </div>
      );
    }

    if (current === 'origin') {
      const mode = residence === 'international' ? 'international' : 'foraneo';
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">
              {t(mode === 'international' ? 'origin.countryTitle' : 'origin.stateTitle')}
            </h2>
            <p className="text-muted-foreground text-sm">{t('origin.subtitle')}</p>
          </div>
          <OriginPicker mode={mode} value={origin} onChange={setOrigin} />
        </div>
      );
    }

    if (current === 'interests') {
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.interestsTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.interestsSubtitle')}</p>
          </div>
          <InterestPicker
            selected={interests}
            onToggle={(item) => toggleItem(interests, item, setInterests)}
          />
        </div>
      );
    }

    if (current === 'languages') {
      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.languagesTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.languagesSubtitle')}</p>
          </div>
          <ChipSelector
            options={LANGUAGE_OPTIONS}
            selected={languages}
            onToggle={(item) => toggleItem(languages, item, setLanguages)}
          />
        </div>
      );
    }

    if (current === 'legal') {
      // Casilla nativa oculta con dos <label> apuntándole: uno es el cuadro que
      // se ve y el otro el texto. Así el teclado y los lectores de pantalla la
      // tratan como lo que es, y toda la frase es zona de toque.
      //
      // Los enlaces van FUERA de cualquier <label>: un <a> dentro de un label
      // marca la casilla además de abrir el enlace, que es justo lo contrario
      // de leerse los términos antes de aceptarlos.
      const fila = (
        id: string,
        marcada: boolean,
        alCambiar: (v: boolean) => void,
        etiqueta: React.ReactNode,
        pista: string,
      ) => (
        <div
          className={cn(
            'flex items-start gap-3 rounded-2xl border p-4 transition-colors',
            marcada ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <input
            type="checkbox"
            id={id}
            className="sr-only"
            checked={marcada}
            onChange={(e) => alCambiar(e.target.checked)}
          />
          <label
            htmlFor={id}
            className={cn(
              'mt-0.5 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md border-2 transition-colors',
              marcada ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
            )}
          >
            {marcada && <Check className="h-4 w-4" strokeWidth={3} />}
          </label>
          <div className="flex-1 space-y-1">
            <div className="text-sm font-medium leading-snug text-foreground">{etiqueta}</div>
            <p className="text-xs text-muted-foreground">{pista}</p>
          </div>
        </div>
      );

      return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-2xl font-extrabold text-foreground mb-1">{t('onboarding.legalTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('onboarding.legalSubtitle')}</p>
          </div>

          <div className="space-y-3">
            {fila(
              'consent-age',
              isAdult,
              setIsAdult,
              <label htmlFor="consent-age" className="cursor-pointer">{t('onboarding.legalAge')}</label>,
              t('onboarding.legalAgeHint'),
            )}

            {fila(
              'consent-terms',
              acceptedTerms,
              setAcceptedTerms,
              <>
                <label htmlFor="consent-terms" className="cursor-pointer">
                  {t('onboarding.legalAcceptPrefix')}
                </label>{' '}
                <a
                  href={TERMS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-primary underline underline-offset-2"
                >
                  {t('legal.terms')}
                </a>{' '}
                {t('legal.and')}{' '}
                <a
                  href={PRIVACY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-primary underline underline-offset-2"
                >
                  {t('legal.privacy')}
                </a>
              </>,
              t('onboarding.legalAcceptHint'),
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  const canProceed = () => {
    if (current === 'campus') return !!selectedCampusId;
    // Ver `socialAccount`: con Apple el nombre puede no existir nunca.
    if (current === 'basics') return socialAccount || !!name;
    if (current === 'residence') return !!residence;
    if (current === 'origin') return !!origin;
    if (current === 'legal') return isAdult && acceptedTerms;
    return true;
  };

  return (
    <div className="min-h-screen flex flex-col px-6 pt-safe pb-8 bg-background">
      <Helmet>
        <title>{pageTitle(t('onboarding.complete'))}</title>
        <meta name="description" content={t('onboarding.metaDesc')} />
        <link rel="canonical" href="/" />
      </Helmet>
      <h1 className="sr-only">{t('onboarding.complete')}</h1>
      {/* En flujo, NO en absoluto. Colocado con `absolute top-4`, el selector
          se anclaba a la caja de relleno del contenedor —o sea, arrancaba en el
          borde de la pantalla— y su propio `safe-top` lo bajaba otros tantos
          píxeles, justo hasta donde `pt-safe` empieza a colocar el contenido.
          Resultado: la pastilla caía encima de la barra de progreso y tapaba
          su último segmento, con notch y sin él. Mismo fallo, y misma
          solución, que en Auth.tsx. */}
      <div className="flex justify-end mb-4">
        <LanguageSwitcher />
      </div>
      {/* Progress */}
      <div className="flex gap-1.5 mb-8">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-1 rounded-full flex-1 transition-all',
              i <= step ? 'bg-primary' : 'bg-muted'
            )}
          />
        ))}
      </div>

      {/* El padding horizontal está para que quepa el anillo de foco.

          `overflow-y-auto` obliga al eje X a recortar también (si un eje no es
          visible, el otro deja de serlo), y este contenedor medía exactamente
          lo mismo que los campos que lleva dentro: 24 a 366, sin un píxel de
          holgura. El anillo del Input sobresale 4px por lado, así que al
          enfocar un campo se veía cortado a izquierda y derecha.

          Los otros once contenedores con scroll de la app ya llevan px-4 o
          px-5 y por eso no les pasa; este era el único sin nada. El -mx-1.5
          compensa el px-1.5, de modo que nada se mueve de sitio. */}
      <div ref={scrollRef} className="flex-1 flex flex-col overflow-y-auto -mx-1.5 px-1.5">
        {/* key={step} fuerza el remontaje para que la animación se dispare en
            cada paso; la dirección decide desde qué lado entra. */}
        <div key={step} className={direction === 'fwd' ? 'animate-step-in-right' : 'animate-step-in-left'}>
          {getStepContent()}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex gap-3 mt-8">
        {step > 0 && (
          <Button variant="outline" onClick={goBack} className="h-12 rounded-xl px-6">
            <ChevronLeft className="w-4 h-4 mr-1" /> {t('common.back')}
          </Button>
        )}
        {step < totalSteps - 1 ? (
          <Button
            onClick={goNext}
            className="flex-1 h-12 rounded-xl font-bold"
            disabled={!canProceed()}
          >
            {t('common.next')} <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleComplete}
            className="flex-1 h-12 rounded-xl font-bold"
            // `canProceed()` también aquí, no solo en el botón de "Siguiente":
            // el último paso es ahora el legal, y sin esto se podía terminar el
            // perfil sin marcar ninguna de las dos casillas.
            disabled={loading || !canProceed()}
          >
            {loading ? t('common.saving') : t('onboarding.getStarted')}
          </Button>
        )}
      </div>
    </div>
  );
}
