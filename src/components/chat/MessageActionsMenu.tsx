import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface Props {
  onEdit: () => void;
  onDelete: () => void;
  className?: string;
}

/**
 * Menú de un mensaje PROPIO: editar o eliminar.
 *
 * Es el hermano de ModerationMenu (que acompaña a los mensajes de otros) y
 * copia su forma a propósito —mismo botón, mismo popover, misma confirmación—
 * para que en el chat los dos menús se sientan la misma pieza.
 *
 * Quien lo pinta decide que el mensaje es suyo; la base lo vuelve a comprobar
 * con RLS, así que esconderlo aquí es comodidad, no seguridad.
 */
export function MessageActionsMenu({ onEdit, onDelete, className }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            aria-label={t('chat.actions')}
            className={cn(
              'w-11 h-11 inline-flex items-center justify-center -m-2 rounded-full text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-1">
          <button
            onClick={() => { setOpen(false); onEdit(); }}
            className="w-full flex items-center gap-2 min-h-[44px] px-3 rounded-lg text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            <Pencil className="w-4 h-4" />
            {t('chat.edit')}
          </button>
          <button
            onClick={() => { setOpen(false); setConfirmingDelete(true); }}
            className="w-full flex items-center gap-2 min-h-[44px] px-3 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('chat.delete')}
          </button>
        </PopoverContent>
      </Popover>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('chat.deleteConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('chat.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
