import type { BadgeType } from '@/lib/categoryIcons';

/**
 * Cómo se gana cada insignia y cuánto falta.
 *
 * Las metas copian check_and_award_badges (20260608000000_badge-awards.sql),
 * que es quien las concede de verdad. Si cambian allí, cambian aquí: el
 * perfil diría "te faltan 2" a alguien a quien el servidor ya no se la da.
 */
export const BADGE_TARGETS: Record<BadgeType, number> = {
  organizer: 5, // eventos creados
  explorer: 10, // eventos a los que se unió
  study_buddy: 5, // check-ins en eventos de estudio
  team_player: 5, // eventos de deportes a los que se unió
  streak_7: 7, // días distintos en los que se unió a algo
};

export interface MyParticipation {
  status: string;
  checked_in: boolean;
  joined_at: string;
  /** null si el evento ya no se puede leer (cancelado, otro campus…). */
  category: string | null;
}

/** El avance de cada insignia, sin pasar de la meta. */
export function badgeProgress(createdCount: number, rows: MyParticipation[]): Record<BadgeType, number> {
  const joined = rows.filter((r) => r.status === 'joined');
  // El servidor cuenta días con date_trunc sobre timestamptz en UTC.
  const days = new Set(joined.map((r) => r.joined_at.slice(0, 10)));
  const raw: Record<BadgeType, number> = {
    organizer: createdCount,
    explorer: joined.length,
    study_buddy: rows.filter((r) => r.checked_in && r.category === 'study').length,
    team_player: joined.filter((r) => r.category === 'sports').length,
    streak_7: days.size,
  };
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Math.min(v, BADGE_TARGETS[k as BadgeType])]),
  ) as Record<BadgeType, number>;
}
