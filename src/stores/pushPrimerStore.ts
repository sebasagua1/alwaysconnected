import { create } from 'zustand';
import { pushPermission } from '@/lib/push';

/**
 * La pregunta propia antes del diálogo de notificaciones del sistema.
 *
 * iOS solo enseña ese diálogo UNA vez. Se prepara con una tarjeta que dice
 * para qué sirve, justo después de algo que lo justifica. «Sí, avísame» abre
 * el diálogo; «Ahora no» no gasta el intento y se vuelve a ofrecer más
 * adelante, con un máximo para no insistir.
 */

export type PrimerReason = 'joined' | 'created' | 'friend';

const KEY = 'ac_push_primer';
const SNOOZE_DAYS = 7;
const MAX_OFFERS = 3;

interface Saved { snoozedUntil: number; offers: number }

function read(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Saved>;
      return { snoozedUntil: Number(v.snoozedUntil) || 0, offers: Number(v.offers) || 0 };
    }
  } catch {
    // Sin almacenamiento: se comporta como la primera vez.
  }
  return { snoozedUntil: 0, offers: 0 };
}

function write(v: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* nada que hacer */ }
}

interface PrimerState {
  reason: PrimerReason | null;
  /** Ofrece la tarjeta si el permiso está sin decidir y no toca descansar. */
  maybeAsk: (reason: PrimerReason) => Promise<void>;
  /** «Ahora no»: no vuelve a salir en unos días. */
  snooze: () => void;
  /** Se cierra sin más (tras «Sí, avísame»). */
  close: () => void;
}

export const usePushPrimerStore = create<PrimerState>((set, get) => ({
  reason: null,
  maybeAsk: async (reason) => {
    if (get().reason) return;
    const saved = read();
    if (saved.offers >= MAX_OFFERS || Date.now() < saved.snoozedUntil) return;
    if ((await pushPermission()) !== 'prompt') return;
    write({ ...saved, offers: saved.offers + 1 });
    // Un respiro para que se vea primero el resultado de la acción (el toast
    // de «¡Te uniste!»), y no la tarjeta encima de golpe.
    window.setTimeout(() => set({ reason }), 700);
  },
  snooze: () => {
    const saved = read();
    write({ ...saved, snoozedUntil: Date.now() + SNOOZE_DAYS * 86_400_000 });
    set({ reason: null });
  },
  close: () => set({ reason: null }),
}));

/** Atajo para llamar desde cualquier sitio sin suscribirse al store. */
export const askForPush = (reason: PrimerReason) => void usePushPrimerStore.getState().maybeAsk(reason);
