import { describe, it, expect } from 'vitest';
import { badgeProgress, BADGE_TARGETS, type MyParticipation } from '@/lib/badges';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fila = (over: Partial<MyParticipation> = {}): MyParticipation => ({
  status: 'joined', checked_in: false, joined_at: '2026-09-15T18:00:00+00:00', category: 'social', ...over,
});

describe('badgeProgress', () => {
  it('cuenta como el servidor y no pasa de la meta', () => {
    const rows = [
      fila({ category: 'sports', joined_at: '2026-09-01T10:00:00+00:00' }),
      fila({ category: 'sports', joined_at: '2026-09-01T23:00:00+00:00' }),
      fila({ category: 'study', checked_in: true, joined_at: '2026-09-02T10:00:00+00:00' }),
      fila({ category: 'study', checked_in: false, joined_at: '2026-09-03T10:00:00+00:00' }),
      fila({ status: 'pending', category: 'sports', joined_at: '2026-09-04T10:00:00+00:00' }),
    ];
    expect(badgeProgress(7, rows)).toEqual({ organizer: 5, explorer: 4, study_buddy: 1, team_player: 2, streak_7: 3 });
  });

  it('las metas coinciden con check_and_award_badges', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '20260608000000_badge-awards.sql'), 'utf8');
    const metas = [...sql.matchAll(/IF v_count >= (\d+) THEN\s+PERFORM public\.try_award_badge\(_user_id, '(\w+)'\)/g)]
      .map((m) => [m[2], Number(m[1])]);
    expect(Object.fromEntries(metas)).toEqual(BADGE_TARGETS);
  });
});
