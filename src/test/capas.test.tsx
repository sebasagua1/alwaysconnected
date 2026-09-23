import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/**
 * Orden de capas. Las fichas propias (detalle del evento en Mis eventos y
 * en /event/:id, editar evento, perfil…) viven en z-[60]. Todo lo que se abre
 * desde ellas por portal tiene que quedar encima, o se abre DETRÁS y no se
 * ve ni se puede tocar. Pasó dos veces: con los diálogos (04d87a4) y con
 * «Invitar amigos», que es un Sheet y estaba en z-50.
 */
const FICHA = 60;

function zDe(el: HTMLElement): number {
  const m = el.className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/);
  if (!m) throw new Error(`sin clase z-* en: ${el.className}`);
  return Number(m[1] ?? m[2]);
}

describe('capas', () => {
  it('un Sheet queda por encima de las fichas en z-[60]', () => {
    render(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const hoja = screen.getByRole('dialog');
    expect(zDe(hoja)).toBeGreaterThan(FICHA);
    // El velo oscuro también: si no, tapa la ficha solo a medias.
    const velo = hoja.previousElementSibling as HTMLElement;
    expect(zDe(velo)).toBeGreaterThan(FICHA);
  });

  it('un Dialog abierto desde un Sheet queda por encima del Sheet', () => {
    render(
      <>
        <Sheet open>
          <SheetContent side="bottom">
            <SheetTitle>hoja</SheetTitle>
            <SheetDescription>d</SheetDescription>
          </SheetContent>
        </Sheet>
        <Dialog open>
          <DialogContent>
            <DialogTitle>dialogo</DialogTitle>
            <DialogDescription>d</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    );
    const [hoja, dialogo] = ['hoja', 'dialogo'].map(
      (n) => screen.getByText(n).closest('[role="dialog"], [role="alertdialog"]') as HTMLElement,
    );
    expect(zDe(dialogo)).toBeGreaterThan(zDe(hoja));
  });
});
