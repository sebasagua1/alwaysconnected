import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Campo de contraseña con ojo para verla.
 *
 * Los tres campos de contraseña de la app (entrar, y las dos de cambiarla)
 * eran `type="password"` a secas: en un teclado de móvil, donde teclear es
 * más torpe y el sistema no ofrece nada, la única salida ante un fallo era
 * borrar todo y volver a empezar sin saber qué se había escrito mal.
 *
 * Detalles que importan:
 *
 * - El botón es `tabIndex={-1}`: con el tabulador se pasa del campo al
 *   siguiente, no al ojo. Quien navegue con teclado ya ve lo que escribe.
 * - `aria-pressed` y no solo un icono que cambia, para que un lector de
 *   pantalla diga si la contraseña está a la vista.
 * - El padding derecho del input deja sitio al botón, que si no se monta
 *   encima del texto en contraseñas largas.
 * - Al alternar no se toca el foco ni el valor: el cursor se queda donde
 *   estaba y el gestor de contraseñas sigue viendo el mismo campo.
 */
const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'type'>
>(({ className, ...props }, ref) => {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={cn('pr-12', className)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-pressed={visible}
        aria-label={t(visible ? 'auth.hidePassword' : 'auth.showPassword')}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-0 top-0 h-full w-12 flex items-center justify-center text-muted-foreground active:scale-90 transition-transform"
      >
        <Icon aria-hidden="true" className="w-5 h-5" />
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
