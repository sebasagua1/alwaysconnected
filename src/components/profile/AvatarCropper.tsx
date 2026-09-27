import { useCallback, useEffect, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downscaleForCrop, cropToSquare, MAX_ZOOM } from '@/lib/imageDownscale';

interface Props {
  file: File;
  onCancel: () => void;
  onCropped: (file: File) => void;
}

/**
 * Recorte cuadrado antes de subir. Sin esto la foto se guardaba entera y el
 * `object-cover` del avatar decidía por su cuenta qué parte enseñar, que casi
 * nunca era la cara.
 *
 * La foto se reduce ANTES de enseñarla, y lo reducido es también lo que se
 * recorta después. Antes se trabajaba con el original en los dos sitios a la
 * vez —la vista previa y el canvas del recorte—, y con una foto de un móvil
 * moderno eso son cientos de MB descomprimidos: el webview de iOS cerraba la
 * app. Ver lib/imageDownscale.ts.
 */
export function AvatarCropper({ file, onCancel, onCropped }: Props) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  // Lo que de verdad se recorta. El recortador mide sobre esta misma imagen,
  // así que sus coordenadas ya vienen en este espacio: no hay conversión que
  // pueda descuadrarse.
  const sourceRef = useRef<Blob | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    // Se suelta la anterior antes de nada: si no, entre la limpieza de este
    // efecto y la llegada de la nueva, el recortador se quedaba apuntando a
    // una URL ya revocada.
    setSrc(null);
    setPreparing(true);
    setFailed(false);
    setArea(null);
    setZoom(1);
    setCrop({ x: 0, y: 0 });

    downscaleForCrop(file)
      .then((reduced) => {
        if (cancelled) return;
        sourceRef.current = reduced;
        // Sin esto cada foto elegida deja su blob colgado en memoria.
        url = URL.createObjectURL(reduced);
        setSrc(url);
        setPreparing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setPreparing(false);
      });

    return () => {
      cancelled = true;
      sourceRef.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  const onCropComplete = useCallback((_: Area, pixels: Area) => setArea(pixels), []);

  const handleConfirm = async () => {
    const source = sourceRef.current;
    if (!source || !area) return;
    setWorking(true);
    try {
      const blob = await cropToSquare(source, area);
      onCropped(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    } catch {
      setFailed(true);
      setWorking(false);
    }
  };

  return (
    // Negro en los dos modos, como el recorte de Fotos. Antes era el color del
    // texto invertido: azul marino en claro, pero casi BLANCO a pantalla
    // completa en oscuro, y el error en rojo quedaba ilegible sobre los dos.
    <div className="fixed inset-0 z-[70] flex flex-col bg-black animate-fade-in">
      <div className="px-5 pb-3 text-center pt-[calc(1.25rem+env(safe-area-inset-top,0px))]">
        <h2 className="text-lg font-extrabold text-white">{t('profile.adjustPhoto')}</h2>
        <p className="text-xs text-white/70 mt-1">{t('profile.adjustPhotoHint')}</p>
      </div>

      <div className="relative flex-1 min-h-0">
        {src && (
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            maxZoom={MAX_ZOOM}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        )}
        {/* Reducir una foto grande lleva un momento: sin esto la pantalla se
            queda en negro y parece que se ha colgado. */}
        {preparing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 aria-hidden="true" className="w-6 h-6 animate-spin text-white/80" />
            <p className="text-xs text-white/70">{t('profile.preparingPhoto')}</p>
          </div>
        )}
      </div>

      <div className="px-5 pt-4 space-y-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        {failed && (
          <p role="alert" className="flex items-center justify-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm text-white text-center">
            <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0 text-amber-300" />
            {t('profile.photoError')}
          </p>
        )}

        {/* Control de zoom además del pellizco: en escritorio no hay pellizco. */}
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t('profile.zoom')}
          disabled={preparing}
          className="w-full accent-white disabled:opacity-40"
        />

        <div className="flex gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={working} className="h-12 rounded-xl px-6 text-white hover:bg-white/10 hover:text-white">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={working || preparing || !area}
            className="flex-1 h-12 rounded-xl font-bold bg-white text-black hover:bg-white/90"
          >
            {working ? <Loader2 className="w-4 h-4 animate-spin" /> : t('profile.usePhoto')}
          </Button>
        </div>
      </div>
    </div>
  );
}
