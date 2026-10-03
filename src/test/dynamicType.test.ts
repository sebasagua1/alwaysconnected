/**
 * Dynamic Type en dos escalas. Lo que se fija: la interfaz sigue creciendo
 * como antes y con el mismo tope; lo que el sistema pide por encima va solo
 * al texto, también con tope; y el refuerzo se pone en <body>, no en <html>,
 * que agrandaría otra vez toda la interfaz.
 *
 * Los px son lo que mide `-apple-system-body` en cada tamaño de iOS.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyDynamicTypeScales, scalesFor } from '@/lib/dynamicType';

const IOS = {
  xSmall: 14, small: 15, medium: 16, large: 17, xLarge: 19, xxLarge: 21, xxxLarge: 23,
  ax1: 28, ax2: 33, ax3: 40, ax4: 47, ax5: 53,
};

describe('scalesFor', () => {
  it('con el tamaño por defecto no cambia nada', () => {
    expect(scalesFor(IOS.large)).toEqual({ layout: 1, text: 1 });
  });

  it('hasta xxL crece la interfaz entera, como antes, y el texto no lleva refuerzo', () => {
    expect(scalesFor(IOS.xLarge).layout).toBeCloseTo(19 / 17);
    expect(scalesFor(IOS.xLarge).text).toBe(1);
    expect(scalesFor(IOS.xxLarge).layout).toBeCloseTo(21 / 17);
    expect(scalesFor(IOS.xxLarge).text).toBe(1);
  });

  it('la interfaz no pasa de 1,3 en ningún tamaño', () => {
    for (const px of Object.values(IOS)) expect(scalesFor(px).layout).toBeLessThanOrEqual(1.3);
    expect(scalesFor(IOS.ax5).layout).toBe(1.3);
  });

  it('xxxL ya no se queda en 1,3: lo que falta va al texto', () => {
    const { layout, text } = scalesFor(IOS.xxxLarge);
    expect(layout).toBe(1.3);
    expect(layout * text).toBeCloseTo(23 / 17);
  });

  it('los tamaños de accesibilidad llevan el refuerzo, con tope en 1,25', () => {
    for (const px of [IOS.ax1, IOS.ax2, IOS.ax3, IOS.ax4, IOS.ax5]) {
      expect(scalesFor(px)).toEqual({ layout: 1.3, text: 1.25 });
    }
  });

  it('antes, de xxxL para arriba todos se veían igual; ahora el texto es mayor que a xxL', () => {
    const total = (px: number) => scalesFor(px).layout * scalesFor(px).text;
    expect(total(IOS.ax1)).toBeGreaterThan(total(IOS.xxxLarge));
    expect(total(IOS.xxxLarge)).toBeGreaterThan(total(IOS.xxLarge));
  });

  it('por abajo: la interfaz no baja de 0,9 y el texto nunca se encoge aparte', () => {
    expect(scalesFor(IOS.xSmall)).toEqual({ layout: 0.9, text: 1 });
    expect(scalesFor(IOS.medium).layout).toBeCloseTo(16 / 17);
  });
});

describe('applyDynamicTypeScales', () => {
  const doc = () => {
    const d = {
      documentElement: { style: { fontSize: 'x' } },
      body: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
    };
    return d as typeof d & Document;
  };

  it('la interfaz va al font-size de <html> y el refuerzo a <body>', () => {
    const d = doc();
    applyDynamicTypeScales(d, { layout: 1.3, text: 1.25 });
    expect(d.documentElement.style.fontSize).toBe('20.80px');
    expect(d.body.style.setProperty).toHaveBeenCalledWith('-webkit-text-size-adjust', '125%');
  });

  it('sin refuerzo se quita el estilo, no se deja uno viejo', () => {
    const d = doc();
    applyDynamicTypeScales(d, { layout: 21 / 17, text: 1 });
    expect(d.body.style.setProperty).not.toHaveBeenCalled();
    expect(d.body.style.removeProperty).toHaveBeenCalledWith('-webkit-text-size-adjust');
  });

  it('con el tamaño por defecto deja mandar al CSS', () => {
    const d = doc();
    applyDynamicTypeScales(d, { layout: 1, text: 1 });
    expect(d.documentElement.style.fontSize).toBe('');
    expect(d.body.style.removeProperty).toHaveBeenCalledWith('-webkit-text-size-adjust');
  });
});
